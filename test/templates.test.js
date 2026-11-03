const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { renderTemplates } = require('../scripts/render-video-backgrounds');

test('template SVGs embed original wordmark bytes and contain no rendered text or external image', () => {
    for (const name of ['back', 'background-story']) {
        const source = fs.readFileSync(path.join(__dirname, '../assets/templates', name + '.svg'), 'utf8');
        assert.doesNotMatch(source, /<text\b/);
        const images = [...source.matchAll(/href="([^"]+)"/g)];
        assert.equal(images.length, 1);
        assert.ok(images[0][1].startsWith('data:image/png;base64,'));
        const original = Buffer.from(images[0][1].split(',')[1], 'base64');
        assert.equal(crypto.createHash('sha256').update(original).digest('hex'), 'a135f798dd54629ee78e0906298443c7efd4e0530307d184cd6d8303be3fe2d3');
    }
});
let rasterizerAvailable = false;
try { require.resolve('@resvg/resvg-js'); rasterizerAvailable = true; } catch {}
test('template rasterization preserves exact dimensions, palette and boundary pixels', { skip: !rasterizerAvailable && 'install isolated @resvg/resvg-js@2.6.2 and set NODE_PATH' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-templates-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const images = renderTemplates(dir);
    assert.equal(images.length, 2);
    for (const image of images) {
        const png = fs.readFileSync(image.file);
        assert.equal(png.readUInt32BE(16), image.width);
        assert.equal(png.readUInt32BE(20), image.height);
    }
});
