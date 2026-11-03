const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createImageCache, createImageDownloadHandler } = require('./image-cache');

const MAX_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF = new Set([192, 193, 194]);
const DECODERS = { png: 'png', jpeg: 'mjpeg', webp: 'webp' };

function bad(message) {
    return Object.assign(new Error(message), { status: 400 });
}

function pngDimensions(buffer) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    for (let offset = 8; offset + 12 <= buffer.length;) {
        const length = buffer.readUInt32BE(offset);
        if (length > buffer.length - offset - 12) throw bad('PNG truncado');
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (type === 'IHDR' && offset !== 8) throw bad('PNG com cabeçalho duplicado');
        if (type === 'acTL') {
            throw bad('imagem animada não suportada');
        }
        offset += length + 12;
    }
    return { width, height, format: 'png' };
}

function webpDimensions(buffer) {
    if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw bad('WebP truncado');
    let width, height;
    function setSize(nextWidth, nextHeight) {
        if (width && (width !== nextWidth || height !== nextHeight)) {
            throw bad('dimensões WebP inconsistentes');
        }
        width = nextWidth;
        height = nextHeight;
    }
    for (let offset = 12; offset + 8 <= buffer.length;) {
        const length = buffer.readUInt32LE(offset + 4);
        const type = buffer.toString('ascii', offset, offset + 4);
        const data = offset + 8;
        if (length > buffer.length - data) throw bad('WebP truncado');
        if (type === 'ANIM' || type === 'ANMF') throw bad('imagem animada não suportada');
        if (type === 'VP8X' && length >= 10) {
            if (buffer[data] & 2) throw bad('imagem animada não suportada');
            setSize(buffer.readUIntLE(data + 4, 3) + 1, buffer.readUIntLE(data + 7, 3) + 1);
        } else if (type === 'VP8 ' && length >= 10 &&
            buffer[data + 3] === 157 && buffer[data + 4] === 1 && buffer[data + 5] === 42) {
            setSize(buffer.readUInt16LE(data + 6) & 16383, buffer.readUInt16LE(data + 8) & 16383);
        } else if (type === 'VP8L' && length >= 5 && buffer[data] === 47) {
            const bits = buffer.readUInt32LE(data + 1);
            setSize((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
        }
        offset = data + length + (length % 2);
    }
    return { width, height, format: 'webp' };
}

function jpegDimensions(buffer) {
    let offset = 2;
    let frame;
    let entropy = false;
    let sawScan = false;
    while (offset < buffer.length) {
        if (entropy) {
            offset = buffer.indexOf(255, offset);
            if (offset < 0) throw bad('JPEG truncado');
        }
        if (buffer[offset++] !== 255) throw bad('JPEG inválido');
        while (buffer[offset] === 255) offset++;
        if (offset >= buffer.length) throw bad('JPEG truncado');
        const marker = buffer[offset++];
        // Stuffed FF bytes and restart markers belong to entropy, not headers.
        if (entropy && (marker === 0 || (marker >= 208 && marker <= 215))) continue;
        entropy = false;
        if (marker === 217) {
            if (!frame || !sawScan) throw bad('JPEG sem quadro completo');
            if (buffer.subarray(offset).some(byte => byte !== 0 && byte !== 255)) {
                throw bad('JPEG contém dados após o fim da imagem');
            }
            return frame;
        }
        if (marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) {
            throw bad('marcador JPEG fora de posição');
        }
        if (marker === 1) continue;
        // DNL can redefine dimensions after SOF; hierarchical JPEG is unsupported.
        if ([220, 222, 223].includes(marker)) throw bad('extensão JPEG não suportada');
        if (offset + 2 > buffer.length) throw bad('JPEG truncado');
        const length = buffer.readUInt16BE(offset);
        if (length < 2 || offset + length > buffer.length) throw bad('JPEG truncado');
        if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker) && !JPEG_SOF.has(marker)) {
            throw bad('tipo de JPEG não suportado');
        }
        if (JPEG_SOF.has(marker)) {
            if (frame) throw bad('JPEG com cabeçalho de quadro duplicado');
            if (length < 8) throw bad('JPEG inválido');
            frame = {
                width: buffer.readUInt16BE(offset + 5),
                height: buffer.readUInt16BE(offset + 3),
                format: 'jpeg'
            };
        }
        offset += length;
        if (marker === 218) {
            if (!frame) throw bad('JPEG scan sem cabeçalho de quadro');
            sawScan = true;
            entropy = true;
        }
    }
    throw bad('JPEG truncado ou sem fim de imagem');
}

function dimensions(buffer) {
    let size;
    if (buffer.length >= 33 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
        buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.readUInt32BE(8) === 13) {
        size = pngDimensions(buffer);
    } else if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP') {
        size = webpDimensions(buffer);
    } else if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216) {
        size = jpegDimensions(buffer);
    }
    if (!size?.width || !size.height || size.width > 4096 || size.height > 4096 ||
        size.width * size.height > 16000000) {
        throw bad('use JPG, PNG ou WebP estático com até 4096 px por lado e 16 megapixels');
    }
    return size;
}

function validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('corpo deve ser objeto');
    if (Object.keys(body).some(key => !['data', 'returnUrl'].includes(key))) throw bad('envie somente data e returnUrl; não há geração de título');
    const { data, returnUrl = false } = body;
    if (typeof returnUrl !== 'boolean') throw bad('returnUrl deve ser booleano');
    if (typeof data !== 'string' || !data.length || data.length > 4 * Math.ceil(MAX_BYTES / 3) ||
        data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw bad('data deve ser base64 puro de até 10 MiB');
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > MAX_BYTES || buffer.toString('base64') !== data) throw bad('base64 inválido');
    return { buffer, returnUrl, ...dimensions(buffer) };
}

function imageFilter() {
    return [
        '[0:v]scale=1080:1080[bg]',
        "[1:v]scale=w='max(2,trunc(min(940,940*dar)/2)*2)':h='max(2,trunc(min(940,940/dar)/2)*2)'," +
            'setsar=1,format=rgba,pad=940:940:(ow-iw)/2:(oh-ih)/2:0x121827[photo]',
        '[bg][photo]overlay=(W-w)/2:110:format=auto[combined]',
        '[combined]drawbox=x=26:y=154:w=16:h=16:color=0xD5FF55:t=2,' +
            'drawbox=x=1038:y=1010:w=16:h=16:color=0xD5FF55:t=2[out]'
    ].join(';');
}

function createRunner(ffmpegPath) {
    return args => new Promise((resolve, reject) => {
        execFile(ffmpegPath, ['-nostdin', ...args], {
            timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false
        }, error => error ? reject(error) : resolve());
    });
}

function createImageHandler({ ffmpegPath, tempDir, imageDir, execute, cache }) {
    const run = execute || createRunner(ffmpegPath);
    let active = 0;
    return async (req, res) => {
        let folder;
        let acquired = false;
        try {
            if (active >= 2) return res.status(429).json({ error: 'processamento ocupado; tente novamente' });
            const input = validate(req.body);
            if (input.returnUrl && !cache?.configured) {
                return res.status(503).json({ error: 'URL pública de imagens não configurada' });
            }
            active++;
            acquired = true;
            fs.mkdirSync(tempDir, { recursive: true });
            folder = fs.mkdtempSync(path.join(tempDir, 'image-'));
            const source = path.join(folder, 'source.' + input.format);
            const output = path.join(folder, 'result.jpg');
            const script = path.join(folder, 'filter.txt');
            fs.writeFileSync(source, input.buffer);
            fs.writeFileSync(script, imageFilter());
            await run([
                '-y', '-max_alloc', '134217728',
                '-protocol_whitelist', 'file,pipe', '-threads', '1',
                '-i', path.join(imageDir, 'back.png'),
                '-protocol_whitelist', 'file,pipe', '-f', 'image2',
                '-c:v', DECODERS[input.format], '-max_pixels', '16000000', '-threads', '1', '-i', source,
                '-filter_complex_threads', '1', '-filter_complex_script', script,
                '-map', '[out]', '-frames:v', '1', '-c:v', 'mjpeg',
                '-threads', '1', '-q:v', '2', output
            ]);
            const jpeg = fs.readFileSync(output);
            if (input.returnUrl) return res.json(cache.store(jpeg));
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'no-store');
            return res.send(jpeg);
        } catch (error) {
            return res.status(error.status || 422).json({
                error: error.status ? error.message : 'não foi possível processar a imagem'
            });
        } finally {
            try {
                if (folder) fs.rmSync(folder, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
            } finally {
                if (acquired) active--;
            }
        }
    };
}

module.exports = { createImageHandler, validate, dimensions, MAX_BYTES, createImageCache, createImageDownloadHandler };
