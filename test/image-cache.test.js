const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageCache, createImageDownloadHandler } = require('../image-cache');

test('image cache expires by injected clock and enforces count/bytes without evicting valid entries', t => {
    let now = 1000;
    const cache = createImageCache({ publicBaseUrl: 'https://example.com', now: () => now, maxEntries: 2, maxBytes: 6, ttlMs: 100 });
    t.after(() => cache.close());
    const first = cache.store(Buffer.from('aaa'));
    const token = new URL(first.url).pathname.split('/').at(-1).replace('.jpg', '');
    assert.match(token, /^[a-f0-9]{32}$/);
    assert.equal(cache.get(token).toString(), 'aaa');
    cache.store(Buffer.from('bbb'));
    assert.throws(() => cache.store(Buffer.from('c')), { status: 503 });
    assert.equal(cache.get(token).toString(), 'aaa');
    now = 1100;
    assert.equal(cache.get(token), undefined);
    assert.ok(cache.store(Buffer.from('ccc')).url);
    assert.throws(() => cache.store(Buffer.alloc(4)), { status: 503 });
    assert.equal(cache.get('../secret'), undefined);
});

test('cache requires fixed HTTPS origin and cannot derive public URL from request Host', t => {
    for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?q=1']) {
        assert.throws(() => createImageCache({ publicBaseUrl: url }));
    }
    const cache = createImageCache();
    t.after(() => cache.close());
    assert.equal(cache.configured, false);
    assert.throws(() => cache.store(Buffer.from('a')), { status: 503 });
});

test('download returns binary JPEG and 404 after expiry', t => {
    let now = 0;
    const cache = createImageCache({ publicBaseUrl: 'https://example.com', now: () => now, ttlMs: 10 });
    t.after(() => cache.close());
    const entry = cache.store(Buffer.from('jpeg'));
    const token = entry.url.split('/').at(-1).slice(0, -4);
    const handler = createImageDownloadHandler(cache);
    function response() { return { statusCode: 200, headers: {}, set(k,v) { this.headers[k]=v; }, send(data) { this.data=data; }, status(n) { this.statusCode=n;return this; }, json(body) { this.body=body; } }; }
    const result = response();
    handler({ params: { token } }, result);
    assert.equal(result.headers['Content-Type'], 'image/jpeg');
    assert.equal(result.data.toString(), 'jpeg');
    now = 10;
    const expired = response();
    handler({ params: { token } }, expired);
    assert.equal(expired.statusCode, 404);
});
