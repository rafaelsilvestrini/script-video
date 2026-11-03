const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runFfmpeg, squareFilter, overlayArgs, filterPath } = require('../video-tools');
const execFileAsync = promisify(execFile);
const executable = process.env.FFMPEG_PATH;

// Explicit opt-in: never load or execute the repository's tracked node_modules.
test('real FFmpeg: landscape, portrait and anamorphic sources preserve visible proportions', { skip: !executable && 'set FFMPEG_PATH to a trusted local FFmpeg' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-render-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const background = path.join(root, 'background.bmp');
    await runFfmpeg(executable, ['-y', '-f', 'lavfi', '-i', 'color=black:s=1080x1080', '-frames:v', '1', background]);
    for (const [name, size, sar, expectedW, expectedH] of [
        ['landscape', '640x360', '1', 800, 450],
        ['portrait', '360x640', '1', 450, 800],
        ['anamorphic', '320x360', '2', 800, 450]
    ]) {
        const input = path.join(root, name + '.mp4');
        const output = path.join(root, name + '-out.mp4');
        await runFfmpeg(executable, ['-y', '-f', 'lavfi', '-i', `color=red:s=${size}:r=2:d=1`, '-vf', `setsar=${sar}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
        await runFfmpeg(executable, overlayArgs(input, background, output, squareFilter(110)));
        const metadata = await runFfmpeg(executable, ['-i', output]).catch(error => error);
        assert.match(metadata.stderr, /Video: h264[^\r\n]*\byuv420p\b/, name + ' encoded pixel format');
        const { stdout: frame } = await execFileAsync(executable, ['-nostdin', '-v', 'error', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
        assert.equal(frame.length, 1080 * 1080 * 3, name + ' canvas');
        let minX = 1080, minY = 1080, maxX = -1, maxY = -1;
        for (let y = 0; y < 1080; y++) for (let x = 0; x < 1080; x++) {
            const i = (y * 1080 + x) * 3;
            if (frame[i] > 180 && frame[i + 1] < 80 && frame[i + 2] < 80) {
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
        }
        assert.ok(Math.abs(maxX - minX + 1 - expectedW) <= 4, `${name} content width ${maxX - minX + 1}`);
        assert.ok(Math.abs(maxY - minY + 1 - expectedH) <= 4, `${name} content height ${maxY - minY + 1}`);
        assert.ok(Math.abs((minX + maxX) / 2 - 539.5) <= 2, name + ' horizontal center');
        assert.ok(minY >= 110 && maxY < 910, name + ' original 800px box/top');
    }
});
test('real FFmpeg: Tucano renders punctuation and disables expression expansion (pixel comparison)', { skip: !executable && 'set FFMPEG_PATH to a trusted local FFmpeg' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-drawtext-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const text = path.join(root, 'text.txt');
    const script = path.join(root, 'filters.txt');
    const output = path.join(root, 'frame.png');
    const font = path.resolve(__dirname, '../assets/fonts/HelveticaNeueMedium.otf');
    fs.writeFileSync(text, `quote ' : , [] \\ %{eif:1+1:d} & $(payload)`);
    fs.writeFileSync(script, `drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(text)}':expansion=none:x=20:y=20:fontsize=28:fontcolor=white`);
    await runFfmpeg(executable, ['-y', '-f', 'lavfi', '-i', 'color=black:s=640x360:d=1', '-filter_script:v', script, '-frames:v', '1', output]);
    assert.ok(fs.statSync(output).size > 0);
    async function renderPixels(content, expansion) {
        fs.writeFileSync(text, content);
        fs.writeFileSync(script, `drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(text)}':expansion=${expansion}:x=20:y=20:fontsize=28:fontcolor=white`);
        const { stdout } = await execFileAsync(executable, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:d=1', '-filter_script:v', script, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
        assert.equal(stdout.length, 640 * 360 * 3);
        return stdout;
    }
    // Positive control proves the expression really expands to 2 in this FFmpeg.
    // Disabling expansion must produce different pixels from that expanded result.
    const expression = '%{eif:1+1:d}';
    const expanded = await renderPixels(expression, 'normal');
    const reference = await renderPixels('2', 'normal');
    assert.deepEqual(expanded, reference, 'positive control renders expression as 2');
    const literal = await renderPixels(expression, 'none');
    assert.notDeepEqual(literal, reference, 'production setting must not render expanded 2');
});

test('real FFmpeg: final square/Reels MP4 uses 4:2:0, optional AAC and front-loaded moov', { skip: !executable && 'set FFMPEG_PATH to a trusted local FFmpeg' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-compat-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const background = path.join(root, 'background.bmp');
    await runFfmpeg(executable, ['-y', '-f', 'lavfi', '-i', 'color=black:s=1080x1920', '-frames:v', '1', background]);
    for (const withAudio of [false, true]) {
        const input = path.join(root, `input-${withAudio}.mp4`);
        const inputArgs = ['-y', '-f', 'lavfi', '-i', 'color=red:s=360x640:r=24:d=1'];
        if (withAudio) inputArgs.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'aac');
        inputArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv444p', input);
        await runFfmpeg(executable, inputArgs);
        for (const reels of [false, true]) {
            const output = path.join(root, `output-${withAudio}-${reels}.mp4`);
            const filter = reels ? '[0:v]scale=1080:1920[bg];[1:v]scale=938:1800:force_original_aspect_ratio=decrease[vid];[bg][vid]overlay=(W-w)/2:(H-h)/2:format=auto[out]' : squareFilter(110);
            await runFfmpeg(executable, overlayArgs(input, background, output, filter));
            const { stderr } = await runFfmpeg(executable, ['-i', output]).catch(error => error);
            assert.match(stderr, /Video: h264[^\r\n]*\byuv420p\b/);
            assert.match(stderr, reels ? /1080x1920/ : /1080x1080/);
            if (withAudio) assert.match(stderr, /Audio: aac[^\r\n]*48000 Hz/);
            else assert.doesNotMatch(stderr, /Audio:/);
            const data = fs.readFileSync(output);
            const atoms = [];
            for (let offset = 0; offset + 8 <= data.length;) {
                const size = data.readUInt32BE(offset);
                assert.ok(size >= 8 && offset + size <= data.length, 'valid top-level MP4 atom');
                atoms.push(data.toString('ascii', offset + 4, offset + 8));
                offset += size;
            }
            assert.ok(atoms.indexOf('moov') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'), 'faststart puts moov before media');
        }
    }
});
