const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const dependencyRoot = process.env.VERIFIED_NODE_MODULES;

test('real HTTP parser rejects malformed/oversized JSON with fixed JSON errors and no body/stack logs', { skip: !dependencyRoot && 'set VERIFIED_NODE_MODULES to independently installed official Express/CORS' }, async t => {
    const officialRequire = createRequire(path.join(path.resolve(dependencyRoot), '..', 'package.json'));
    const realExpress = officialRequire('express');
    const realCors = officialRequire('cors');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-http-'));
    const logs = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logs.push(args);
    let server;
    t.after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        console.error = originalConsoleError;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const express = () => {
        const app = realExpress();
        app.set('env', 'development');
        // Adapt VM async functions to this realm's native Promise, avoiding
        // Express's unrelated cross-realm Promise-like deprecation warning.
        const post = app.post.bind(app);
        app.post = (route, handler) => post(route, (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next));
        const listen = app.listen.bind(app);
        app.listen = (port, callback) => (server = listen(0, '127.0.0.1', callback));
        return app;
    };
    express.static = realExpress.static;
    express.json = options => {
        assert.ok(['500mb', '15mb'].includes(options.limit), 'image and video limits remain bounded');
        // Exercise the actual Express/body-parser oversized-body branch with a
        // small fixture; never allocate or transmit a 500 MiB test request.
        return realExpress.json({ ...options, limit: '128b' });
    };
    const sandbox = {
        __dirname: root,
        process: { env: { FFMPEG_PATH: 'not-executed', OUTPUT_TTL_HOURS: '1' } },
        console: { log() {}, error(...args) { logs.push(args); } },
        require: name => name === 'express' ? express : name === 'cors' ? realCors : name === './video-tools' ? require('../video-tools') : name === './image-route' ? require('../image-route') : require(name)
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), sandbox);
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    async function request(route, body, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text: Buffer.concat(chunks).toString() }));
            });
            req.on('error', reject);
            req.end(body);
        });
    }
    for (const route of ['/process-video', '/tucano', '/process-image']) {
        const malformed = await request(route, '{"private-marker":"confidential-value",');
        assert.equal(malformed.status, 400);
        assert.match(malformed.type, /^application\/json/);
        assert.deepEqual(JSON.parse(malformed.text), { error: 'JSON inválido' });
        assert.equal(malformed.text.includes('confidential-value'), false);
        assert.equal(malformed.text.includes('SyntaxError'), false);
        assert.equal(malformed.text.includes('stack'), false);
        const oversized = await request(route, JSON.stringify({ text: 'private-marker' + 'x'.repeat(200) }));
        assert.equal(oversized.status, 413);
        assert.match(oversized.type, /^application\/json/);
        assert.deepEqual(JSON.parse(oversized.text), { error: 'corpo JSON excede o limite permitido' });
        const unsupported = await request(route, '{}', { 'content-type': 'application/json; charset=iso-8859-1' });
        assert.equal(unsupported.status, 415);
        assert.deepEqual(JSON.parse(unsupported.text), { error: 'charset JSON não suportado' });
        // Valid JSON still reaches normal route validation after parser failures.
        const valid = await request(route, route === '/process-video' ? '{}' : '{"text":123}');
        assert.equal(valid.status, 400);
        assert.match(valid.type, /^application\/json/);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.length, 0, 'parser errors must not be logged');
});
