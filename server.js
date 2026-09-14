/**
 * AI 互動雷雕拍照系統 - 後端 API (Firebase 雲端同步 & 飛鵝出票機防當機完全體版)
 * 🌟 終極上線版：包含極速記憶體快取、LOW 畫質生圖、完美出票排版，以及狀態備註同步儲存！
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createAdminAuth } = require('./admin-auth');
const sharp = require('sharp');
const { configuredCloudStore } = require('./cloud-store');

function createApp({ cloud: suppliedCloud } = {}) {
const app = express();

app.use(cors());
app.use('/api/admin', createAdminAuth());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

let localTasksCache = {};
let ticketCounter = 1;
let cloudReady = false;
let startupError = '';
const retryTimers = new Map();
const confirmations = new Set();
let resetting = false;

const appId = (process.env.APP_ID || "photo-booth-app").trim();
const cloud = suppliedCloud || configuredCloudStore(appId);
const LEONARDO_API_KEY = (process.env.LEONARDO_API_KEY || "").trim();
const REMOVE_BG_MODE = "local-white";
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

// 僅在開機時載入一次歷史紀錄與續接流水號
async function syncTicketCounterFromCloud() {
    try {
        const records = await cloud.load();
        let maxId = 0;
        records.forEach(record => {
            if (!/^\d{3,}$/.test(record.id)) return;
            const idNum = parseInt(record.id, 10);
            if (!isNaN(idNum) && idNum > maxId) maxId = idNum;
            record.cloudStatus ||= 'legacy';
            // Never repeat a billable job after restart. Allow recovery of the retained original URL.
            if (record.status === 'pending') {
                record.status = record.resultImageB ? 'completed' : 'failed';
                record.remark = [record.remark, '服務重啟中斷任務；請檢查已有圖片或 Leonardo 任務紀錄，沒有自動重新產圖。'].filter(Boolean).join('；');
            }
            localTasksCache[record.id] = record;
        });
        ticketCounter = maxId + 1;
        cloudReady = true;
        console.log(`🎯 流水號續接成功！下一位：#${String(ticketCounter).padStart(3, '0')}`);
    } catch (e) { startupError = '歷史訂單讀取失敗，為避免號碼重複，暫停接收新任務；請檢查資料庫權限後重新啟動。'; console.error(startupError); }
}
const ready = syncTicketCounterFromCloud();

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
const { preparePrintResult } = require('./print-image');
async function finalizeFullScene(buffer) {
    const result = await preparePrintResult(buffer, { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, margin: PRINT_MARGIN });
    return { image: `data:${result.mime};base64,${result.buffer.toString('base64')}`, printStatus: result.printStatus, warning: result.warning };
}
function updateTaskOutcome(task, errors=[]) {
    const available = Number(!!task.resultImageA)+Number(!!task.resultImageB);
    task.status = task.styleMode === 'chibi-only' ? (task.resultImageB ? 'completed' : 'failed') : (available === 2 ? 'completed' : available === 1 ? 'partial' : 'failed');
    const warnings=['A','B'].flatMap(s => task[`printWarning${s}`] ? [`${s}款：${task[`printWarning${s}`]}`] : []);
    task.remark=[...errors,...warnings].join('；');
}
function assignPrintResult(task,suffix,result) {
    task[`resultImage${suffix}`]=result.image;
    task[`printStatus${suffix}`]=result.printStatus;
    task[`printWarning${suffix}`]=result.warning;
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
        'PRINT CUTOUT COMPOSITION: the artwork is one complete island of guest, selected mascot, boat, blue/aqua water and water splashes. Retain blue water and solid white foam as part of the drawing. Outside that cluster use ONLY uniform pure white #FFFFFF with no paper texture, rectangular color wash, gradient, scenery, shadow or checkerboard. Do not add a pink or magenta backdrop, glow or outline. Keep the original white mascot regions, white clothing and solid white foam; distinguish their outer edges from the white backdrop with the existing subtle illustration outlines. Do not recolor white artwork to make the background removable.',
        'ZOOM OUT. Leave at least 12 percent clear white margin on ALL FOUR SIDES, including around stray droplets, ears, hats, staff, telescope, hair and the bottommost wave. Fit the ENTIRE artwork within the central 76 percent of the canvas. Nothing may touch the image boundary. Never crop the boat, head, mascot accessories or splashes. Keep the camera perspective harmonious and both figures seated inside the hull.',
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
async function saveGenerationState(task, retries = 2) {
    if (resetting || localTasksCache[task.id] !== task) return false;
    clearTimeout(retryTimers.get(task.id)); retryTimers.delete(task.id);
    let saved = false;
    try { saved = await cloud.save(task); }
    catch (_) { task.cloudStatus = 'failed'; task.cloudError = '雲端儲存未設定，請先完成 Storage 設定。'; }
    if (!saved) {
        console.error(`雲端保存失敗 #${task.id}：${task.cloudError}`);
        if (retries > 0 && cloud.configured) {
            const timer = setTimeout(() => saveGenerationState(task, retries - 1), retries === 2 ? 3000 : 10000);
            timer.unref?.(); retryTimers.set(task.id, timer);
        }
    }
    return saved;
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
            // Save the recovery URL before local PNG processing. No paid generation is repeated on recovery.
            await saveGenerationState(task);
            assignPrintResult(task, suffix, await finalizeFullScene(await downloadImageBuffer(url)));
            return;
        }
    }
    throw new Error(`等待超時，請查 Leonardo 任務 ${id}；沒有自動重送付費生成`);
}
async function generateLeonardoChibi(taskId, guestBuffer) {
    const task = localTasksCache[taskId];
    try {
        const guestId = await uploadBufferToLeonardoS3(guestBuffer);
        await runStyle(task, guestId, 'chibi');
        updateTaskOutcome(task);
    } catch (error) {
        task.status = 'failed';
        task.remark = `失敗：${error.message}。請先查 Leonardo 紀錄再重送。`;
    }
    await saveGenerationState(task);
}

// Reprocess a known task's existing originals only. Never starts billable image generation.
app.post('/api/admin/reprocess/:taskId', async (req,res) => {
    const task=localTasksCache[req.params.taskId];
    if(!task)return res.status(404).json({error:'找不到任務'});
    if(resetting || confirmations.has(task.id))return res.status(409).json({error:'任務正在送出，請稍候'});
    if(task.reprocessing || task.status==='pending')return res.status(409).json({error:'任務仍在處理中'});
    const sides=(task.styleMode === 'chibi-only' ? ['B'] : ['A','B']).filter(s=>task[`originalGenerationUrl${s}`]);
    if(!sides.length)return res.status(400).json({error:'沒有保留的生成原圖，請從 Leonardo 下載後補傳'});
    task.reprocessing=true;
    try {
        const results=await Promise.allSettled(sides.map(async s=>assignPrintResult(task,s,await finalizeFullScene(await downloadImageBuffer(task[`originalGenerationUrl${s}`])))));
        const errors=results.flatMap((r,i)=>r.status==='rejected'?[`${sides[i]}款原圖處理失敗：${r.reason.message}`]:[]);
        updateTaskOutcome(task,errors); const saved=await saveGenerationState(task);
        res.status(saved?200:503).json({success:saved,status:task.status,warning:task.remark,error:saved?null:task.cloudError});
    } finally { task.reprocessing=false; }
});

app.post('/api/upload', async (req, res) => {
    try {
        const { image, sceneId = "digital-ark-green" } = req.body;
        if (!LEONARDO_API_KEY) return res.status(503).json({ error: 'B 機尚未設定 LEONARDO_API_KEY' });
        let guestBuffer;
        try { guestBuffer = await sharp(decodePhoto(image), { limitInputPixels: 40000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer(); }
        catch { return res.status(400).json({ error: '照片格式無法讀取，請重新拍攝' }); }
        const scene = SCENES[sceneId];
        if (!scene) return res.status(400).json({ error: '不支援的互動情境' });
        await ready;
        if (resetting || !cloudReady || !cloud.configured) return res.status(503).json({ error: '圖片儲存服務尚未就緒，請工作人員確認設定後再試。' });

        const taskId = String(ticketCounter).padStart(3, '0');
        ticketCounter++;

        const newTask = { id: taskId, sourceImage: image, sceneId, sceneName: scene.name, styleMode: 'chibi-only', status: 'pending', resultImageA: null, resultImageB: null, chosenDesign: null, processStatus: '製作中', remark: '', styleBName: '合影', createdAt: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) };
        localTasksCache[taskId] = newTask;
        // Persist the source before the billable generation starts.
        if (!await saveGenerationState(newTask, 0)) {
            newTask.status = 'failed'; newTask.remark = '原照未保存，沒有呼叫付費產圖。';
            return res.status(503).json({ error: '照片尚未成功保存，請稍後重試；本次沒有進行 AI 產圖。' });
        }

        console.log(`🎫 新任務建立：排隊號碼 #${taskId}`);
        res.json({ success: true, taskId: taskId });

        generateLeonardoChibi(taskId, guestBuffer);
    } catch (error) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/scenes', (_req, res) => res.json({ success: true, scenes: CATALOG.map(({id,name,preview}) => ({id,name,preview})) }));

app.get('/health', (_req, res) => {
    res.json({
        success: true,
        booth: 'B',
        adminAuthVersion: 'v16',
        pipelineVersion: 'leonardo-chibi-print-v13',
        imageProvider: 'leonardo-full-scene',
        imageProviderConfigured: !!LEONARDO_API_KEY,
        modelSideMask: false,
        liveGenerationValidated: false,
        printFormat: "image/png",
        printMargin: PRINT_MARGIN,
        styles: ['chibi'],
        generationsPerGuest: 1,
        layeredComposite: false,
        removeBgMode: REMOVE_BG_MODE,
        scenes: Object.keys(SCENES),
        firebase: cloud.hasMetadata,
        storageVersion: 'v19',
        storageConfigured: cloud.configured,
        ordersLoaded: cloudReady,
        acceptingUploads: cloudReady && cloud.configured && !resetting
    });
});

app.get('/api/status/:taskId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    await ready;
    if (!cloudReady) return res.status(503).json({ error: '訂單正在恢復，請稍後再試' });
    const taskId = req.params.taskId; let task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該號碼任務' });
    res.json({ success: true, status: task.status, resultImageA: task.resultImageA, resultImageB: task.resultImageB, chosenDesign: task.chosenDesign, error: ['failed','partial'].includes(task.status) ? task.remark : null, printStatusA: task.printStatusA, printStatusB: task.printStatusB, cloudStatus: task.cloudStatus });
});

app.post('/api/choice/:taskId', async (req, res) => {
    const taskId = req.params.taskId; const { choice } = req.body; const task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該任務' });
    if (!['A','B'].includes(choice) || !task[`resultImage${choice}`]) return res.status(400).json({ error: '這款圖片尚未完成，請選擇已完成的款式' });
    if (task.styleMode === 'chibi-only' && choice !== 'B') return res.status(400).json({ error: '請確認本次合影' });
    if (task.reprocessing || task.status === 'pending') return res.status(409).json({ error: '圖片仍在處理中，請稍候再送出' });
    if (resetting || confirmations.has(taskId)) return res.status(409).json({ error: '正在送出，請稍候' });
    // Guest confirmation does not certify print quality; preserve printStatus and warnings for staff.
    confirmations.add(taskId);
    const previousChoice = task.chosenDesign;
    try {
        if (!await saveGenerationState(task)) return res.status(503).json({ error: '合影尚未保存完成，請稍後再按確定；圖片仍可預覽。' });
        task.chosenDesign = choice;
        if (!await saveGenerationState(task, 0)) {
            task.chosenDesign = previousChoice;
            return res.status(503).json({ error: '確認資料尚未保存，請再按一次確定。' });
        }
        if (!previousChoice) triggerFeiePrint(task);
        res.json({ success: true });
    } finally { confirmations.delete(taskId); }
});

app.get('/api/admin/all-tasks', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    await ready;
    if (!cloudReady) return res.status(503).json({ success: false, error: startupError });
    const all = Object.values(localTasksCache).sort((a, b) => a.id.localeCompare(b.id));

    if (req.query.lightweight === 'true') {
        const lightweightTasks = all.map(task => {
            const t = { ...task };
            t.hasSourceImage = !!(t.sourceImage || t.sourceImageFile); delete t.sourceImage;
            t.hasResultImageA = !!t.resultImageA; if (t.resultImageA && t.resultImageA.startsWith('data:')) delete t.resultImageA;
            t.hasResultImageB = !!t.resultImageB; if (t.resultImageB && t.resultImageB.startsWith('data:')) delete t.resultImageB;
            return t;
        });
        return res.json({ success: true, tasks: lightweightTasks, storageConfigured: cloud.configured, storageError: cloud.configurationError });
    }
    res.json({ success: true, tasks: all });
});

app.get('/api/admin/task-source-image/:taskId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const taskId = req.params.taskId; let task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該任務' });
    try {
        const { buffer, mime } = await cloud.readImage(task, 'sourceImage');
        res.json({ success: true, sourceImage: `data:${mime};base64,${buffer.toString('base64')}` });
    } catch (_) { res.status(503).json({ error: '原照讀取失敗，請稍後重試' }); }
});

app.post('/api/admin/retry-save/:taskId', async (req, res) => {
    const task = localTasksCache[req.params.taskId];
    if (!task) return res.status(404).json({ error: '找不到該任務' });
    if (resetting || task.reprocessing || task.status === 'pending' || confirmations.has(task.id)) return res.status(409).json({ error: '任務仍在處理中' });
    const saved = await saveGenerationState(task);
    res.status(saved ? 200 : 503).json({ success: saved, cloudStatus: task.cloudStatus, error: saved ? null : task.cloudError });
});

// An authenticated byte download keeps PNG filenames and transparency with remote URLs too.
app.get('/api/admin/download/:taskId/:side', async (req, res) => {
    const task = localTasksCache[req.params.taskId], side = req.params.side;
    if (!task || !['A', 'B'].includes(side)) return res.status(404).json({ error: '找不到圖片' });
    try {
        const { buffer, mime } = await cloud.readImage(task, `resultImage${side}`);
        res.type(mime).set('Content-Disposition', `attachment; filename="Portrait_B_${task.id}_${side}.${mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'}"`).send(buffer);
    } catch (_) { res.status(503).json({ error: '圖片下載失敗，請稍後重試' }); }
});

app.get('/api/admin/task-result-images/:taskId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const taskId = req.params.taskId; let task = localTasksCache[taskId];
    res.json({ success: true, resultImageA: task?.resultImageA, resultImageB: task?.resultImageB });
});

app.post('/api/admin/upload-result-dual/:taskId', async (req, res) => {
    const task=localTasksCache[req.params.taskId];
    if(!task)return res.status(404).json({error:'找不到該任務'});
    if(resetting || confirmations.has(task.id))return res.status(409).json({error:'任務正在送出，請稍候'});
    if(task.reprocessing || task.status==='pending')return res.status(409).json({error:'任務仍在處理中'});
    const sides=(task.styleMode==='chibi-only'?['B']:['A','B']).filter(s=>req.body[`resultImage${s}`]);
    if(!sides.length)return res.status(400).json({error:'請上傳合影圖片'});
    task.reprocessing=true;
    try {
        const prepared=await Promise.all(sides.map(async s=>[s,await finalizeFullScene(decodePhoto(req.body[`resultImage${s}`]))]));
        for(const [s,result] of prepared)assignPrintResult(task,s,result);
        updateTaskOutcome(task);const saved=await saveGenerationState(task);
        res.status(saved?200:503).json({success:saved,error:saved?null:task.cloudError});
    } catch(error){res.status(400).json({error:'無法處理上傳圖片：'+error.message});}
    finally{task.reprocessing=false;}
});

// An explicit staff visual review can release a PNG; JPEG previews cannot be approved for transparent printing.
app.post('/api/admin/approve-result/:taskId', async (req,res) => {
    const task=localTasksCache[req.params.taskId],side=req.body.choice;
    if(!task)return res.status(404).json({error:'找不到該任務'});
    if(resetting || confirmations.has(task.id))return res.status(409).json({error:'任務正在送出，請稍候'});
    if(task.reprocessing || task.status==='pending')return res.status(409).json({error:'任務仍在處理中'});
    if(!['A','B'].includes(side) || req.body.confirmed!==true)return res.status(400).json({error:'請先檢查合影'});
    const image=task[`resultImage${side}`];
    if(!image?.startsWith('data:image/png;base64,') && task[`resultImage${side}File`]?.mime !== 'image/png')return res.status(400).json({error:'這是未去背預覽，請先補傳處理完成的透明 PNG'});
    task.reprocessing=true;
    try {
        const {buffer}=await cloud.readImage(task, `resultImage${side}`);
        const {data,info}=await sharp(buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        let visible=0;
        for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++) {
            const a=data[(y*info.width+x)*4+3];if(a>0)visible++;
            if((x===0||y===0||x===info.width-1||y===info.height-1)&&a>0)throw Error('圖片外圍須透明');
        }
        if(visible<100)throw Error('圖片沒有可見圖案');
        task[`printStatus${side}`]='ready';task[`printWarning${side}`]='工作人員已確認透明背景、完整構圖及邊緣';
        updateTaskOutcome(task);const saved=await saveGenerationState(task);res.status(saved?200:503).json({success:saved,error:saved?null:task.cloudError});
    } catch(error){res.status(400).json({error:error.message});}
    finally { task.reprocessing=false; }
});

app.post('/api/admin/reset-all', async (req, res) => {
    if (resetting || confirmations.size || Object.values(localTasksCache).some(t => t.status === 'pending' || t.reprocessing || t.cloudStatus === 'saving'))
        return res.status(409).json({ error: '還有任務正在處理或保存，請完成後再重製。' });
    if (!cloud.configured || !cloudReady) return res.status(503).json({ error: '雲端未就緒，無法重製。' });
    resetting = true;
    try {
        for (const timer of retryTimers.values()) clearTimeout(timer); retryTimers.clear();
        await cloud.removeRecords();
        localTasksCache = {}; ticketCounter = 1;
        res.json({ success: true, message: "所有資料已重製" });
    } catch (error) { res.status(500).json({ success: false, error: '重製未完成，請重新整理後確認。' }); }
    finally { resetting = false; }
});

// 🌟 新增：接收並儲存後台更改的「狀態」與「備註」
app.post('/api/admin/update-meta/:taskId', async (req, res) => {
    const taskId = req.params.taskId; 
    const { processStatus, remark } = req.body; 
    const task = localTasksCache[taskId];
    if (!task) return res.status(404).json({ error: '找不到該任務' });

    if (resetting || task.reprocessing || confirmations.has(taskId)) return res.status(409).json({ error: '任務正在處理，請稍後再試' });
    if (processStatus !== undefined && !['製作中', '已完成', '已取消'].includes(processStatus)) return res.status(400).json({ error: '狀態不正確' });
    if (remark !== undefined && (typeof remark !== 'string' || remark.length > 2000)) return res.status(400).json({ error: '備註請限制在 2000 字以內' });
    if (processStatus !== undefined) task.processStatus = processStatus;
    if (remark !== undefined) task.remark = remark;
    const saved = await saveGenerationState(task);
    res.status(saved ? 200 : 503).json({ success: saved, error: saved ? null : task.cloudError });
});

return {
    app, ready,
    close() { for (const timer of retryTimers.values()) clearTimeout(timer); retryTimers.clear(); },
    testHelpers: {
        SCENES,
        finalizeFullScene,
        fullScenePrompt,
        leonardoPayload
    }
};
}
if (require.main === module) {
    const instance = createApp();
    instance.app.listen(process.env.PORT || 10000, () => console.log('B 機後端 v19 已啟動'));
}
module.exports = { createApp };
