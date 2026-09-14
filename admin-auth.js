'use strict';

const crypto = require('node:crypto');
const express = require('express');

// Secrets are supplied by the server environment, never by a public HTML file.
function createAdminAuth({
    password = process.env.ADMIN_PASSWORD || '',
    now = Date.now,
    sessionTtlMs = 12 * 60 * 60 * 1000,
    attemptWindowMs = 10 * 60 * 1000,
    maxAttempts = 5
} = {}) {
    const router = express.Router();
    const sessions = new Map();
    const attempts = new Map();
    const digest = value => crypto.createHash('sha256').update(value).digest();
    const passwordHash = password ? digest(password) : null;
    const sessionKey = token => digest(token).toString('hex');

    function prune() {
        const time = now();
        for (const [key, item] of sessions) if (item.expiresAt <= time) sessions.delete(key);
        for (const [key, item] of attempts) if (item.resetAt <= time) attempts.delete(key);
    }

    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('X-Content-Type-Options', 'nosniff');
        prune();
        next();
    });

    // Limit this small request before the application's large image body parser.
    router.post('/login', express.json({ limit: '1kb' }), (req, res) => {
        if (!passwordHash) return res.status(503).json({ success: false, error: '後台尚未設定登入密碼，請設定 ADMIN_PASSWORD。' });
        // Do not trust a user-supplied X-Forwarded-For header. With a reverse proxy,
        // attempts may share one bucket, but spoofed headers cannot bypass it.
        const client = req.ip || req.socket.remoteAddress || 'unknown';
        let bucket = attempts.get(client);
        if (bucket && bucket.count >= maxAttempts) {
            res.set('Retry-After', String(Math.ceil((bucket.resetAt - now()) / 1000)));
            return res.status(429).json({ success: false, error: '密碼錯誤次數過多，請於 10 分鐘後再試。' });
        }
        const candidate = req.body && req.body.password;
        const valid = typeof candidate === 'string' && candidate.length <= 256
            && crypto.timingSafeEqual(digest(candidate), passwordHash);
        if (!valid) {
            if (!bucket) {
                if (attempts.size >= 10000) return res.status(429).json({ success: false, error: '登入請求過多，請稍後再試。' });
                bucket = { count: 0, resetAt: now() + attemptWindowMs };
                attempts.set(client, bucket);
            }
            bucket.count++;
            return res.status(401).json({ success: false, error: '密碼不正確，請重新輸入。' });
        }
        attempts.delete(client);
        if (sessions.size >= 1000) return res.status(503).json({ success: false, error: '登入人數已達上限，請稍後再試。' });
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = now() + sessionTtlMs;
        sessions.set(sessionKey(token), { expiresAt });
        res.json({ success: true, token, expiresAt });
    });

    // This gate also covers every existing and future /api/admin route.
    router.use((req, res, next) => {
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') || '');
        const key = match ? sessionKey(match[1]) : null;
        const session = key && sessions.get(key);
        if (!session || session.expiresAt <= now()) {
            return res.status(401).json({ success: false, error: '請先登入後台。' });
        }
        req.adminSessionKey = key;
        req.adminSession = session;
        next();
    });

    router.get('/session', (req, res) => res.json({ success: true, expiresAt: req.adminSession.expiresAt }));
    router.post('/logout', (req, res) => {
        sessions.delete(req.adminSessionKey);
        res.json({ success: true });
    });
    return router;
}

module.exports = { createAdminAuth };
