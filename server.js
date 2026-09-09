/**
 * AI 互動雷雕拍照系統 - 後端 API (Firebase 雲端同步 & 飛鵝出票機防當機完全體版)
 * 🌟 終極上線版：包含極速記憶體快取、LOW 畫質生圖、完美出票排版，以及狀態備註同步儲存！
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
const SCENES = {
    "digital-ark-green": {
        name: "與綠色 IP 共乘數位方舟",
        referencePath: path.join(__dirname, "assets", "test-scene-reference.jpg"),
        composition: "Create one friendly group portrait inside the same colorful digital ark. The photographed guest sits on the left and the approved green-and-cream education mascot sits on the right. They are close companions, face the camera and smile. Keep their bodies clearly separated: no handshake, no high-five, no interlocked fingers and no merged limbs. Preserve the ark's teal, navy, cream, yellow and orange circuit-board design and the airy blue watercolor splash atmosphere."
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

async function requestLeonardoGeneration(model, styleId, prompt, guestImageId, sceneReferenceId, qStyleReferenceId) {
    const response = await fetch('https://cloud.leonardo.ai/api/rest/v2/generations', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'authorization': `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            model, public: false,
            parameters: {
                height: 768, width: 1024, prompt_enhance: "OFF", quantity: 1, quality: "LOW",
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
        console.log(`⚡ 啟動「${scene.name}」雙模型互動合影生成...`);

        const identityRules = "Reference 1 is the photographed guest and is the only identity reference. Preserve recognizable cues from the guest: hairstyle, hair color, glasses, clothing colors and accessories, but do not render a realistic adult face. Reference 2 is only the approved digital ark, green mascot and composition reference. Replace its sample human completely; never copy that person's face, cap, glasses, backpack, body proportions or printed shirt. Reference 3 is style only: copy its cute chibi proportions, simple facial language, textured outline and flat coloring, but never copy that reference person's identity, hairstyle, glasses or clothing. Show exactly one human guest and exactly one green-and-cream mascot. Do not invent extra people, mascots, text or logos.";
        const safetyRules = "Keep the guest and mascot close and friendly but physically separate. No handshake, high-five, interlocked fingers, hugging, merged limbs, extra fingers or duplicated body parts. Keep hands small, simple and clearly visible. Balanced 4:3 souvenir photo composition.";
        const promptA = `${identityRules} ${scene.composition} ${safetyRules} Transform the guest into an unmistakably super-cute chibi character with a very large round head, tiny compact seated body, about 2.5 heads tall, big simple oval black eyes, tiny nose and mouth, rosy cheeks, short simplified limbs, slightly thick hand-drawn crayon outlines, flat clean colors and almost no realistic shading. Match the original cute avatar style, not anime realism, not watercolor portrait realism and not photographic skin.`;
        const promptB = `${identityRules} ${scene.composition} ${safetyRules} Transform the guest into a recognizable chibi character about 3 heads tall. Keep more of the guest's face shape and personal features than version A while still using a large head, compact body, simple oval eyes, small nose and mouth, rosy cheeks, textured hand-drawn outlines, controlled flat colors and light paper texture. Match the original cute avatar style; avoid realistic facial rendering, realistic skin pores, long adult proportions and semi-photorealistic watercolor.`;

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
    let resultA = null; let resultB = null; let attempts = 0; const maxAttempts = 180; 
    while (attempts < maxAttempts && (!resultA || !resultB)) {
        await new Promise(r => setTimeout(r, 2000)); attempts++;
        try {
            if (!resultA) {
                const resA = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${genIdA}`, { headers: { 'authorization': `Bearer ${LEONARDO_API_KEY}` } }).then(r => r.json());
                const jobA = resA.generations_by_pk;
                if (attempts === 1 || attempts % 5 === 0) console.log(`🔍 [進度轉播] #${taskId} A款目前狀態: ${jobA?.status || JSON.stringify(resA)}`);
                if (jobA && jobA.status === "COMPLETE" && jobA.generated_images && jobA.generated_images.length > 0) {
                    resultA = jobA.generated_images[0].url; localTasksCache[taskId].resultImageA = resultA;
                } else if (jobA && jobA.status === "FAILED") {
                    console.log(`❌ [警告] #${taskId} A款被官方退件 (FAILED)`); resultA = "FAILED";
                }
            }
            if (!resultB) {
                const resB = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${genIdB}`, { headers: { 'authorization': `Bearer ${LEONARDO_API_KEY}` } }).then(r => r.json());
                const jobB = resB.generations_by_pk;
                if (attempts === 1 || attempts % 5 === 0) console.log(`🔍 [進度轉播] #${taskId} B款目前狀態: ${jobB?.status || JSON.stringify(resB)}`);
                if (jobB && jobB.status === "COMPLETE" && jobB.generated_images && jobB.generated_images.length > 0) {
                    resultB = jobB.generated_images[0].url; localTasksCache[taskId].resultImageB = resultB;
                } else if (jobB && jobB.status === "FAILED") {
                    console.log(`❌ [警告] #${taskId} B款被官方退件 (FAILED)`); resultB = "FAILED";
                }
            }
            if (resultA && resultB && resultA !== "FAILED" && resultB !== "FAILED") {
                localTasksCache[taskId].status = 'completed';
                if (useFirebase) await updateDoc(doc(db, 'artifacts', appId, 'public', taskId), { resultImageA: resultA, resultImageB: resultB, status: 'completed' });
                console.log(`🎉 號碼牌 #${taskId} 雙風格全自動生成成功並同步完畢！`);
                break;
            }
        } catch (e) { console.error(`⚠️ 輪詢 #${taskId} 異常:`, e.message); }
    }
    if ((!resultA || !resultB) && resultA !== "FAILED" && resultB !== "FAILED") {
        console.log(`⏳ 號碼牌 #${taskId} 已等待超過 360 秒（6分鐘），官方可能塞車，轉交手動後台接手。`);
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
    res.json({ success: true, booth: 'B', scenes: Object.keys(SCENES), firebase: useFirebase });
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
