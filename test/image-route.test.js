const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createImageHandler, validate, dimensions } = require('../image-route');
const { createImageCache } = require('../image-cache');
const { runFfmpeg } = require('../video-tools');

function png(width = 1, height = 1) {
    const buffer = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12);
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}
function response() {
    return {
        statusCode: 200, headers: {},
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
        set(key, value) { this.headers[key] = value; return this; },
        send(value) { this.body = value; return this; }
    };
}
function temporary(t, prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('image rejects malformed bodies, URLs, SVG, dimensions and title/filter injection before decoding', () => {
    const valid = png().toString('base64');
    const invalid = [
        null, [], {}, { data: 'https://example.com/a.jpg' },
        { data: Buffer.from('<svg/>').toString('base64') }, { data: 'Zh==' },
        { data: png(4097, 2).toString('base64') },
        { data: png(4096, 4096).toString('base64') },
        { data: valid, title: '%{eif:1+1:d}' }, { data: valid, url: 'x' },
        { data: valid, returnUrl: 'true' },
        { data: 'A'.repeat(4 * Math.ceil(10 * 1024 * 1024 / 3) + 4) }
    ];
    for (const body of invalid) assert.throws(() => validate(body), { status: 400 });
    assert.deepEqual(dimensions(png(640, 360)), { width: 640, height: 360, format: 'png' });
});

test('image handler sends binary JPEG and cleans temporary files on success and FFmpeg failure', async t => {
    const root = temporary(t, 'image-route-');
    for (const fail of [false, true]) {
        let calls = 0;
        const handler = createImageHandler({
            tempDir: root, imageDir: root,
            execute: async args => {
                calls++;
                assert.ok(args.includes('-frames:v'));
                assert.ok(args.includes('-filter_complex_script'));
                const script = fs.readFileSync(args[args.indexOf('-filter_complex_script') + 1], 'utf8');
                assert.ok(!script.includes('drawtext'));
                fs.writeFileSync(args.at(-1), Buffer.from([255, 216, 255, 217]));
                if (fail) throw Error('private error');
            }
        });
        const res = response();
        await handler({ body: { data: png().toString('base64') } }, res);
        assert.equal(calls, 1);
        assert.equal(res.statusCode, fail ? 422 : 200);
        if (!fail) {
            assert.equal(res.headers['Content-Type'], 'image/jpeg');
            assert.ok(Buffer.isBuffer(res.body));
            assert.equal(res.headers['Cache-Control'], 'no-store');
        } else assert.equal(res.body.error, 'não foi possível processar a imagem');
        assert.deepEqual(fs.readdirSync(root), []);
    }
});

test('image malformed request never starts FFmpeg or writes files', async t => {
    const root = temporary(t, 'image-invalid-');
    const handler = createImageHandler({ tempDir: root, imageDir: root,
        execute: async () => assert.fail('unexpected render') });
    const res = response();
    await handler({ body: { data: '%%%%' } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('real image render keeps all four corners for landscape square and portrait; accepts PNG JPEG WebP', {
    skip: !process.env.FFMPEG_PATH && 'set trusted FFMPEG_PATH'
}, async t => {
    const executable = process.env.FFMPEG_PATH;
    const root = temporary(t, 'image-real-');
    const tempDir = path.join(root, 'temporary');
    const handler = createImageHandler({ ffmpegPath: executable, tempDir,
        imageDir: path.resolve(__dirname, '../assets/img') });
    for (const [name, size, extension] of [
        ['landscape', '640x360', 'png'], ['square', '640x640', 'jpg'], ['portrait', '360x640', 'webp']
    ]) {
        const source = path.join(root, name + '.' + extension);
        const markers = [
            'drawbox=x=0:y=0:w=80:h=80:color=red:t=fill',
            'drawbox=x=iw-80:y=0:w=80:h=80:color=lime:t=fill',
            'drawbox=x=0:y=ih-80:w=80:h=80:color=blue:t=fill',
            'drawbox=x=iw-80:y=ih-80:w=80:h=80:color=yellow:t=fill'
        ];
        await runFfmpeg(executable, ['-y', '-f', 'lavfi', '-i', `color=0x667080:s=${size}`,
            '-vf', markers.join(','), '-frames:v', '1', source]);
        const data = fs.readFileSync(source);
        assert.ok(dimensions(data));
        const res = response();
        await handler({ body: { data: data.toString('base64') } }, res);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(dimensions(res.body), { width: 1080, height: 1080, format: 'jpeg' });
        assert.deepEqual(fs.readdirSync(tempDir), []);
        const output = path.join(root, name + '-out.jpg');
        fs.writeFileSync(output, res.body);
        const raw = path.join(root, name + '.rgb');
        await runFfmpeg(executable, ['-y', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
        const frame = fs.readFileSync(raw);
        const [width, height] = size.split('x').map(Number);
        const scale = 940 / Math.max(width, height);
        const contentWidth = Math.floor(width * scale / 2) * 2;
        const contentHeight = Math.floor(height * scale / 2) * 2;
        const x = (1080 - contentWidth) / 2;
        const y = 110 + (940 - contentHeight) / 2;
        const samples = [
            [20, 20, [255, 0, 0]], [width - 20, 20, [0, 255, 0]],
            [20, height - 20, [0, 0, 255]], [width - 20, height - 20, [255, 255, 0]]
        ];
        for (const [sourceX, sourceY, color] of samples) {
            const offset = (Math.round(y + sourceY * contentHeight / height) * 1080 +
                Math.round(x + sourceX * contentWidth / width)) * 3;
            for (let channel = 0; channel < 3; channel++) {
                assert.ok(Math.abs(frame[offset + channel] - color[channel]) < 40, name + ' corner ' + channel);
            }
        }
    }
});

test('image URL response uses RAM cache and leaves temporary directory empty', async t => {
    const root = temporary(t, 'image-url-');
    const cache = createImageCache({ publicBaseUrl: 'https://example.com' });
    t.after(() => cache.close());
    const handler = createImageHandler({ tempDir: root, imageDir: root, cache,
        execute: async args => fs.writeFileSync(args.at(-1), Buffer.from('jpeg')) });
    const res = response();
    await handler({ body: { data: png().toString('base64'), returnUrl: true } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.url, /^https:\/\/example.com\/image-output\/[a-f0-9]{32}\.jpg$/);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('duplicate JPEG SOF and PNG IHDR cannot conceal larger decoder dimensions', () => {
    function sof(width, height) {
        const segment = Buffer.alloc(10);
        segment[0] = 255; segment[1] = 192;
        segment.writeUInt16BE(8, 2); segment[4] = 8;
        segment.writeUInt16BE(height, 5); segment.writeUInt16BE(width, 7);
        segment[9] = 1;
        return segment;
    }
    const forgedJpeg = Buffer.concat([Buffer.from([255, 216]), sof(1, 1), sof(5000, 2), Buffer.from([255, 218])]);
    assert.throws(() => dimensions(forgedJpeg), /duplicado/);
    const forgedPng = Buffer.concat([png(1, 1), png(5000, 2).subarray(8)]);
    assert.throws(() => dimensions(forgedPng), /duplicado/);
});

test('complete JPEG entropy scan rejects second SOF after SOS and accepts legitimate progressive multiscan', async t => {
    const forged = fs.readFileSync(path.join(__dirname, 'fixtures/forged-after-sos.jpg'));
    assert.throws(() => dimensions(forged), /duplicado/);
    const progressive = fs.readFileSync(path.join(__dirname, 'fixtures/progressive.jpg'));
    assert.deepEqual(dimensions(progressive), { width: 64, height: 48, format: 'jpeg' });
    // Fixture encoder uses SOF2 and multiple SOS segments, not a baseline JPEG relabeled progressive.
    assert.ok(progressive.includes(Buffer.from([255, 194])));
    let scans = 0;
    for (let i = 0; i < progressive.length - 1; i++) {
        if (progressive[i] === 255 && progressive[i + 1] === 218) scans++;
    }
    assert.ok(scans > 1);
    if (!process.env.FFMPEG_PATH) return t.skip('set trusted FFMPEG_PATH for actual progressive decoder');
    const root = temporary(t, 'image-progressive-');
    const handler = createImageHandler({ ffmpegPath: process.env.FFMPEG_PATH,
        tempDir: root, imageDir: path.resolve(__dirname, '../assets/img') });
    const res = response();
    await handler({ body: { data: progressive.toString('base64') } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(dimensions(res.body), { width: 1080, height: 1080, format: 'jpeg' });
    assert.deepEqual(fs.readdirSync(root), []);
});

test('JPEG scan treats stuffed FF bytes and restart markers as entropy while retaining later header checks', () => {
    const progressive = fs.readFileSync(path.join(__dirname, 'fixtures/progressive.jpg'));
    const sos = progressive.indexOf(Buffer.from([255, 218]));
    const dataStart = sos + 2 + progressive.readUInt16BE(sos + 2);
    const withEntropy = Buffer.concat([
        progressive.subarray(0, dataStart),
        Buffer.from([255, 0, 192, 255, 208, 1, 255, 215, 2]),
        progressive.subarray(dataStart)
    ]);
    assert.deepEqual(dimensions(withEntropy), { width: 64, height: 48, format: 'jpeg' });
    // This is parser-only data; the injected entropy is intentionally not a valid encoded photo.
});

test('actual FFmpeg honors max_pixels for the same valid progressive JPEG', {
    skip: !process.env.FFMPEG_PATH && 'set trusted FFMPEG_PATH'
}, async () => {
    const source = path.join(__dirname, 'fixtures/progressive.jpg');
    const decode = limit => runFfmpeg(process.env.FFMPEG_PATH, [
        '-v', 'error', '-max_pixels', String(limit), '-f', 'image2', '-c:v', 'mjpeg',
        '-i', source, '-frames:v', '1', '-f', 'null', '-'
    ]);
    await assert.rejects(decode(1));
    await decode(16000000);
});
