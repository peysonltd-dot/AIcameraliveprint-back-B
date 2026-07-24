/**
 * AI 互動雷雕拍照系統 - 後端 API (Firebase 雲端同步 & 飛鵝出票機防當機完全體版)
 * 🌟 終極上線版：包含極速記憶體快取、LOW 畫質生圖、完美出票排版，以及狀態備註同步儲存！
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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

async function uploadToLeonardoS3(base64Image) {
    try {
        const initUploadRes = await fetch('https://cloud.leonardo.ai/api/rest/v1/init-image', {
            method: 'POST', headers: { 'accept': 'application/json', 'authorization': `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ "extension": "jpg" })
        });
        if (!initUploadRes.ok) throw new Error(await initUploadRes.text());

        const uploadData = await initUploadRes.json();
        const { id, url, fields } = uploadData.uploadInitImage;
        const imageBuffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ""), 'base64');

        const formData = new FormData();
        Object.entries(JSON.parse(fields)).forEach(([key, value]) => { formData.append(key, value); });
        formData.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), 'image.jpg');

        const s3UploadRes = await fetch(url, { method: 'POST', body: formData });
        if (s3UploadRes.status >= 200 && s3UploadRes.status < 300) {
            console.log(`✅ 客人照片成功上傳 Leonardo S3! 取得 ID: ${id}`); return id;
        } else { throw new Error(`S3 上傳失敗: ${s3UploadRes.status}`); }
    } catch (err) { throw err; }
}

async function generateLeonardoDualStyles(taskId, base64Image) {
    try {
        const guestImageId = await uploadToLeonardoS3(base64Image);
        console.log(`⚡ 啟動 Promise.all 雙通道，對 Leonardo 併發雙模型生圖請求 (LOW Quality)...`);

        const promptA = "Please analyze the physical characteristics of the person in the photo I uploaded (including hairstyle, hair color, clothing style and color, whether they wear glasses or have any special accessories). Then, retain these personal characteristics and reshape it into a new image with the following specific style:\n\nDetailed Style Specifications:\n\nMain Style: Minimalist hand-drawn chibi avatar.\n\nLine Strokes: Slightly thick black outlines with a hand-drawn feel, and rough edges resembling crayon or pencil strokes.\n\nColor and Shadows: Simple, flat coloring without complex gradients or shadows.\n\nFacial Features: Extremely simplified facial features (e.g., round eyes, small nose), with two cute little wisps of light pink blush on the cheeks.\n\nBackground and Composition: Solid white clean background.";
        const promptB = "Please analyze the physical characteristics of the person in the photo I uploaded (including hairstyle, hair color, clothing style and color, whether they wear glasses or have any special accessories). Then, retain these personal characteristics and reshape it into a new image with the following specific style:\n\nDetailed Style Specifications:\n\nMain Style: Minimalist hand-drawn chibi avatar.\n\nLine Strokes: Slightly thick black outlines with a hand-drawn feel, and rough edges resembling crayon or pencil strokes.\n\nColor and Shadows: Simple, flat coloring without complex gradients or shadows.\n\nFacial Features: Extremely simplified facial features (e.g., bean eyes, small nose), with two cute little wisps of light pink blush on the cheeks.\n\nBackground and Composition: Solid white clean background.";

        const [genRequestA, genRequestB] = await Promise.all([
            fetch('https://cloud.leonardo.ai/api/rest/v2/generations', {
                method: 'POST', headers: { 'accept': 'application/json', 'authorization': `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    "model": "gemini-2.5-flash-image", "public": false,
                    "parameters": { "height": 1024, "width": 1024, "prompt_enhance": "OFF", "quantity": 1, "quality": "LOW", "style_ids": ["6fedbf1f-4a17-45ec-84fb-92fe524a29ef"], "prompt": promptA, "guidances": { "image_reference": [{ "image": { "id": guestImageId, "type": "UPLOADED" }, "strength": "MID" }] } }
                })
            }).then(r => r.json()),
            fetch('https://cloud.leonardo.ai/api/rest/v2/generations', {
                method: 'POST', headers: { 'accept': 'application/json', 'authorization': `Bearer ${LEONARDO_API_KEY}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    "model": "gpt-image-2", "public": false,
                    "parameters": { "height": 1024, "width": 1024, "prompt_enhance": "OFF", "quantity": 1, "quality": "LOW", "style_ids": ["645e4195-f63d-4715-a3f2-3fb1e6eb8c70"], "prompt": promptB, "guidances": { "image_reference": [{ "image": { "id": guestImageId, "type": "UPLOADED" }, "strength": "MID" }] } }
                })
            }).then(r => r.json())
        ]);

        const genIdA = genRequestA.generate?.generationId || genRequestA.generationId || genRequestA.sdGenerationJob?.generationId;
        const genIdB = genRequestB.generate?.generationId || genRequestB.generationId || genRequestB.sdGenerationJob?.generationId;

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
        const { image } = req.body;
        if (!image) return res.status(400).json({ error: '未提供圖片資料' });

        const taskId = String(ticketCounter).padStart(3, '0');
        ticketCounter++;

        const newTask = { id: taskId, sourceImage: image, status: 'pending', resultImageA: null, resultImageB: null, chosenDesign: null, processStatus: '製作中', remark: '', createdAt: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) };
        localTasksCache[taskId] = newTask;
        if (useFirebase) await setDoc(doc(db, 'artifacts', appId, 'public', taskId), newTask);

        console.log(`🎫 新任務建立：排隊號碼 #${taskId}`);
        res.json({ success: true, taskId: taskId });

        if (LEONARDO_API_KEY) generateLeonardoDualStyles(taskId, image);
    } catch (error) { res.status(500).json({ error: '伺服器錯誤' }); }
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
