const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const repo = path.join(__dirname, '..');
const { runFfmpeg, overlayArgs, squareFilter, filterPath } = require(path.join(repo, 'video-tools'));
const executable = process.env.FFMPEG_PATH;
assert.ok(executable, 'set trusted FFMPEG_PATH');
assert.ok(process.argv[2] && process.argv[3], 'Usage: node scripts/preview-video-backgrounds.js <background-directory> <preview-directory>');
const backgrounds = path.resolve(process.argv[2]);
const outputs = path.resolve(process.argv[3]);
fs.mkdirSync(outputs, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-brand-'));
const report = [];

async function main() {
    const font = filterPath(path.join(repo, 'assets/fonts/HelveticaNeueMedium.otf'));
    for (const spec of [
        { name: 'quadrado-16x9', w: 640, h: 360, contentW: 800, contentH: 450, x: 140, y: 285, canvasH: 1080 },
        { name: 'quadrado-1x1', w: 640, h: 640, contentW: 800, contentH: 800, x: 140, y: 110, canvasH: 1080 },
        { name: 'story-9x16', w: 720, h: 1280, contentW: 938, contentH: 1668, x: 71, y: 126, canvasH: 1920 }
    ]) {
        const input = path.join(temp, spec.name + '.mp4');
        const output = path.join(outputs, 'video-preview-' + spec.name + '.mp4');
        const filters = [
            'drawbox=x=0:y=0:w=200:h=80:color=0xFF0000:t=fill',
            'drawbox=x=iw-200:y=0:w=200:h=80:color=0x00FF00:t=fill',
            'drawbox=x=0:y=ih-80:w=200:h=80:color=0x0000FF:t=fill',
            'drawbox=x=iw-200:y=ih-80:w=200:h=80:color=0xFFFF00:t=fill',
            ...[
                ['CREDITO TL', '10', '10'], ['CREDITO TR', 'w-tw-10', '10'],
                ['CREDITO BL', '10', 'h-th-40'], ['CREDITO BR', 'w-tw-10', 'h-th-40']
            ].map(([text, x, y]) => `drawtext=fontfile='${font}':text='${text}':x=${x}:y=${y}:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6`)
        ];
        await runFfmpeg(executable, ['-y', '-f', 'lavfi', '-i', `color=0x667080:s=${spec.w}x${spec.h}:r=24:d=1`, '-vf', filters.join(','), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
        const reels = spec.canvasH === 1920;
        const filter = reels ? '[0:v]scale=1080:1920[bg];[1:v]scale=938:1800:force_original_aspect_ratio=decrease[vid];[bg][vid]overlay=(W-w)/2:(H-h)/2:format=auto[out]' : squareFilter(110);
        await runFfmpeg(executable, overlayArgs(input, path.join(backgrounds, reels ? 'background-story.png' : 'back.png'), output, filter));
        const { stdout: frame } = await execFileAsync(executable, ['-nostdin', '-v', 'error', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, windowsHide: true });
        assert.equal(frame.length, 1080 * spec.canvasH * 3);
        const marks = [
            [180, 60, [255, 0, 0]], [spec.w - 20, 60, [0, 255, 0]],
            [180, spec.h - 20, [0, 0, 255]], [spec.w - 20, spec.h - 20, [255, 255, 0]]
        ];
        for (const [sourceX, sourceY, expected] of marks) {
            const x = Math.round(spec.x + sourceX * spec.contentW / spec.w);
            const y = Math.round(spec.y + sourceY * spec.contentH / spec.h);
            const offset = (y * 1080 + x) * 3;
            for (let c = 0; c < 3; c++) assert.ok(Math.abs(frame[offset + c] - expected[c]) < 35, `${spec.name} corner marker at ${x},${y}`);
        }
        for (const [suffix, vf] of [['', []], ['-360', ['-vf', 'scale=360:-2']]]) {
            await runFfmpeg(executable, ['-y', '-i', output, ...vf, '-frames:v', '1', path.join(outputs, 'video-preview-' + spec.name + suffix + '.png')]);
        }
        report.push({ name: spec.name, canvas: [1080, spec.canvasH], content: [spec.x, spec.y, spec.contentW, spec.contentH], cornerMarkers: '4/4 preserved', mobileWidth: 360 });
    }
    console.log(JSON.stringify(report));
    fs.writeFileSync(path.join(outputs, 'video-templates-render-checks.json'), JSON.stringify(report, null, 2) + '\n');
}
main().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
