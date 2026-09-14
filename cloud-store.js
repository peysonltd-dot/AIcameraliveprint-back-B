'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const IMAGE_FIELDS = ['sourceImage', 'resultImageA', 'resultImageB'];
const META_FIELDS = ['id', 'sceneId', 'sceneName', 'styleMode', 'status', 'chosenDesign',
    'processStatus', 'remark', 'styleBName', 'createdAt', 'assetNamespace',
    'generationIdA', 'generationIdB', 'originalGenerationUrlA', 'originalGenerationUrlB',
    'printStatusA', 'printStatusB', 'printWarningA', 'printWarningB', 'cloudStatus', 'cloudError', 'cloudSavedAt'];

function decodeDataImage(value) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value || '');
    if (!match) throw new Error('圖片格式不支援');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 30 * 1024 * 1024) throw new Error('圖片大小不支援');
    return { buffer, mime: match[1] };
}

function safeMetadata(task) {
    const record = {};
    for (const key of META_FIELDS) if (task[key] !== undefined) record[key] = task[key];
    for (const key of IMAGE_FIELDS) {
        const file = task[key + 'File'];
        if (file) record[key + 'File'] = file;
        // Raw images must NEVER be written into Firestore, including error paths.
        record[key] = key === 'sourceImage' ? null : file?.url ||
            (/^https:\/\//.test(task[key] || '') ? task[key] : null);
    }
    if (Buffer.byteLength(JSON.stringify(record)) > 200000) throw new Error('任務文字資料過大');
    return record;
}

function storageError(error) {
    const code = String(error?.code || '');
    if (['403', '7', 'permission-denied', 'storage/unauthorized'].includes(code))
        return '雲端權限不足，請檢查 Storage 與服務帳戶設定；圖片尚未完整保存。';
    if (code === '404') return '找不到圖片儲存空間，請檢查 FIREBASE_STORAGE_BUCKET。';
    return '雲端保存未完成，請確認連線與儲存設定後按「重新保存」；重啟前請下載成品。';
}

// Dependency injection lets the exact production persistence path be tested offline.
function createCloudStore({ metadata, objects, appId, configurationError = '' }) {
    const queues = new Map();
    const configured = !!(metadata && objects);
    async function persistNow(task) {
        if (!configured) throw new Error(configurationError || '尚未設定圖片雲端儲存');
        task.cloudStatus = 'saving'; task.cloudError = '';
        task.assetNamespace ||= crypto.randomUUID();
        const snapshot = { ...task };
        try {
            for (const key of IMAGE_FIELDS) {
                const value = snapshot[key];
                if (!value?.startsWith('data:')) continue;
                const { buffer, mime } = decodeDataImage(value);
                const hash = crypto.createHash('sha256').update(buffer).digest('hex');
                let file = snapshot[key + 'File'];
                if (!file || file.sha256 !== hash) {
                    delete snapshot[key + 'File'];
                    if (task[key] === value) delete task[key + 'File'];
                    const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
                    const name = `booth-b/${encodeURIComponent(appId)}/${snapshot.assetNamespace}/${key}-${hash}.${extension}`;
                    file = await objects.put(name, buffer, mime, key !== 'sourceImage');
                    file = { ...file, mime, bytes: buffer.length, sha256: hash };
                    snapshot[key + 'File'] = file;
                    // Keep successful uploads for retries if the metadata write fails.
                    if (task[key] === value) task[key + 'File'] = file;
                }
            }
            const record = safeMetadata({ ...snapshot, cloudStatus: 'saved', cloudError: '', cloudSavedAt: new Date().toISOString() });
            await metadata.write(task.id, record);
            for (const key of IMAGE_FIELDS) if (task[key] === snapshot[key] && snapshot[key + 'File']) task[key] = record[key];
            task.cloudStatus = 'saved'; task.cloudError = ''; task.cloudSavedAt = record.cloudSavedAt;
            return true;
        } catch (error) {
            task.cloudStatus = 'failed'; task.cloudError = storageError(error);
            // Preserve job IDs and original URLs even when the processed PNG cannot be saved.
            try { await metadata.write(task.id, safeMetadata({ ...snapshot, cloudStatus: 'failed', cloudError: task.cloudError })); } catch (_) {}
            return false;
        }
    }
    return {
        configured, hasMetadata: !!metadata, configurationError,
        async load() { return metadata ? metadata.list() : []; },
        save(task) {
            const previous = queues.get(task.id) || Promise.resolve();
            const next = previous.catch(() => {}).then(() => persistNow(task));
            queues.set(task.id, next);
            next.finally(() => { if (queues.get(task.id) === next) queues.delete(task.id); }).catch(() => {});
            return next;
        },
        async readImage(task, key) {
            if (!IMAGE_FIELDS.includes(key)) throw new Error('圖片欄位錯誤');
            if (task[key]?.startsWith('data:')) return decodeDataImage(task[key]);
            const file = task[key + 'File'];
            if (!file || !objects) throw new Error('圖片檔案尚未保存');
            const buffer = await objects.get(file.path);
            if (crypto.createHash('sha256').update(buffer).digest('hex') !== file.sha256) throw new Error('圖片完整性驗證失敗');
            return { buffer, mime: file.mime };
        },
        async removeRecords() {
            if (!metadata) throw new Error('資料庫未設定');
            await metadata.clear();
            // Intentionally retain objects. A queue reset must not erase printed artwork or other apps' files.
        }
    };
}

function parseConfig(raw) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (_) {
        return JSON.parse(raw.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":').replace(/'/g, '"'));
    }
}

function configuredCloudStore(appId, env = process.env) {
    let config = {}, configurationError = '', metadata, objects;
    try {
        if (!/^[^/]{1,100}$/.test(appId)) throw new Error('APP_ID 格式不正確');
        config = parseConfig(env.FIREBASE_CONFIG);
        const raw = env.FIREBASE_SERVICE_ACCOUNT || (env.GOOGLE_APPLICATION_CREDENTIALS
            ? fs.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8') : '');
        if (!raw) throw new Error('請設定 FIREBASE_SERVICE_ACCOUNT，或掛載服務帳戶檔並設定 GOOGLE_APPLICATION_CREDENTIALS。');
        const serviceAccount = JSON.parse(raw);
        if (config.projectId && serviceAccount.project_id !== config.projectId)
            throw new Error('服務帳戶與原本 FIREBASE_CONFIG 的專案不同，請使用同一 Firebase 專案。');
        const { initializeApp, cert } = require('firebase-admin/app');
        const { getFirestore } = require('firebase-admin/firestore');
        const { getStorage, getDownloadURL } = require('firebase-admin/storage');
        const adminApp = initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id }, `booth-b-${crypto.randomUUID()}`);
        const db = getFirestore(adminApp);
        const collection = db.collection('artifacts').doc(appId).collection('public');
        metadata = {
            async list() { return (await collection.get()).docs.map(d => ({ ...d.data(), id: d.id })); },
            async write(id, record) { await collection.doc(id).set(record); },
            async clear() {
                const docs = (await collection.get()).docs;
                for (let i = 0; i < docs.length; i += 400) {
                    const batch = db.batch(); docs.slice(i, i + 400).forEach(d => batch.delete(d.ref)); await batch.commit();
                }
            }
        };
        const bucketName = (env.FIREBASE_STORAGE_BUCKET || config.storageBucket || '').trim();
        if (!/^[a-z0-9][a-z0-9._-]+$/.test(bucketName)) throw new Error('請設定 FIREBASE_STORAGE_BUCKET（不含 gs://）。');
        const bucket = getStorage(adminApp).bucket(bucketName);
        objects = {
            async put(name, buffer, mime, downloadable) {
                const file = bucket.file(name);
                await file.save(buffer, {
                    resumable: false, validation: 'crc32c', timeout: 60000,
                    metadata: { contentType: mime, cacheControl: 'private, max-age=3600',
                        metadata: downloadable ? { firebaseStorageDownloadTokens: crypto.randomUUID() } : {} }
                });
                return { path: name, ...(downloadable ? { url: await getDownloadURL(file) } : {}) };
            },
            async get(name) { return (await bucket.file(name).download({ validation: 'crc32c' }))[0]; }
        };
    } catch (error) { configurationError = error.message.startsWith('請') || error.message.startsWith('服務帳戶')
        ? error.message : '雲端儲存設定無法讀取，請檢查服務帳戶 JSON 與 Firebase 設定。'; }
    // Allow staff to read existing orders while configuring Storage; never accept new paid jobs without it.
    if (!metadata && config.apiKey && config.projectId) {
        try {
            const { initializeApp } = require('firebase/app');
            const { getFirestore, getDocs, collection } = require('firebase/firestore');
            const db = getFirestore(initializeApp(config, `legacy-read-${crypto.randomUUID()}`));
            metadata = { async list() { return (await getDocs(collection(db, 'artifacts', appId, 'public'))).docs.map(d => ({ ...d.data(), id: d.id })); } };
        } catch (_) {}
    }
    return createCloudStore({ metadata, objects, appId, configurationError });
}

module.exports = { configuredCloudStore, createCloudStore, safeMetadata, decodeDataImage };
