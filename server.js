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
const REMOVE_BG_MODE = "local-chroma";
const OUTPUT_WIDTH = 1024;
const OUTPUT_HEIGHT = 768;
const PRINT_MARGIN = 0.08;
const CATALOG = require('./assets/ip-catalog.json');
const SCENES = Object.fromEntries(CATALOG.map(ip => [ip.id, {
    name: ip.name.zh,
    description: ip.description,
    referencePath: path.join(__dirname, 'assets', 'test-scene-reference.jpg'),
    ipPath: path.join(__dirname, ip.preview),
    boatPath: path.join(__dirname, 'assets', 'layers', 'digital-ark-green', 'boat.svg'),
    composition: `One photographed guest on the left and exactly one selected mascot on the right sit TOGETHER INSIDE ONE digital ark boat. Selected character: ${ip.description}. The guest faces the camera, leans toward the mascot and gently places an arm around its shoulder, keeping the mascot's original accessories. Integrate both bodies into the same cockpit, with the hull naturally occluding their lower bodies. Show the entire head, complete mascot silhouette, complete boat and surrounding water splash cluster. Natural hands, no limbs hanging outside, no second boat.`
}]));
const Q_STYLE_REFERENCE_PATH = path.join(__dirname, "assets", "q-style-reference.jpg");
const referenceCache = new Map();

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

function decodePhoto(value) {
    const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value || '');
    if (!match) throw new Error('請提供 JPG、PNG 或 WebP 照片');
    return Buffer.from(match[1], 'base64');
}
async function uploadBufferToLeonardoS3(buffer) {
    const headers = { authorization: `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' };
    const response = await fetch('https://cloud.leonardo.ai/api/rest/v1/init-image', {
        method: 'POST', headers, signal: AbortSignal.timeout(30000), body: JSON.stringify({ extension: 'jpg' })
    });
    if (!response.ok) throw new Error(`Leonardo 上傳初始化失敗：${response.status}`);
    const { uploadInitImage } = await response.json();
    const { id, url, fields } = uploadInitImage || {};
    if (!id || !url || !fields) throw new Error('Leonardo 未回傳上傳位置');
    const form = new FormData();
    Object.entries(typeof fields === 'string' ? JSON.parse(fields) : fields).forEach(([key,value]) => form.append(key,value));
    form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'reference.jpg');
    const uploaded = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (!uploaded.ok) throw new Error(`參考圖上傳失敗：${uploaded.status}`);
    return id;
}
async function downloadImageBuffer(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`圖片下載失敗：${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function artworkReference(file) {
    // Rasterize the supplied vector without distorting its proportions.
    return sharp(file, { density: 144 }).resize(1024, 1024, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 95 }).toBuffer();
}
const { preparePrintPng } = require('./print-image');
async function finalizeFullScene(buffer) {
    const result = await preparePrintPng(buffer, { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, margin: PRINT_MARGIN });
    return `data:image/png;base64,${result.toString('base64')}`;
}
function fullScenePrompt(scene, watercolor) {
    return [
        'Create ONE complete finished event illustration. Redraw the guest, the official mascot, the boat and the background together as a coherent scene, NOT as separate cutout stickers.',
        'REFERENCE PRIORITY: Reference 1 is the photographed guest and the ONLY human identity source. Preserve recognizable hairstyle, hair color, face shape, glasses, clothing colors and accessories. Never copy the person in any other reference.',
        'Reference 2 is the AUTHORITATIVE OFFICIAL MASCOT DESIGN. Faithfully reproduce its silhouette, body proportions, ear shapes, face and mouth shapes, eye positions, exact original color regions, cheek placement and only the original accessories visible in reference 2. Do not redesign, humanize, add costume, hat, extra ears, fingers or a new face. Keep its original visual identity even when adapting the guest drawing style.',
        'Reference 3 is the AUTHORITATIVE BOAT DESIGN: retain the hull silhouette, teal/navy/cream/orange/yellow palette, circuit motifs, front emblem and rail arrangement. Exactly ONE boat in the entire image.',
        'Reference 4 is COMPOSITION and atmosphere ONLY: a close, friendly shared ride with a visible smiling guest. Ignore its sample human identity and any altered mascot, hat, logo or accessory. Where it conflicts with reference 2 or 3, the official reference 2 or 3 ALWAYS takes priority.',
        'Reference 5 is GUEST DRAWING STYLE ONLY: never copy its identity, clothing, props, mascot or text.',
        scene.composition,
        watercolor
            ? 'GUEST STYLE: customer watercolor illustration, approximately four-head-tall proportions, natural smiling eyes, recognizable face, fine ink outlines, soft watercolor shading and light paper grain. Avoid photographic skin and oversized black chibi eyes.'
            : 'GUEST STYLE: super cute minimalist hand-drawn chibi, approximately 2.5-head-tall proportions, a large round head, simple oval black eyes, tiny nose and mouth, rosy cheeks, textured crayon outlines, compact limbs and flat colors. Not realistic adult proportions.',
        'PRINT CUTOUT COMPOSITION: the artwork is one complete island of guest, selected mascot, boat, blue/aqua water and water splashes. Retain blue water and solid white foam as part of the drawing. Outside that cluster use ONLY uniform pure magenta #FF00FF with no paper, rectangular color wash, gradient, scenery or shadow. The magenta will be removed by software. Never use that exact key color inside the artwork.',
        'ZOOM OUT. Leave at least 12 percent clear magenta margin on ALL FOUR SIDES, including around stray droplets, ears, hats, staff, telescope, hair and the bottommost wave. Fit the ENTIRE artwork within the central 76 percent of the canvas. Nothing may touch the image boundary. Never crop the boat, head, mascot accessories or splashes. Keep the camera perspective harmonious and both figures seated inside the hull.',
        'Exactly one human, one selected mascot from reference 2 and one boat. Do not include the green example mascot unless the selected reference 2 is green. No extra mascot, boat, chair, duplicate limb, pasted-on portrait, collage border, caption, invented lettering or event logo. Keep important characters and the hull within the 4:3 landscape frame.',
        'Final visual priority: recognizable guest; faithful official mascot and boat designs; natural shared seating and shoulder interaction; consistent overall illustration.'
    ].join(' ');
}
async function getReference(key, makeBuffer) {
    if (!referenceCache.has(key)) referenceCache.set(key,
        makeBuffer().then(uploadBufferToLeonardoS3).catch(error => { referenceCache.delete(key); throw error; }));
    return referenceCache.get(key);
}
function leonardoPayload(model, prompt, ids) {
    const parameters = {
        width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, quantity: 1, prompt, prompt_enhance: 'OFF',
        guidances: { image_reference: ids.map((id, i) => ({
            image: { id, type: 'UPLOADED' },
            ...(model === 'gemini-2.5-flash-image' ? { strength: i === 3 ? 'LOW' : i === 4 ? 'MID' : 'HIGH' } : {})
        })) }
    };
    if (model === 'gpt-image-2') parameters.quality = 'LOW';
    return { model, public: false, parameters };
}
async function requestGeneration(payload) {
    // Billable POSTs are never retried automatically, including unknown timeout outcomes.
    const response = await fetch('https://cloud.leonardo.ai/api/rest/v2/generations', {
        method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { authorization: `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Leonardo 生圖請求失敗：${response.status}`);
    const id = data.generate?.generationId || data.generationId || data.sdGenerationJob?.generationId;
    if (!id) throw new Error('Leonardo 未回傳任務 ID，請查詢帳戶紀錄再重試');
    return id;
}
async function saveGenerationState(task) {
    if (useFirebase) await updateDoc(doc(db, 'artifacts', appId, 'public', task.id), {
        status: task.status, remark: task.remark,
        generationIdA: task.generationIdA || null, generationIdB: task.generationIdB || null,
        originalGenerationUrlA: task.originalGenerationUrlA || null, originalGenerationUrlB: task.originalGenerationUrlB || null,
        resultImageA: task.resultImageA, resultImageB: task.resultImageB
    }).catch(error => console.error('生成資料雲端同步失敗:', error.message));
}
async function runStyle(task, guestId, styleKey) {
    const scene = SCENES[task.sceneId];
    const watercolor = styleKey === 'watercolor';
    const suffix = watercolor ? 'A' : 'B';
    const [ipId, boatId, compositionId, styleId] = await Promise.all([
        getReference(`${task.sceneId}-official-ip-v8`, () => artworkReference(scene.ipPath)),
        getReference(`${task.sceneId}-official-boat-v8`, () => artworkReference(scene.boatPath)),
        getReference(`${task.sceneId}-composition-v8`, () => fs.promises.readFile(scene.referencePath)),
        getReference(`guest-style-${styleKey}-v8`, async () => watercolor
            ? sharp(scene.referencePath).extract({ left: 105, top: 0, width: 430, height: 455 })
                .resize(768, 768, { fit: 'contain', background: '#fffdf8' }).jpeg({ quality: 92 }).toBuffer()
            : fs.promises.readFile(Q_STYLE_REFERENCE_PATH))
    ]);
    const prompt = fullScenePrompt(scene, watercolor);
    const id = await requestGeneration(leonardoPayload(watercolor ? 'gemini-2.5-flash-image' : 'gpt-image-2', prompt,
        [guestId, ipId, boatId, compositionId, styleId]));
    task[`generationId${suffix}`] = id;
    await saveGenerationState(task);
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        let response;
        try {
            response = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${id}`, {
                signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${LEONARDO_API_KEY}` }
            });
        } catch { continue; }
        if (response.status === 429 || response.status >= 500) continue;
        if (!response.ok) throw new Error(`查詢任務 ${id} 失敗：${response.status}`);
        const job = (await response.json()).generations_by_pk;
        if (['FAILED','CANCELED','CANCELLED'].includes(job?.status)) throw new Error(`Leonardo 任務失敗：${id}`);
        if (job?.status === 'COMPLETE') {
            const url = job.generated_images?.[0]?.url;
            if (!url) throw new Error(`任務 ${id} 未回傳圖片`);
            task[`originalGenerationUrl${suffix}`] = url;
            task[`resultImage${suffix}`] = await finalizeFullScene(await downloadImageBuffer(url));
            await saveGenerationState(task);
            return;
        }
    }
    throw new Error(`等待超時，請查 Leonardo 任務 ${id}；沒有自動重送付費生成`);
}
async function generateLeonardoDualStyles(taskId, guestBuffer) {
    const task = localTasksCache[taskId];
    try {
        const guestId = await uploadBufferToLeonardoS3(guestBuffer);
        const results = await Promise.allSettled([
            runStyle(task, guestId, 'watercolor'), runStyle(task, guestId, 'chibi')
        ]);
        const errors = results.flatMap((r, i) => r.status === 'rejected'
            ? [`${i === 0 ? '水彩版' : '超 Q 版'}：${r.reason.message}`] : []);
        task.status = errors.length ? 'failed' : 'completed';
        task.remark = errors.join('；');
    } catch (error) {
        task.status = 'failed';
        task.remark = `失敗：${error.message}。請先查 Leonardo 紀錄再重送。`;
    }
    await saveGenerationState(task);
}

app.post('/api/upload', async (req, res) => {
    try {
        const { image, sceneId = "digital-ark-green" } = req.body;
        if (!LEONARDO_API_KEY) return res.status(503).json({ error: 'B 機尚未設定 LEONARDO_API_KEY' });
        let guestBuffer;
        try { guestBuffer = await sharp(decodePhoto(image), { limitInputPixels: 40000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer(); }
        catch { return res.status(400).json({ error: '照片格式無法讀取，請重新拍攝' }); }
        const scene = SCENES[sceneId];
        if (!scene) return res.status(400).json({ error: '不支援的互動情境' });

        const taskId = String(ticketCounter).padStart(3, '0');
        ticketCounter++;

        const newTask = { id: taskId, sourceImage: image, sceneId, sceneName: scene.name, status: 'pending', resultImageA: null, resultImageB: null, chosenDesign: null, processStatus: '製作中', remark: '', styleAName: '水彩互動版', styleBName: '超 Q 互動版', createdAt: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) };
        localTasksCache[taskId] = newTask;
        if (useFirebase) await setDoc(doc(db, 'artifacts', appId, 'public', taskId), newTask);

        console.log(`🎫 新任務建立：排隊號碼 #${taskId}`);
        res.json({ success: true, taskId: taskId });

        generateLeonardoDualStyles(taskId, guestBuffer);
    } catch (error) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/scenes', (_req, res) => res.json({ success: true, scenes: CATALOG.map(({id,name,preview}) => ({id,name,preview})) }));

app.get('/health', (_req, res) => {
    res.json({
        success: true,
        booth: 'B',
        pipelineVersion: 'leonardo-multi-ip-print-v8',
        imageProvider: 'leonardo-full-scene',
        imageProviderConfigured: !!LEONARDO_API_KEY,
        modelSideMask: false,
        liveGenerationValidated: false,
        printFormat: "image/png",
        printMargin: PRINT_MARGIN,
        styles: ['水彩互動版', '超 Q 互動版'],
        layeredComposite: false,
        removeBgMode: REMOVE_BG_MODE,
        scenes: Object.keys(SCENES),
        firebase: useFirebase
    });
});

app.get('/api/status/:taskId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const taskId = req.params.taskId; let task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該號碼任務' });
    res.json({ success: true, status: task.status, resultImageA: task.resultImageA, resultImageB: task.resultImageB, chosenDesign: task.chosenDesign, error: task.status === 'failed' ? task.remark : null });
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

if (require.main === module) {
    app.listen(PORT, () => { console.log(`🚀 雙重風格叫號伺服器運行中，監聽 PORT: ${PORT}`); });
}

module.exports = {
    app,
    testHelpers: {
        SCENES,
        finalizeFullScene,
        fullScenePrompt,
        leonardoPayload
    }
};
