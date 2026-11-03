const crypto = require('node:crypto');

function createImageCache({ publicBaseUrl, now = Date.now, maxEntries = 32,
    maxBytes = 32 * 1024 * 1024, ttlMs = 30 * 60 * 1000 } = {}) {
    let origin;
    if (publicBaseUrl) {
        const url = new URL(publicBaseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
            (url.pathname !== '/' && url.pathname !== '')) {
            throw new Error('IMAGE_PUBLIC_BASE_URL deve ser uma origem HTTPS fixa');
        }
        origin = url.origin;
    }
    const items = new Map();
    let usedBytes = 0;
    function cleanup() {
        const current = now();
        for (const [token, item] of items) {
            if (item.expiresAt <= current) {
                usedBytes -= item.data.length;
                items.delete(token);
            }
        }
    }
    function store(data) {
        if (!origin) throw Object.assign(new Error('URL pública de imagens não configurada'), { status: 503 });
        cleanup();
        if (items.size >= maxEntries || usedBytes + data.length > maxBytes) {
            throw Object.assign(new Error('cache de imagens ocupado; tente novamente mais tarde'), { status: 503 });
        }
        const token = crypto.randomBytes(16).toString('hex');
        const expiresAt = now() + ttlMs;
        items.set(token, { data, expiresAt });
        usedBytes += data.length;
        return { url: `${origin}/image-output/${token}.jpg`, expiresAt: new Date(expiresAt).toISOString(), mimeType: 'image/jpeg' };
    }
    function get(token) {
        cleanup();
        if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return undefined;
        return items.get(token)?.data;
    }
    const timer = setInterval(cleanup, Math.min(ttlMs, 60000));
    timer.unref();
    return { store, get, cleanup, configured: Boolean(origin), close: () => clearInterval(timer) };
}

function createImageDownloadHandler(cache) {
    return (req, res) => {
        const data = cache.get(req.params.token);
        if (!data) return res.status(404).json({ error: 'imagem indisponível ou expirada' });
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-store');
        return res.send(data);
    };
}

module.exports = { createImageCache, createImageDownloadHandler };
