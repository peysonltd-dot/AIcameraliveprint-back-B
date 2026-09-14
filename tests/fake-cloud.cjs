// Test adapter only. Production never falls back to an in-memory store.
const { createCloudStore } = require('../cloud-store');
function fakeCloud() {
    const records = new Map(), images = new Map();
    const state = { failUpload: false, failWrite: false, failLoad: false, puts: 0, writes: 0, downloads: 0 };
    const copy = value => JSON.parse(JSON.stringify(value));
    const metadata = {
        async list() { if (state.failLoad) throw Error('mock offline'); return [...records.values()].map(copy); },
        async write(id, record) {
            if (state.failWrite) throw Error('mock metadata failed');
            const json = JSON.stringify(record);
            if (Buffer.byteLength(json) > 1000000 || json.includes('data:image')) throw Error('Firestore document too large or contains image bytes');
            records.set(id, copy(record)); state.writes++;
        },
        async clear() { records.clear(); }
    };
    const objects = {
        async put(path, buffer, mime, downloadable) {
            if (state.failUpload) throw Object.assign(Error('mock unavailable'), { code: 403 });
            images.set(path, Buffer.from(buffer)); state.puts++;
            return { path, ...(downloadable ? { url: 'https://mock-storage/' + encodeURIComponent(path) } : {}) };
        },
        async get(path) { state.downloads++; if (!images.has(path)) throw Error('missing'); return Buffer.from(images.get(path)); }
    };
    return { records, images, state, make: () => createCloudStore({ metadata, objects, appId: 'test-booth-b' }) };
}
module.exports = { fakeCloud };
