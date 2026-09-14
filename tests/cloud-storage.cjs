'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { fakeCloud } = require('./fake-cloud.cjs');
const { createApp } = require('../server');
const { createCloudStore } = require('../cloud-store');
process.env.ADMIN_PASSWORD = 'test-password-only';
process.env.LEONARDO_API_KEY = 'test-key-only';
delete process.env.FIREBASE_CONFIG;
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const realFetch = global.fetch;
const servers = [], instances = [];
let paidCalls = 0;
global.fetch = (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    paidCalls++;
    throw Error('No external network or paid generation permitted in storage tests');
};
async function boot(cloud) {
    const instance = createApp({ cloud }); instances.push(instance); await instance.ready;
    const server = instance.app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const login = await realFetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) }).then(r => r.json());
    const request = (route, body, authenticated = true) => realFetch(base + route, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer ' + login.token } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { instance, server, request };
}
(async () => {
    // A real >1 MiB transparent PNG. Compare exact bytes and alpha after storage and a new process instance.
    const width = 1024, height = 768, pixels = crypto.randomBytes(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[(y * width + x) * 4 + 3] = x < 82 || x >= 942 || y < 62 || y >= 706 ? 0 : 255;
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    assert(png.length > 1048487);
    const source = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#abcdef' } }).jpeg().toBuffer();
    const resultData = 'data:image/png;base64,' + png.toString('base64');
    const sourceData = 'data:image/jpeg;base64,' + source.toString('base64');
    const task = { id: '041', styleMode: 'chibi-only', sceneId: 'digital-ark-orange', status: 'completed', sourceImage: sourceData,
        resultImageA: null, resultImageB: resultData, printStatusB: 'ready', chosenDesign: null, remark: '', processStatus: '製作中', originalGenerationUrlB: 'https://mock/original', generationIdB: 'existing-job' };
    const fake = fakeCloud(), cloud = fake.make();
    assert.equal(await cloud.save(task), true);
    const record = fake.records.get('041');
    assert(Buffer.byteLength(JSON.stringify(record)) < 5000);
    assert.equal(record.sourceImage, null); assert(!record.sourceImageFile.url, 'source must remain private');
    assert(record.resultImageB.startsWith('https://')); assert.equal(record.cloudStatus, 'saved');
    assert.deepEqual(fake.images.get(record.resultImageBFile.path), png);
    assert.deepEqual((await cloud.readImage(record, 'sourceImage')).buffer, source);
    const putCount = fake.state.puts;
    await cloud.save(task); assert.equal(fake.state.puts, putCount, 'metadata updates do not re-upload images');

    const first = await boot(fake.make());
    let response = await first.request('/api/choice/041', { choice: 'B' }, false);
    assert.equal(response.status, 200);
    assert.equal(fake.records.get('041').chosenDesign, 'B');
    first.instance.close(); await new Promise(r => first.server.close(r));
    const restarted = await boot(fake.make());
    const status = await restarted.request('/api/status/041', undefined, false).then(r => r.json());
    assert.equal(status.chosenDesign, 'B'); assert.equal(status.resultImageB, record.resultImageB);
    response = await restarted.request('/api/admin/download/041/B');
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert(response.headers.get('content-disposition').includes('.png'));
    const restored = Buffer.from(await response.arrayBuffer()); assert.deepEqual(restored, png);
    assert.equal((await sharp(restored).metadata()).hasAlpha, true);
    response = await restarted.request('/api/admin/task-source-image/041');
    assert.equal((await response.json()).sourceImage, sourceData);
    assert.equal((await restarted.request('/api/admin/download/041/B', undefined, false)).status, 401);

    // Upload fails: renderable in-memory copy remains, recovery metadata contains no base64, retry uploads same bytes.
    const failing = { ...task, id: '042', chosenDesign: null, resultImageB: resultData, sourceImage: sourceData, assetNamespace: undefined, sourceImageFile: undefined, resultImageBFile: undefined };
    fake.state.failUpload = true;
    assert.equal(await cloud.save(failing), false);
    assert.equal(failing.resultImageB, resultData); assert.equal(failing.cloudStatus, 'failed');
    assert.equal(fake.records.get('042').generationIdB, 'existing-job');
    assert.equal(fake.records.get('042').originalGenerationUrlB, 'https://mock/original');
    assert.equal(fake.records.get('042').resultImageB, null);
    fake.state.failUpload = false;
    assert.equal(await cloud.save(failing), true);

    // Metadata failure must not advertise durable success; successfully uploaded files are reused.
    const writeFail = { ...task, id: '043', sourceImage: sourceData, resultImageB: resultData, assetNamespace: undefined, sourceImageFile: undefined, resultImageBFile: undefined };
    fake.state.failWrite = true;
    assert.equal(await cloud.save(writeFail), false); assert.equal(writeFail.cloudStatus, 'failed');
    const afterUpload = fake.state.puts;
    fake.state.failWrite = false; assert.equal(await cloud.save(writeFail), true);
    assert.equal(fake.state.puts, afterUpload);

    const failedApp = await boot(fake.make());
    fake.state.failWrite = true;
    assert.equal((await failedApp.request('/api/choice/043', { choice: 'B' }, false)).status, 503);
    assert.equal((await failedApp.request('/api/status/043', undefined, false).then(r => r.json())).chosenDesign, null);
    fake.state.failWrite = false;
    assert.equal((await failedApp.request('/api/admin/retry-save/043', {})).status, 200);
    assert.equal((await failedApp.request('/api/choice/043', { choice: 'B' }, false)).status, 200);
    assert.equal((await failedApp.request('/api/choice/043', { choice: 'B' }, false)).status, 200);

    // Previous metadata holds inline images: migrate losslessly on explicit retry, without generation.
    fake.records.set('044', { id: '044', styleMode: 'chibi-only', status: 'completed', chosenDesign: null, sourceImage: sourceData, resultImageB: resultData });
    const legacyApp = await boot(fake.make());
    assert.equal((await legacyApp.request('/api/admin/retry-save/044', {})).status, 200);
    assert(!JSON.stringify(fake.records.get('044')).includes('data:image'));
    assert.deepEqual(fake.images.get(fake.records.get('044').resultImageBFile.path), png);

    // Missing configuration and failed startup do not accept paid jobs or reset numbering.
    const unconfigured = await boot(createCloudStore({ appId: 'test' }));
    assert.equal((await unconfigured.request('/api/upload', { image: sourceData })).status, 503);
    fake.state.failLoad = true;
    const offline = await boot(fake.make());
    assert.equal((await offline.request('/api/upload', { image: sourceData })).status, 503);
    assert.equal((await offline.request('/api/admin/all-tasks')).status, 503);
    fake.state.failLoad = false;
    // Queue reset retains stored objects and never touches a shared bucket globally.
    const imageCount = fake.images.size;
    await cloud.removeRecords(); assert.equal(fake.records.size, 0); assert.equal(fake.images.size, imageCount);
    assert.equal(paidCalls, 0);
    console.log('PASS: >1 MiB PNG exact bytes/alpha, private source, small metadata, startup restore/QR data/admin download, save failures/retry, legacy migration, no paid calls, startup/config guards, retained objects on reset.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    global.fetch = realFetch;
    instances.forEach(instance => instance.close());
    await Promise.all(servers.filter(s => s.listening).map(server => new Promise(r => { server.close(r); server.closeAllConnections(); })));
});
