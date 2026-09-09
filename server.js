/**
 * AI 互動雷雕拍照系統 - 後端 API (Firebase 雲端同步 & 飛鵝出票機防當機完全體版)
 * 🌟 終極上線版：包含極速記憶體快取、LOW 畫質生圖、完美出票排版，以及狀態備註同步儲存！
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, collection, getDocs, updateDoc, deleteDoc } = require('firebase/firestore');

const app = express();
const PORT = process.env.PORT || 10000; 

app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

let localTasksCache = {};
let ticketCounter = 1;
let db;
let useFirebase = false;

const appId = (process.env.APP_ID || "photo-booth-app").trim();
const LEONARDO_API_KEY = (process.env.LEONARDO_API_KEY || "").trim();
const REMOVE_BG_MODE = (process.env.REMOVE_BG_MODE || "local").trim().toLowerCase();
const OUTPUT_WIDTH = 1024;
const OUTPUT_HEIGHT = 768;
const SCENES = {
    "digital-ark-green": {
        name: "與綠色 IP 共乘數位方舟",
        referencePath: path.join(__dirname, "assets", "layers", "digital-ark-green", "pose-reference.jpg"),
        backgroundPath: path.join(__dirname, "assets", "layers", "digital-ark-green", "background.svg"),
        ipPath: path.join(__dirname, "assets", "layers", "digital-ark-green", "ip.svg"),
        boatPath: path.join(__dirname, "assets", "layers", "digital-ark-green", "boat.svg"),
        ipLayout: { height: 520, left: 565, top: 72 },
        personLayout: { width: 440, height: 560, left: 125, top: 92 },
        boatLayout: { width: 920, left: 52, top: 290 },
        composition: "Create one isolated seated chibi guest in a relaxed three-quarter-body pose, facing the camera and smiling. Keep both arms and hands simple, visible and close to the body. The body must fit comfortably behind the front edge of a boat when composited later."
    }
};
const Q_STYLE_REFERENCE_PATH = path.join(__dirname, "assets", "q-style-reference.jpg");
const sceneReferenceCache = new Map();
let qStyleReferenceCache = null;

// Firebase 初始化 (僅在開機時連線一次)
if (process.env.FIREBASE_CONFIG) {
    try {
        let configStr = process.env.FIREBASE_CONFIG.trim();
        let firebaseConfig;
        try { firebaseConfig = JSON.parse(configStr); } catch (jsonErr) {
            let formatted = configStr.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":').replace(/'/g, '"'); 
            firebaseConfig = JSON.parse(formatted);
        }
        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        useFirebase = true;
        console.log("🔥 Firebase 雲端資料庫連線成功！");
        syncTicketCounterFromCloud();
    } catch (e) { console.error("❌ Firebase 初始化失敗:", e.message); }
}

// 僅在開機時載入一次歷史紀錄與續接流水號
async function syncTicketCounterFromCloud() {
    if (!useFirebase) return;
    try {
        const querySnapshot = await getDocs(collection(db, 'artifacts', appId, 'public'));
        let maxId = 0;
        querySnapshot.forEach((doc) => {
            const idNum = parseInt(doc.id, 10);
            if (!isNaN(idNum) && idNum > maxId) maxId = idNum;
            localTasksCache[doc.id] = doc.data();
        });
        ticketCounter = maxId + 1;
        console.log(`🎯 流水號續接成功！下一位：#${String(ticketCounter).padStart(3, '0')}`);
    } catch (e) {}
}

// 飛鵝印表機完美置中與放大排版
async function triggerFeiePrint(task) {
    const user = (process.env.FEIE_USER || "").trim(); 
    const ukey = (process.env.FEIE_UKEY || "").trim(); 
    const sn = (process.env.FEIE_SN || "961820398").trim(); 
    if (!user || !ukey) return;

    const stime = Math.floor(Date.now() / 1000);
    const sig = crypto.createHash('sha1').update(user + ukey + stime).digest('hex');

    let content = `<CB>專屬禮品兌換</CB><BR>`;
    content += `<C>--------------------------------</C><BR>`;
    content += `<BR><CB>${task.id}</CB><BR><BR>`; 
    content += `<C>--------------------------------</C><BR>`;
    content += `<C>排隊時間：${task.createdAt}</C><BR>`;
    content += `<C>--------------------------------</C><BR>`;
    content += `<C><B>領取說明：</B></C><BR>`;
    content += `<C>領取時請出示此號碼牌</C><BR>`;
    content += `<C>交由工作人員兌換您的禮品</C><BR><BR>`;
    content += `<CB>～感謝您的參與～</CB><BR>`;
    content += `<CB>～祝您體驗愉快～</CB><BR>`;

    const params = new URLSearchParams();
    params.append('user', user); params.append('stime', stime.toString()); params.append('sig', sig);
    params.append('apiname', 'Open_printMsg'); params.append('sn', sn); params.append('content', content); params.append('times', '1');

    try { 
        await fetch('https://api.jp.feieyun.com/Api/Open/', { 
            method: 'POST', body: params, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
        }); 
    } catch (err) {}
}

async function uploadBufferToLeonardoS3(imageBuffer, label = 'image') {
    try {
        const initUploadRes = await fetch('https://cloud.leonardo.ai/api/rest/v1/init-image', {
            method: 'POST', headers: { 'accept': 'application/json', 'authorization': `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ "extension": "jpg" })
        });
        if (!initUploadRes.ok) throw new Error(await initUploadRes.text());

        const uploadData = await initUploadRes.json();
        const { id, url, fields } = uploadData.uploadInitImage;
        const formData = new FormData();
        Object.entries(JSON.parse(fields)).forEach(([key, value]) => { formData.append(key, value); });
        formData.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), 'image.jpg');

        const s3UploadRes = await fetch(url, { method: 'POST', body: formData });
        if (s3UploadRes.status >= 200 && s3UploadRes.status < 300) {
            console.log(`✅ ${label}成功上傳 Leonardo S3，ID: ${id}`); return id;
        } else { throw new Error(`S3 上傳失敗: ${s3UploadRes.status}`); }
    } catch (err) { throw err; }
}

async function uploadToLeonardoS3(base64Image) {
    const imageBuffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    return uploadBufferToLeonardoS3(imageBuffer, '客人照片');
}

async function getSceneReferenceId(sceneId) {
    if (sceneReferenceCache.has(sceneId)) return sceneReferenceCache.get(sceneId);
    const scene = SCENES[sceneId];
    if (!scene) throw new Error(`未知的互動情境：${sceneId}`);
    const referenceBuffer = fs.readFileSync(scene.referencePath);
    const referenceId = await uploadBufferToLeonardoS3(referenceBuffer, `情境參考圖「${scene.name}」`);
    sceneReferenceCache.set(sceneId, referenceId);
    return referenceId;
}

async function getQStyleReferenceId() {
    if (qStyleReferenceCache) return qStyleReferenceCache;
    const referenceBuffer = fs.readFileSync(Q_STYLE_REFERENCE_PATH);
    qStyleReferenceCache = await uploadBufferToLeonardoS3(referenceBuffer, 'Q 版畫風參考圖');
    return qStyleReferenceCache;
}

async function downloadImageBuffer(url, label = '圖片') {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${label}下載失敗：${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function removeBackgroundWithLeonardo(imageUrl) {
    const response = await fetch('https://cloud.leonardo.ai/api/rest/v2/generationssync', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'authorization': `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            model: 'remove-bg', public: false, ephemeral: true, base64: true,
            parameters: {
                size: 'auto', type: 'graphic', channels: 'rgba', format: 'png', crop: true,
                crop_margin: '4%', semitransparency: true, shadow_type: 'none', quantity: 1,
                guidances: { image_reference: [{ image: { url: imageUrl, type: 'URL' } }] }
            }
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Leonardo 去背失敗：${response.status}`);
    const encoded = data.results?.[0]?.dataB64;
    if (!encoded) throw new Error('Leonardo 去背沒有回傳圖片');
    return Buffer.from(encoded.replace(/^data:image\/\w+;base64,/, ''), 'base64');
}

async function removeMagentaBackgroundLocally(imageBuffer) {
    const { data, info } = await sharp(imageBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const pixelCount = width * height;
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;

    const distanceFromKey = (pixelIndex) => {
        const offset = pixelIndex * channels;
        const redDelta = 255 - data[offset];
        const greenDelta = data[offset + 1];
        const blueDelta = 255 - data[offset + 2];
        return Math.sqrt(redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta);
    };
    const enqueueIfBackground = (pixelIndex) => {
        if (visited[pixelIndex] || distanceFromKey(pixelIndex) > 190) return;
        visited[pixelIndex] = 1;
        queue[tail++] = pixelIndex;
    };

    for (let x = 0; x < width; x++) {
        enqueueIfBackground(x);
        enqueueIfBackground((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
        enqueueIfBackground(y * width);
        enqueueIfBackground(y * width + width - 1);
    }

    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        if (x > 0) enqueueIfBackground(index - 1);
        if (x + 1 < width) enqueueIfBackground(index + 1);
        if (y > 0) enqueueIfBackground(index - width);
        if (y + 1 < height) enqueueIfBackground(index + width);
    }

    for (let index = 0; index < pixelCount; index++) {
        if (!visited[index]) continue;
        const distance = distanceFromKey(index);
        const alpha = distance <= 70 ? 0 : Math.round(Math.min(1, (distance - 70) / 120) * 255);
        data[index * channels + 3] = alpha;
    }

    return sharp(data, { raw: info }).png().trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
}

async function createPersonCutout(imageUrl) {
    if (REMOVE_BG_MODE === 'leonardo') {
        try {
            return await removeBackgroundWithLeonardo(imageUrl);
        } catch (error) {
            console.error(`⚠️ Leonardo 去背失敗，改用本機備援：${error.message}`);
        }
    }
    const imageBuffer = await downloadImageBuffer(imageUrl, 'AI 人物圖');
    return removeMagentaBackgroundLocally(imageBuffer);
}

async function resizeSvgLayer(filePath, options) {
    return sharp(filePath, { density: 216 }).resize(options).png().toBuffer();
}

async function compositeFixedScene(scene, personCutout) {
    const [ipLayer, boatLayer, personLayer] = await Promise.all([
        resizeSvgLayer(scene.ipPath, { height: scene.ipLayout.height, fit: 'inside' }),
        resizeSvgLayer(scene.boatPath, { width: scene.boatLayout.width, fit: 'inside' }),
        sharp(personCutout).resize({
            width: scene.personLayout.width,
            height: scene.personLayout.height,
            fit: 'contain',
            position: 'bottom',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        }).png().toBuffer()
    ]);

    const finalBuffer = await sharp(scene.backgroundPath, { density: 144 })
        .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT)
        .composite([
            { input: ipLayer, left: scene.ipLayout.left, top: scene.ipLayout.top },
            { input: personLayer, left: scene.personLayout.left, top: scene.personLayout.top },
            { input: boatLayer, left: scene.boatLayout.left, top: scene.boatLayout.top }
        ])
        .flatten({ background: '#fffdf8' })
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
        .toBuffer();

    return `data:image/jpeg;base64,${finalBuffer.toString('base64')}`;
}

async function finalizeGeneratedPerson(sceneId, imageUrl) {
    const scene = SCENES[sceneId];
    if (!scene) throw new Error(`未知的互動情境：${sceneId}`);
    const cutout = await createPersonCutout(imageUrl);
    return compositeFixedScene(scene, cutout);
}

async function requestLeonardoGeneration(model, styleId, prompt, guestImageId, sceneReferenceId, qStyleReferenceId) {
    const response = await fetch('https://cloud.leonardo.ai/api/rest/v2/generations', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'authorization': `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            model, public: false,
            parameters: {
                height: 1024, width: 1024, prompt_enhance: "OFF", quantity: 1, quality: "LOW",
                style_ids: [styleId], prompt,
                guidances: {
                    image_reference: [
                        { image: { id: guestImageId, type: "UPLOADED" }, strength: "MID" },
                        { image: { id: sceneReferenceId, type: "UPLOADED" }, strength: "LOW" },
                        { image: { id: qStyleReferenceId, type: "UPLOADED" }, strength: "HIGH" }
                    ]
                }
            }
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Leonardo 生圖請求失敗：${response.status}`);
    return data.generate?.generationId || data.generationId || data.sdGenerationJob?.generationId;
}

async function generateLeonardoDualStyles(taskId, base64Image, sceneId) {
    try {
        const scene = SCENES[sceneId];
        if (!scene) throw new Error(`未知的互動情境：${sceneId}`);
        const guestImageId = await uploadToLeonardoS3(base64Image);
        const sceneReferenceId = await getSceneReferenceId(sceneId);
        const qStyleReferenceId = await getQStyleReferenceId();
        console.log(`⚡ 啟動「${scene.name}」雙模型 Q 版人物生成，完成後再固定分層合成...`);

        const identityRules = "Reference 1 is the photographed guest and is the only identity reference. Preserve recognizable cues from the guest: hairstyle, hair color, glasses, clothing colors and accessories, but do not render a realistic adult face. Reference 2 is pose guidance only; follow its centered seated silhouette without copying its colors. Reference 3 is style only: copy its cute chibi proportions, simple facial language, textured outline and flat coloring, but never copy that reference person's identity, hairstyle, glasses or clothing.";
        const isolationRules = "Generate exactly one isolated human guest. Do not generate any mascot, animal, boat, vehicle, scenery, prop, logo, letters or extra person. Use one perfectly uniform solid pure magenta #FF00FF background from edge to edge, with no texture, gradient, shadow or floor. Keep a generous clear margin around the complete character. Hands must be small, simple and anatomically clean, with no extra fingers or duplicated limbs.";
        const promptA = `${identityRules} ${scene.composition} ${isolationRules} Transform the guest into an unmistakably super-cute chibi character with a very large round head, tiny compact body, about 2.5 heads tall, big simple oval black eyes, tiny nose and mouth, rosy cheeks, short simplified limbs, slightly thick hand-drawn crayon outlines, flat clean colors and almost no realistic shading. Match the original cute avatar style, not anime realism, watercolor portrait realism or photographic skin.`;
        const promptB = `${identityRules} ${scene.composition} ${isolationRules} Transform the guest into a recognizable chibi character about 3 heads tall. Keep more of the guest's face shape and personal features than version A while still using a large head, compact body, simple oval eyes, small nose and mouth, rosy cheeks, textured hand-drawn outlines, controlled flat colors and light paper texture. Match the original cute avatar style; avoid realistic facial rendering, realistic skin pores, long adult proportions and semi-photorealistic watercolor.`;

        const [genIdA, genIdB] = await Promise.all([
            requestLeonardoGeneration("gemini-2.5-flash-image", "6fedbf1f-4a17-45ec-84fb-92fe524a29ef", promptA, guestImageId, sceneReferenceId, qStyleReferenceId),
            requestLeonardoGeneration("gpt-image-2", "645e4195-f63d-4715-a3f2-3fb1e6eb8c70", promptB, guestImageId, sceneReferenceId, qStyleReferenceId)
        ]);

        if (!genIdA || !genIdB) { throw new Error("無法取得官方任務 ID。"); }

        console.log(`🎯 Leonardo 雙模生圖已在背景啟動！Job A: ${genIdA} | Job B: ${genIdB}`);
        pollAndSaveResults(taskId, genIdA, genIdB);

    } catch (err) {
        console.error(`❌ 自動化生圖失敗 (#${taskId}):`, err.message);
        if (localTasksCache[taskId]) {
            localTasksCache[taskId].remark = `失敗: ${err.message}`;
            if (useFirebase) updateDoc(doc(db, 'artifacts', appId, 'public', taskId), { remark: localTasksCache[taskId].remark });
        }
    }
}

async function pollAndSaveResults(taskId, genIdA, genIdB) {
    let resultA = null;
    let resultB = null;
    let rawUrlA = null;
    let rawUrlB = null;
    let attempts = 0;
    const maxAttempts = 180;
    const sceneId = localTasksCache[taskId]?.sceneId || 'digital-ark-green';

    while (attempts < maxAttempts && (!resultA || !resultB)) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
        try {
            if (!rawUrlA && resultA !== 'FAILED') {
                const resA = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${genIdA}`, { headers: { 'authorization': `Bearer ${LEONARDO_API_KEY}` } }).then(response => response.json());
                const jobA = resA.generations_by_pk;
                if (attempts === 1 || attempts % 5 === 0) console.log(`🔍 [進度轉播] #${taskId} 超 Q 人物狀態: ${jobA?.status || JSON.stringify(resA)}`);
                if (jobA?.status === 'COMPLETE' && jobA.generated_images?.length > 0) rawUrlA = jobA.generated_images[0].url;
                if (jobA?.status === 'FAILED') resultA = 'FAILED';
            }

            if (!rawUrlB && resultB !== 'FAILED') {
                const resB = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${genIdB}`, { headers: { 'authorization': `Bearer ${LEONARDO_API_KEY}` } }).then(response => response.json());
                const jobB = resB.generations_by_pk;
                if (attempts === 1 || attempts % 5 === 0) console.log(`🔍 [進度轉播] #${taskId} 相似 Q 人物狀態: ${jobB?.status || JSON.stringify(resB)}`);
                if (jobB?.status === 'COMPLETE' && jobB.generated_images?.length > 0) rawUrlB = jobB.generated_images[0].url;
                if (jobB?.status === 'FAILED') resultB = 'FAILED';
            }

            const finalizationJobs = [];
            if (rawUrlA && !resultA) {
                finalizationJobs.push(finalizeGeneratedPerson(sceneId, rawUrlA).then(image => {
                    resultA = image;
                    localTasksCache[taskId].resultImageA = image;
                    console.log(`✅ #${taskId} 超 Q 版已完成去背與固定 IP 分層合成`);
                }));
            }
            if (rawUrlB && !resultB) {
                finalizationJobs.push(finalizeGeneratedPerson(sceneId, rawUrlB).then(image => {
                    resultB = image;
                    localTasksCache[taskId].resultImageB = image;
                    console.log(`✅ #${taskId} 相似 Q 版已完成去背與固定 IP 分層合成`);
                }));
            }
            if (finalizationJobs.length > 0) await Promise.all(finalizationJobs);

            if (resultA && resultB && resultA !== 'FAILED' && resultB !== 'FAILED') {
                localTasksCache[taskId].status = 'completed';
                if (useFirebase) {
                    await updateDoc(doc(db, 'artifacts', appId, 'public', taskId), {
                        resultImageA: resultA,
                        resultImageB: resultB,
                        status: 'completed'
                    });
                }
                console.log(`🎉 號碼牌 #${taskId} 固定 IP 雙款合影完成！`);
                break;
            }
        } catch (error) {
            console.error(`⚠️ 輪詢或合成 #${taskId} 異常:`, error.message);
        }
    }

    if ((!resultA || !resultB) && resultA !== 'FAILED' && resultB !== 'FAILED') {
        console.log(`⏳ 號碼牌 #${taskId} 已等待超過 360 秒，轉交後台手動處理。`);
    }
}

app.post('/api/upload', async (req, res) => {
    try {
        const { image, sceneId = "digital-ark-green" } = req.body;
        if (!image) return res.status(400).json({ error: '未提供圖片資料' });
        const scene = SCENES[sceneId];
        if (!scene) return res.status(400).json({ error: '不支援的互動情境' });

        const taskId = String(ticketCounter).padStart(3, '0');
        ticketCounter++;

        const newTask = { id: taskId, sourceImage: image, sceneId, sceneName: scene.name, status: 'pending', resultImageA: null, resultImageB: null, chosenDesign: null, processStatus: '製作中', remark: '', createdAt: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) };
        localTasksCache[taskId] = newTask;
        if (useFirebase) await setDoc(doc(db, 'artifacts', appId, 'public', taskId), newTask);

        console.log(`🎫 新任務建立：排隊號碼 #${taskId}`);
        res.json({ success: true, taskId: taskId });

        if (LEONARDO_API_KEY) generateLeonardoDualStyles(taskId, image, sceneId);
    } catch (error) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/health', (_req, res) => {
    res.json({
        success: true,
        booth: 'B',
        layeredComposite: true,
        removeBgMode: REMOVE_BG_MODE,
        scenes: Object.keys(SCENES),
        firebase: useFirebase
    });
});

app.get('/api/status/:taskId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const taskId = req.params.taskId; let task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該號碼任務' });
    res.json({ success: true, status: task.status, resultImageA: task.resultImageA, resultImageB: task.resultImageB, chosenDesign: task.chosenDesign });
});

app.post('/api/choice/:taskId', async (req, res) => {
    const taskId = req.params.taskId; const { choice } = req.body; const task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該任務' });
    task.chosenDesign = choice;
    triggerFeiePrint(task);
    if (useFirebase) await updateDoc(doc(db, 'artifacts', appId, 'public', taskId), { chosenDesign: choice });
    res.json({ success: true });
});

app.get('/api/admin/all-tasks', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const all = Object.values(localTasksCache).sort((a, b) => a.id.localeCompare(b.id));

    if (req.query.lightweight === 'true') {
        const lightweightTasks = all.map(task => {
            const t = { ...task };
            t.hasSourceImage = !!t.sourceImage; delete t.sourceImage;
            t.hasResultImageA = !!t.resultImageA; if (t.resultImageA && t.resultImageA.startsWith('data:')) delete t.resultImageA;
            t.hasResultImageB = !!t.resultImageB; if (t.resultImageB && t.resultImageB.startsWith('data:')) delete t.resultImageB;
            return t;
        });
        return res.json({ success: true, tasks: lightweightTasks });
    }
    res.json({ success: true, tasks: all });
});

app.get('/api/admin/task-source-image/:taskId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const taskId = req.params.taskId; let task = localTasksCache[taskId];
    res.json({ success: true, sourceImage: task?.sourceImage });
});

app.get('/api/admin/task-result-images/:taskId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const taskId = req.params.taskId; let task = localTasksCache[taskId];
    res.json({ success: true, resultImageA: task?.resultImageA, resultImageB: task?.resultImageB });
});

app.post('/api/admin/upload-result-dual/:taskId', async (req, res) => {
    const taskId = req.params.taskId; const { resultImageA, resultImageB } = req.body; const task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該任務' });
    if (resultImageA) task.resultImageA = resultImageA; if (resultImageB) task.resultImageB = resultImageB;
    if (task.resultImageA && task.resultImageB) task.status = 'completed';
    if (useFirebase) await updateDoc(doc(db, 'artifacts', appId, 'public', taskId), { resultImageA: task.resultImageA, resultImageB: task.resultImageB, status: task.status });
    res.json({ success: true });
});

app.post('/api/admin/reset-all', async (req, res) => {
    try {
        localTasksCache = {}; ticketCounter = 1;
        if (useFirebase) {
            const querySnapshot = await getDocs(collection(db, 'artifacts', appId, 'public'));
            const deletePromises = [];
            querySnapshot.forEach((document) => { deletePromises.push(deleteDoc(doc(db, 'artifacts', appId, 'public', document.id))); });
            await Promise.all(deletePromises);
        }
        res.json({ success: true, message: "所有資料已重製" });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 🌟 新增：接收並儲存後台更改的「狀態」與「備註」
app.post('/api/admin/update-meta/:taskId', async (req, res) => {
    const taskId = req.params.taskId; 
    const { processStatus, remark } = req.body; 
    const task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該任務' });

    if (processStatus !== undefined) task.processStatus = processStatus;
    if (remark !== undefined) task.remark = remark;

    if (useFirebase) {
        try {
            await updateDoc(doc(db, 'artifacts', appId, 'public', taskId), { 
                processStatus: task.processStatus, 
                remark: task.remark 
            });
        } catch (e) { console.error("Firebase 更新狀態/備註失敗:", e); }
    }
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`🚀 雙重風格叫號伺服器運行中，監聽 PORT: ${PORT}`); });
