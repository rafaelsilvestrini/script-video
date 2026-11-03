const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SPECS = [
    { name: 'back', width: 1080, height: 1080, samples: [[0, 0, [18, 24, 39, 255]], [140, 20, [247, 245, 239, 255]], [140, 100, [213, 255, 85, 255]], [140, 110, [18, 24, 39, 255]], [940, 910, [18, 24, 39, 255]]] },
    { name: 'background-story', width: 1080, height: 1920, samples: [[0, 0, [247, 245, 239, 255]], [0, 56, [213, 255, 85, 255]], [0, 59, [213, 255, 85, 255]], [0, 60, [18, 24, 39, 255]], [1079, 1919, [18, 24, 39, 255]]] }
];

function renderTemplates(outputDir) {
    const { version } = require('@resvg/resvg-js/package.json');
    assert.equal(version, '2.6.2', 'use the documented rasterizer version');
    const { Resvg } = require('@resvg/resvg-js');
    const results = [];
    fs.mkdirSync(outputDir, { recursive: true });
    for (const spec of SPECS) {
        const source = path.join(__dirname, '../assets/templates', spec.name + '.svg');
        const image = new Resvg(fs.readFileSync(source), { font: { loadSystemFonts: false }, fitTo: { mode: 'original' } }).render();
        assert.equal(image.width, spec.width);
        assert.equal(image.height, spec.height);
        const pixels = image.pixels;
        for (const [x, y, expected] of spec.samples) {
            const offset = (y * image.width + x) * 4;
            assert.deepEqual(Array.from(pixels.subarray(offset, offset + 4)), expected, `${spec.name} sample ${x},${y}`);
        }
        const destination = path.join(outputDir, spec.name + '.png');
        fs.writeFileSync(destination, image.asPng());
        results.push({ file: destination, width: image.width, height: image.height });
    }
    return results;
}

if (require.main === module) {
    if (!process.argv[2]) {
        console.error('Usage: node scripts/render-video-backgrounds.js <output-directory>');
        process.exitCode = 2;
    } else console.log(JSON.stringify(renderTemplates(path.resolve(process.argv[2]))));
}
module.exports = { renderTemplates, SPECS };
