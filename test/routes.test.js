const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const realTools = require('../video-tools');

function harness(t, { failRender = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-routes-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'assets', 'img'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'img', 'back.png'), 'fixture');
    const handlers = new Map();
    const calls = [];
    const filterScripts = [];
    const textSnapshots = [];
    let outputMiddleware;
    const app = {
        use(...args) { if (args[0] === '/output') outputMiddleware = args[1]; },
        post(route, handler) { handlers.set(route, handler); },
        listen() {}
    };
    const express = () => app;
    express.json = () => () => {};
    express.static = () => () => {};
    const ffmpeg = async args => {
        calls.push(Array.from(args));
        if (args.includes('-filter_script:v')) {
            filterScripts.push(fs.readFileSync(args[args.indexOf('-filter_script:v') + 1], 'utf8'));
            for (const filename of fs.readdirSync(path.join(root, 'temp_videos')).filter(name => /-\d+\.txt$/.test(name))) {
                textSnapshots.push(fs.readFileSync(path.join(root, 'temp_videos', filename), 'utf8'));
            }
        }
        if (args.length === 2 && args[0] === '-i') return { stderr: 'Video: h264, yuv420p, 640x360, 24 fps' };
        if (args.includes('null')) return { stderr: 'crop=640:300:0:30' };
        const output = args.at(-1);
        fs.writeFileSync(output, 'synthetic-result');
        if (failRender) throw new Error('synthetic failure');
        return { stderr: '' };
    };
    const localTools = { ...realTools, runFfmpeg: async (executable, args) => ffmpeg(args) };
    const sandbox = {
        __dirname: root,
        process: { env: { FFMPEG_PATH: 'synthetic-ffmpeg', OUTPUT_TTL_HOURS: '1' } },
        console: { log() {}, error() {} },
        require: name => name === 'express' ? express : name === 'cors' ? () => () => {} : name === './video-tools' ? localTools : require(name)
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), sandbox);
    async function request(route, body) {
        const response = {
            statusCode: 200,
            status(value) { this.statusCode = value; return this; },
            json(value) { this.body = value; return this; },
            send(value) { this.body = value; return this; }
        };
        await handlers.get(route)({ body, protocol: 'http', get: () => 'localhost:1524' }, response);
        return response;
    }
    return { root, calls, request, middleware: outputMiddleware, filterScripts, textSnapshots };
}
const body = () => ({ data: Buffer.from('synthetic input').toString('base64') });

test('process route keeps success response/url/base64 and cleans per-request temporary files', async t => {
    const h = harness(t);
    const response = await h.request('/process-video', body());
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ['base64', 'url']);
    assert.match(response.body.url, /^http:\/\/localhost:1524\/output\/video-[a-f0-9]{16}-out\.mp4$/);
    assert.equal(Buffer.from(response.body.base64, 'base64').toString(), 'synthetic-result');
    assert.equal(fs.readdirSync(path.join(h.root, 'temp_videos')).length, 0);
    assert.equal(fs.readdirSync(path.join(h.root, 'output')).length, 1);
    assert.ok(h.calls.some(args => args.some(arg => arg.includes('pad=800:800'))));
});
test('invalid requests fail before FFmpeg and processing failure removes partial output', async t => {
    const h = harness(t, { failRender: true });
    assert.equal((await h.request('/process-video', { ...body(), top: '110;payload' })).statusCode, 400);
    assert.equal(h.calls.length, 0);
    const response = await h.request('/process-video', body());
    assert.equal(response.statusCode, 500);
    assert.equal(response.body, 'Erro');
    assert.equal(fs.readdirSync(path.join(h.root, 'output')).length, 0);
    assert.equal(fs.readdirSync(path.join(h.root, 'temp_videos')).length, 0);
});
test('debug outputs are unique and crop output is used', async t => {
    const h = harness(t);
    for (let i = 0; i < 2; i++) assert.equal((await h.request('/process-video', { ...body(), isCut: true, debug: true })).statusCode, 200);
    const outputs = fs.readdirSync(path.join(h.root, 'output'));
    assert.equal(outputs.filter(name => name.endsWith('-debug.png')).length, 2);
    assert.equal(new Set(outputs).size, 4);
    assert.equal(h.calls.filter(args => args.includes('-filter_complex') && args.some(arg => arg.endsWith('-cr.mp4'))).length, 2);
    assert.equal(fs.readdirSync(path.join(h.root, 'temp_videos')).length, 0);
});
test('Tucano keeps response, reads literal text from files and cleans intermediates', async t => {
    const h = harness(t);
    const hostile = `quote ' colon : comma , expression %{eif:1+1:d} & $(payload)`;
    const response = await h.request('/tucano', { text: hostile, text1: 'segunda linha' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body.url, /tucano-[a-f0-9]{16}-res\.mp4$/);
    const filter = h.filterScripts[0];
    assert.match(filter, /textfile=/);
    assert.match(filter, /expansion=none/);
    assert.equal(filter.includes('%{eif'), false);
    assert.equal(filter.includes('$(payload)'), false);
    assert.equal(h.textSnapshots.join(' '), hostile + ' segunda linha');
    assert.equal(fs.readdirSync(path.join(h.root, 'temp_videos')).length, 0);
});
test('download activity prevents expiration cleanup until response finishes', async t => {
    const h = harness(t);
    const name = 'video-aaaaaaaaaaaaaaaa-out.mp4';
    const filename = path.join(h.root, 'output', name);
    fs.writeFileSync(filename, 'fixture');
    fs.utimesSync(filename, new Date(0), new Date(0));
    const response = new EventEmitter();
    h.middleware({ path: '/' + name }, response, () => {});
    await h.request('/process-video', body());
    assert.equal(fs.existsSync(filename), true);
    response.emit('finish'); response.emit('close');
    await h.request('/process-video', body());
    assert.equal(fs.existsSync(filename), false);
});
