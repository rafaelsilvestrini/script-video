const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const tools = require('../video-tools');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-tools-'));
const imageDir = path.join(temp, 'img');
fs.mkdirSync(imageDir);
fs.writeFileSync(path.join(imageDir, 'back.png'), 'fixture');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const valid = () => ({ data: Buffer.from('synthetic video').toString('base64') });

test('process defaults and validated buffer preserve contract', () => {
    const result = tools.validateProcess(valid(), imageDir);
    assert.equal(result.video.toString(), 'synthetic video');
    assert.equal(result.top, 110);
    assert.equal(result.isCut, false);
    assert.equal(result.debug, false);
    assert.equal(result.bgImage, path.join(imageDir, 'back.png'));
});
test('rejects malformed bodies, base64, boolean coercion and expression injection', () => {
    const invalid = [null, [], {}, { data: 123 }, { data: '%%%%' }, { data: 'Zh==' }, { data: 'Zg=' }, { data: 'data:video/mp4;base64,Zg==' }, { ...valid(), top: '110' }, { ...valid(), top: '0:enable=1' }, { ...valid(), top: -1 }, { ...valid(), top: 281 }, { ...valid(), top: 2.5 }, { ...valid(), isCut: 'false' }, { ...valid(), debug: 1 }];
    for (const body of invalid) assert.throws(() => tools.validateProcess(body, imageDir), { status: 400 });
    for (const top of [0, 280]) assert.equal(tools.validateProcess({ ...valid(), top }, imageDir).top, top);
});
test('backgrounds reject traversal, shell/filter characters, missing and non-file paths', () => {
    fs.mkdirSync(path.join(imageDir, 'directory.png'));
    for (const text1 of ['../back.png', '..\\back.png', '/back.png', 'C:\\back.png', 'x.png" & echo injected', 'back.png:foo', 'missing.png', 'directory.png', 4, null]) {
        assert.throws(() => tools.validateProcess({ ...valid(), text1 }, imageDir), { status: 400 });
    }
});
test('realpath confinement rejects symlink to external image', t => {
    const outside = path.join(temp, 'external.png');
    const link = path.join(imageDir, 'link.png');
    fs.writeFileSync(outside, 'fixture');
    try { fs.symlinkSync(outside, link); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('host does not permit file symlinks'); throw error; }
    assert.throws(() => tools.validateProcess({ ...valid(), text1: 'link.png' }, imageDir), { status: 400 });
});
test('tucano allows literal hostile text but rejects type/bound/filter injection in numeric fields', () => {
    const text = `literal '%{eif:1+1:d}' & $(echo x) : , [] \\ newline\n`;
    assert.equal(tools.validateTucano({ text }).text, text);
    for (const input of [{ text: {} }, { text1: 1 }, { text: 'a'.repeat(4001) }, { text: 'a\0b' }, { top: '20' }, { marginLeft: -1 }, { maxCharsPerLine: 0 }, { maxCharsPerLine: Infinity }, { text: 'a '.repeat(121), maxCharsPerLine: 1 }]) assert.throws(() => tools.validateTucano(input), { status: 400 });
    assert.deepEqual(tools.splitText('um dois tres', 7), ['um dois', 'tres']);
});
test('square filter fits source DAR into unchanged white 800 box and bounds top', () => {
    const filter = tools.squareFilter(110);
    assert.match(filter, /800\*dar/);
    assert.match(filter, /800\/dar/);
    assert.match(filter, /setsar=1,pad=800:800:\(ow-iw\)\/2:\(oh-ih\)\/2:white/);
    assert.match(filter, /overlay=\(W-w\)\/2:110:format=auto/);
    assert.throws(() => tools.squareFilter('110'), { status: 400 });
    const args = tools.overlayArgs('video & x.mp4', 'background.png', 'output.mp4', filter);
    assert.equal(args[args.indexOf('-i') + 1], 'background.png');
    assert.ok(args.includes('video & x.mp4'));
    assert.ok(args.includes('1:a?'));
});
test('execFile receives a literal argument vector and shell false; failures propagate', async () => {
    const captured = [];
    const sandbox = {
        module: { exports: {} },
        require: name => name === 'node:child_process' ? { execFile: (...args) => { captured.push(args); args[3](null, 'stdout', 'stderr'); } } : require(name),
        console, Buffer
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../video-tools.js'), 'utf8'), sandbox);
    const args = ['-i', 'literal " & $(payload).mp4'];
    const result = await sandbox.module.exports.runFfmpeg('ffmpeg path.exe', args);
    assert.equal(result.stdout, 'stdout');
    assert.equal(captured[0][0], 'ffmpeg path.exe');
    assert.deepEqual(Array.from(captured[0][1]), ['-nostdin', ...args]);
    assert.equal(captured[0][2].shell, false);
    assert.equal(captured[0][2].windowsHide, true);
    assert.throws(() => sandbox.module.exports.runFfmpeg('ffmpeg', [1]), /strings/);
    const failureSandbox = { module: { exports: {} }, console, Buffer, require: name => name === 'node:child_process' ? { execFile: (...args) => args[3](new Error('failed'), '', 'diagnostic') } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../video-tools.js'), 'utf8'), failureSandbox);
    await assert.rejects(failureSandbox.module.exports.runFfmpeg('ffmpeg', []), error => error.stderr === 'diagnostic');
});
test('TTL has 24h default, one-hour minimum, bounded finite values', () => {
    assert.equal(tools.ttlMilliseconds(), 86400000);
    assert.equal(tools.ttlMilliseconds('1'), 3600000);
    for (const value of ['0', '-1', 'Infinity', 'abc', '8761', '']) assert.throws(() => tools.ttlMilliseconds(value));
});
test('Windows output activity uses case-insensitive keys', () => {
    assert.equal(tools.outputKey('C:\\Output\\VIDEO.mp4', 'win32'), tools.outputKey('c:\\output\\video.mp4', 'win32'));
    assert.notEqual(tools.outputKey('/output/VIDEO.mp4', 'linux'), tools.outputKey('/output/video.mp4', 'linux'));
});
test('cleanup preserves >8 fresh outputs, active old files, foreign files and directories', () => {
    const dir = path.join(temp, 'outputs'); fs.mkdirSync(dir);
    const now = Date.now();
    const ttl = 3600000;
    const names = Array.from({ length: 12 }, (_, i) => `video-${i.toString(16).padStart(16, '0')}-out.mp4`);
    for (const name of names) fs.writeFileSync(path.join(dir, name), 'fixture');
    const active = path.join(dir, 'video-aaaaaaaaaaaaaaaa-out.mp4');
    const expired = path.join(dir, 'video-bbbbbbbbbbbbbbbb-out.mp4');
    const legacy = path.join(dir, 'video-cccccccc-out.mp4');
    const debug = path.join(dir, 'video-dddddddddddddddd-debug.png');
    const foreign = path.join(dir, 'keep-me.mp4');
    for (const name of [active, expired, legacy, debug, foreign]) { fs.writeFileSync(name, 'fixture'); fs.utimesSync(name, new Date(now - ttl * 2), new Date(now - ttl * 2)); }
    const directory = path.join(dir, 'video-eeeeeeeeeeeeeeee-out.mp4'); fs.mkdirSync(directory);
    tools.cleanupExpired(dir, ttl, new Map([[tools.outputKey(active), 1]]), now);
    for (const name of [...names.map(n => path.join(dir, n)), active, foreign, directory]) assert.equal(fs.existsSync(name), true, name);
    for (const name of [expired, legacy, debug]) assert.equal(fs.existsSync(name), false, name);
});
