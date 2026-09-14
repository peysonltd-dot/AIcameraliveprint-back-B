// Offline HTTP checks only. No guest records, Firebase or paid APIs are accessed.
const assert = require('node:assert/strict');
const express = require('express');
const { createAdminAuth } = require('../admin-auth');

const password = 'test-password-only';
const servers = [];
async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise(resolve => server.once('listening', resolve));
    return 'http://127.0.0.1:' + server.address().port;
}
async function request(base, route, { token, method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, {
        method, headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { response, data: await response.json() };
}

(async () => {
    process.env.ADMIN_PASSWORD = password;
    delete process.env.LEONARDO_API_KEY;
    delete process.env.FIREBASE_CONFIG;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const instance = require('../server').createApp(); await instance.ready; const { app } = instance;
    const base = await listen(app);
    const routes = [
        ['POST', '/api/admin/retry-save/001'], ['GET', '/api/admin/download/001/B'], ['GET', '/api/admin/all-tasks'], ['GET', '/api/admin/all-tasks?lightweight=true'],
        ['GET', '/api/admin/task-source-image/001'], ['GET', '/api/admin/task-result-images/001'],
        ['POST', '/api/admin/reprocess/001'], ['POST', '/api/admin/upload-result-dual/001'],
        ['POST', '/api/admin/approve-result/001'], ['POST', '/api/admin/reset-all'],
        ['POST', '/api/admin/update-meta/001'], ['GET', '/api/admin/session'], ['POST', '/api/admin/logout'],
        ['GET', '/API/ADMIN/all-tasks'], ['GET', '/api/admin/all-tasks/']
    ];
    for (const [method, route] of routes) {
        const result = await request(base, route, { method });
        assert.equal(result.response.status, 401, route);
        assert.match(result.response.headers.get('cache-control'), /no-store/);
        assert(!('tasks' in result.data) && !('sourceImage' in result.data));
    }
    assert.equal((await request(base, '/api/admin/all-tasks?token=fake')).response.status, 401);
    assert.equal((await request(base, '/api/admin/all-tasks', { token: 'A'.repeat(43) })).response.status, 401);
    assert.equal((await request(base, '/api/admin/all-tasks', { headers: { Authorization: 'Basic Zm9vOmJhcg==' } })).response.status, 401);
    assert.equal((await request(base, '/health')).response.status, 200);
    assert.equal((await request(base, '/api/scenes')).data.scenes.length, 6);
    assert.equal((await request(base, '/api/status/does-not-exist')).response.status, 404);
    assert.equal((await request(base, '/api/choice/does-not-exist', { method: 'POST', body: { choice: 'B' } })).response.status, 404);

    const login = body => request(base, '/api/admin/login', { method: 'POST', body });
    for (const candidate of ['', 'wrong-password', { value: password }]) {
        assert.equal((await login({ password: candidate })).response.status, 401);
    }
    const one = await login({ password });
    const two = await login({ password });
    assert.equal(one.response.status, 200);
    assert.match(one.data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(one.data.token, two.data.token);
    assert(!JSON.stringify(one.data).includes(password));
    assert.equal((await request(base, '/api/admin/all-tasks', { token: one.data.token })).response.status, 200);
    assert.equal((await request(base, '/api/admin/session', { token: one.data.token })).data.expiresAt, one.data.expiresAt);
    assert.equal((await request(base, '/api/admin/logout', { method: 'POST', token: one.data.token })).response.status, 200);
    assert.equal((await request(base, '/api/admin/all-tasks', { token: one.data.token })).response.status, 401);
    assert.equal((await request(base, '/api/admin/all-tasks', { token: two.data.token })).response.status, 200);

    let time = Date.now();
    const expiring = express();
    expiring.use('/api/admin', createAdminAuth({ password, now: () => time, sessionTtlMs: 1000, attemptWindowMs: 1000 }));
    const expBase = await listen(expiring);
    const expLogin = () => request(expBase, '/api/admin/login', { method: 'POST', body: { password } });
    const expToken = (await expLogin()).data.token;
    time += 1001;
    assert.equal((await request(expBase, '/api/admin/session', { token: expToken })).response.status, 401);
    for (let i = 0; i < 5; i++) {
        const bad = await request(expBase, '/api/admin/login', { method: 'POST', body: { password: 'wrong' }, headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
        assert.equal(bad.response.status, 401);
    }
    const locked = await expLogin();
    assert.equal(locked.response.status, 429);
    assert(locked.response.headers.get('retry-after'));
    time += 1001;
    assert.equal((await expLogin()).response.status, 200);

    const unconfigured = express();
    unconfigured.use('/api/admin', createAdminAuth({ password: '' }));
    const missingBase = await listen(unconfigured);
    assert.equal((await request(missingBase, '/api/admin/login', { method: 'POST', body: { password } })).response.status, 503);
    assert.equal((await request(missingBase, '/api/admin/session', { token: two.data.token })).response.status, 401);
    console.log('PASS: all admin endpoints require authentication; login, random tokens, logout revocation, expiration, rate limiting, spoofed headers, missing configuration and public routes verified.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
});
