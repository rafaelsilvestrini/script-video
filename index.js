const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProcess, validateTucano, splitText, runFfmpeg, squareFilter, overlayArgs, filterPath, ttlMilliseconds, outputKey, cleanupExpired } = require('./video-tools');

const app = express();
const PORT = process.env.PORT || 1524;
const ffmpegPath = process.env.FFMPEG_PATH || require('@ffmpeg-installer/ffmpeg').path;
const outputTTL = ttlMilliseconds(process.env.OUTPUT_TTL_HOURS);
const DIRS = {
    temp: path.join(__dirname, 'temp_videos'),
    output: path.join(__dirname, 'output'),
    img: path.join(__dirname, 'assets', 'img'),
    fonts: path.join(__dirname, 'assets', 'fonts'),
    audio: path.join(__dirname, 'assets', 'audio')
};
Object.values(DIRS).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
const activeOutputs = new Map();
function hold(filename) {
    const key = outputKey(filename);
    activeOutputs.set(key, (activeOutputs.get(key) || 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = activeOutputs.get(key) - 1;
        if (count) activeOutputs.set(key, count);
        else activeOutputs.delete(key);
    };
}
function cleanup() {
    try { cleanupExpired(DIRS.output, outputTTL, activeOutputs); }
    catch (error) { logError('cleanup', error); }
}
function removeFiles(files) {
    for (const filename of files) {
        try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') console.error('[cleanup] falha', error.code); }
    }
}
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use((error, req, res, next) => {
    // Parser errors can contain a copy of the request body and a stack trace.
    // Return fixed messages without logging or forwarding those details.
    const parserErrors = {
        'entity.parse.failed': [400, 'JSON inválido'],
        'entity.too.large': [413, 'corpo JSON excede o limite permitido'],
        'request.aborted': [400, 'requisição interrompida'],
        'request.size.invalid': [400, 'tamanho da requisição inválido'],
        'charset.unsupported': [415, 'charset JSON não suportado'],
        'encoding.unsupported': [415, 'codificação JSON não suportada']
    };
    const result = Object.hasOwn(parserErrors, error?.type) ? parserErrors[error.type] : undefined;
    if (!result) return next(error);
    return res.status(result[0]).json({ error: result[1] });
});
app.use('/output', (req, res, next) => {
    let name;
    try { name = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
    const filename = path.resolve(DIRS.output, '.' + name);
    const release = hold(filename);
    res.once('finish', release);
    res.once('close', release);
    next();
}, express.static(DIRS.output));
const run = args => runFfmpeg(ffmpegPath, args);
function logError(context, error) {
    // Do not log request bodies or text content. FFmpeg can echo filters/files.
    console.error(`[${context}] erro`, error?.err?.code || error?.code || 'processamento');
}
async function getVideoDimensions(inputFile) {
    // FFmpeg exits nonzero when probing without an output; only parse its metadata.
    const result = await run(['-i', inputFile]).catch(error => error);
    const match = (result.stderr || '').match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    if (!match) throw new Error('dimensões do vídeo indisponíveis');
    return { width: Number(match[1]), height: Number(match[2]) };
}
function isReelsByAspect(width, height) {
    const ratio = height / width;
    return ratio >= 1.7 && ratio <= 1.85 && Math.min(width, height) >= 720;
}
function generateUniqueName(base = 'video') { return `${base}-${crypto.randomBytes(8).toString('hex')}`; }
async function smartCrop(inputFile, outputFile, debugFile) {
    const { width, height } = await getVideoDimensions(inputFile);
    const { stderr } = await run(['-i', inputFile, '-vf', 'edgedetect=low=0.1:high=0.4,cropdetect=limit=10:round=2', '-t', '1', '-f', 'null', '-']);
    const match = stderr.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    let dW, dH, dX, dY;
    if (match) {
        [, dW, dH, dX, dY] = match.map(Number);
        if (dY < 50 && dH > height * 0.9) { dY = Math.floor(height * 0.10); dH = Math.floor(height * 0.80); }
        dY = Math.max(0, dY - 15); dH = Math.min(height - dY, dH + 30);
    } else {
        dY = Math.floor(height * 0.20); dH = Math.floor(height * 0.60); dX = 0; dW = width;
    }
    const maxSide = Math.max(dW, dH);
    const filter = `crop=${dW}:${dH}:${dX}:${dY},pad=${maxSide}:${maxSide}:(ow-iw)/2:(oh-ih)/2:white`;
    if (debugFile) await run(['-y', '-i', inputFile, '-ss', '1', '-vf', `drawbox=x=${dX}:y=${dY}:w=${dW}:h=${dH}:color=red:t=5`, '-vframes', '1', debugFile]);
    await run(['-y', '-threads', '1', '-i', inputFile, '-vf', filter, '-c:v', 'libx264', '-crf', '23', '-preset', 'ultrafast', '-c:a', 'copy', outputFile]);
}
function respondVideo(req, res, filename) {
    const base64 = fs.readFileSync(filename).toString('base64');
    cleanup();
    return res.json({ url: `${req.protocol}://${req.get('host')}/output/${path.basename(filename)}`, base64 });
}
app.post('/process-video', async (req, res) => {
    let input;
    try { input = validateProcess(req.body, DIRS.img); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const name = generateUniqueName();
    const inputFile = path.join(DIRS.temp, `${name}-in.mp4`);
    const croppedFile = path.join(DIRS.temp, `${name}-cr.mp4`);
    const finalFile = path.join(DIRS.output, `${name}-out.mp4`);
    const debugFile = path.join(DIRS.output, `${name}-debug.png`);
    const release = hold(finalFile);
    const releaseDebug = hold(debugFile);
    try {
        fs.writeFileSync(inputFile, input.video);
        const { width, height } = await getVideoDimensions(inputFile);
        if (isReelsByAspect(width, height)) {
            const filter = '[0:v]scale=1080:1920[bg];[1:v]scale=938:1800:force_original_aspect_ratio=decrease[vid];[bg][vid]overlay=(W-w)/2:(H-h)/2:format=auto[out]';
            await run(overlayArgs(inputFile, path.join(DIRS.img, 'background-story.png'), finalFile, filter));
        } else {
            let videoSource = inputFile;
            if (input.isCut) {
                await smartCrop(inputFile, croppedFile, input.debug ? debugFile : undefined);
                videoSource = croppedFile;
            }
            await run(overlayArgs(videoSource, input.bgImage, finalFile, squareFilter(input.top)));
        }
        return respondVideo(req, res, finalFile);
    } catch (error) {
        logError('process-video', error);
        removeFiles([finalFile, debugFile]);
        return res.status(500).send('Erro');
    } finally {
        removeFiles([inputFile, croppedFile]);
        release(); releaseDebug();
    }
});
app.post('/tucano', async (req, res) => {
    let input;
    try { input = validateTucano(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const { text, text1, marginLeft, top, maxCharsPerLine } = input;
    const name = generateUniqueName('tucano');
    const tmpFrames = path.join(DIRS.temp, `${name}-f.mp4`);
    const tmpWithText = path.join(DIRS.temp, `${name}-t.mp4`);
    const finalFile = path.join(DIRS.output, `${name}-res.mp4`);
    const textFiles = [];
    const release = hold(finalFile);
    try {
        await run(['-y', '-threads', '1', '-loop', '1', '-i', path.join(DIRS.img, 'backgroundtucano.png'), '-t', '15', '-r', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tmpFrames]);
        const texts = [];
        if (text.trim()) texts.push({ text, top, fontSize: 60 });
        if (text1.trim()) texts.push({ text: text1, top: top + 150, fontSize: 28 });
        const filters = [];
        for (const item of texts) {
            let y = item.top;
            for (const line of splitText(item.text, maxCharsPerLine)) {
                const filename = path.join(DIRS.temp, `${name}-${textFiles.length}.txt`);
                textFiles.push(filename);
                fs.writeFileSync(filename, line, 'utf8');
                filters.push(`drawtext=fontfile='${filterPath(path.join(DIRS.fonts, 'HelveticaNeueMedium.otf'))}':textfile='${filterPath(filename)}':expansion=none:x=${marginLeft}:y=${y}:fontsize=${item.fontSize}:fontcolor=white`);
                y += item.fontSize + 10;
            }
        }
        if (filters.length) {
            const filterFile = path.join(DIRS.temp, `${name}-filters.txt`);
            textFiles.push(filterFile);
            fs.writeFileSync(filterFile, filters.join(','), 'utf8');
            await run(['-y', '-threads', '1', '-i', tmpFrames, '-filter_script:v', filterFile, '-c:v', 'libx264', '-crf', '23', '-preset', 'ultrafast', tmpWithText]);
        } else fs.copyFileSync(tmpFrames, tmpWithText);
        await run(['-y', '-threads', '1', '-i', tmpWithText, '-i', path.join(DIRS.audio, 'tucano.mp3'), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-t', '15', finalFile]);
        return respondVideo(req, res, finalFile);
    } catch (error) {
        logError('tucano', error);
        removeFiles([finalFile]);
        return res.status(500).send('Erro');
    } finally {
        removeFiles([tmpFrames, tmpWithText, ...textFiles]);
        release();
    }
});
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
