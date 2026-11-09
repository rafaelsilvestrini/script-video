const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_VIDEO_BYTES = 350 * 1024 * 1024;
const SQUARE_FILTER = "[0:v]scale=1080:1080[bg];[1:v]scale=w='max(2,trunc(min(BOX,BOX*dar)/2)*2)':h='max(2,trunc(min(BOX,BOX/dar)/2)*2)',setsar=1,pad=BOX:BOX:(ow-iw)/2:(oh-ih)/2:0x121827[vid];[bg][vid]overlay=(W-w)/2:TOP:format=auto[out]";

function inputError(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
}
function bodyObject(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw inputError('corpo deve ser um objeto');
}
function integer(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) throw inputError(`${name} deve ser inteiro entre ${min} e ${max}`);
    return value;
}
function validateBackground(name, imageDir) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/i.test(name)) throw inputError('text1 deve ser nome de imagem em assets/img');
    const filename = path.join(imageDir, name);
    try {
        const root = fs.realpathSync(imageDir);
        const real = fs.realpathSync(filename);
        if (path.dirname(real) !== root || !fs.statSync(real).isFile()) throw new Error('outside');
    } catch {
        throw inputError('imagem de fundo não encontrada em assets/img');
    }
    return filename;
}
function validateProcess(body, imageDir) {
    bodyObject(body);
    const { data, top = 110, text1 = 'back.png', isCut = false, debug = false } = body;
    if (typeof data !== 'string' || data.length === 0 || data.length > 4 * Math.ceil(MAX_VIDEO_BYTES / 3) || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw inputError('data deve conter base64 válido (máximo 350 MiB)');
    const video = Buffer.from(data, 'base64');
    if (video.length > MAX_VIDEO_BYTES || video.toString('base64') !== data) throw inputError('base64 inválido ou muito grande');
    integer(top, 'top', 0, 280);
    if (typeof isCut !== 'boolean' || typeof debug !== 'boolean') throw inputError('isCut e debug devem ser booleanos');
    return { video, top, bgImage: validateBackground(text1, imageDir), isCut, debug };
}
function splitText(text, max) {
    const lines = [];
    let current = '';
    for (const word of text.split(' ')) {
        if ((current + ' ' + word).trim().length <= max) current = (current + ' ' + word).trim();
        else { if (current) lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    return lines;
}
function validateTucano(body) {
    bodyObject(body);
    const { text = '', text1 = '', marginLeft = 20, top = 20, maxCharsPerLine = 31 } = body;
    for (const value of [text, text1]) {
        if (typeof value !== 'string' || value.length > 4000 || value.includes('\0')) throw inputError('text e text1 devem ser strings de até 4000 caracteres, sem NUL');
    }
    integer(marginLeft, 'marginLeft', 0, 1080);
    integer(top, 'top', 0, 1920);
    integer(maxCharsPerLine, 'maxCharsPerLine', 1, 200);
    if ([text, text1].some(value => splitText(value, maxCharsPerLine).length > 120)) throw inputError('texto excede 120 linhas por campo');
    return { text, text1, marginLeft, top, maxCharsPerLine };
}
function runFfmpeg(ffmpegPath, args) {
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new TypeError('argumentos FFmpeg devem ser strings');
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, ['-nostdin', ...args], { maxBuffer: 50 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout, stderr) => {
            if (err) return reject({ err, stdout, stderr });
            resolve({ stdout, stderr });
        });
    });
}
function squareFilter(top, requestedBox = 800) {
    integer(top, 'top', 0, 280);
    integer(requestedBox, 'requestedBox', 800, 940);
    // Keep the full source inside the canvas even with legacy custom top values.
    const box = Math.floor(Math.min(requestedBox, 1080 - top) / 2) * 2;
    return SQUARE_FILTER.replaceAll('BOX', String(box)).replace('TOP', String(top));
}
function overlayArgs(video, background, output, filter) {
    return ['-y', '-threads', '1', '-i', background, '-i', video, '-filter_complex', filter, '-map', '[out]', '-map', '1:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output];
}
function filterPath(filename) {
    return filename.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
}
function ttlMilliseconds(value) {
    const hours = value === undefined ? 24 : Number(value);
    if (!Number.isFinite(hours) || hours < 1 || hours > 8760) throw new Error('OUTPUT_TTL_HOURS deve estar entre 1 e 8760');
    return hours * 60 * 60 * 1000;
}
function outputKey(filename, platform = process.platform) {
    return platform === 'win32' ? filename.toLowerCase() : filename;
}
function cleanupExpired(dir, ttl, active, now = Date.now()) {
    const videos = [];
    const images = [];
    for (const name of fs.readdirSync(dir)) {
        if (!/^(video|tucano)-[a-f0-9]{16}-(out|res|debug)\.(mp4|png)$/.test(name) && !/^(video|tucano)-[a-f0-9]{8}-(out|res)\.mp4$/.test(name)) continue;
        const filename = path.join(dir, name);
        if (active.has(outputKey(filename))) continue;
        try {
            const stat = fs.lstatSync(filename);
            if (!stat.isFile()) continue;
            if (now - stat.mtimeMs >= ttl) {
                fs.unlinkSync(filename);
            } else {
                (name.endsWith('.mp4') ? videos : images).push({ filename, modified: stat.mtimeMs });
            }
        } catch (error) {
            if (error.code !== 'ENOENT') console.error('[cleanup] falha', error.code);
        }
    }
    for (const files of [videos, images]) {
        files.sort((a, b) => b.modified - a.modified || b.filename.localeCompare(a.filename));
        for (const { filename } of files.slice(8)) {
            try { fs.unlinkSync(filename); }
            catch (error) { if (error.code !== 'ENOENT') console.error('[cleanup] falha', error.code); }
        }
    }
}
module.exports = { MAX_VIDEO_BYTES, validateProcess, validateTucano, splitText, runFfmpeg, squareFilter, overlayArgs, filterPath, ttlMilliseconds, outputKey, cleanupExpired };
