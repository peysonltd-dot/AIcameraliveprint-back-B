# B 機 Leonardo 整張重繪版 v7

本次依需求改為人物、IP、船身、背景一起生成。兩款保留水彩與超 Q。已停止人物去背、固定座標、遮罩裁切與原稿回蓋；舊分層檔案即使留在儲存庫也不會被用來合成成品。

## 覆蓋與部署

解壓縮後把內容覆蓋到 peysonltd-dot/AIcameraliveprint-back-B 根目錄，包含 server.js、package.json、package-lock.json、assets/、tests/。不要只上傳 ZIP，也不要再多包一層資料夾。
不要覆蓋 A 機 peysonltd-dot/-AIcameraliveprint-back。

Render 保留既有 LEONARDO_API_KEY、FIREBASE_CONFIG、APP_ID、飛鵝等設定。使用 Node 22 以上（NODE_VERSION=22），Build Command 為 npm ci，Start Command 為 npm start。
不需要 OpenAI 金鑰。IMAGE_PROVIDER、OPENAI_*、REMOVE_BG_MODE 舊變數不影響本版流程；可以移除。

部署後開 https://aicamera-backend-b.onrender.com/health ，確認：
- pipelineVersion: leonardo-full-scene-v7
- imageProvider: leonardo-full-scene
- imageProviderConfigured: true
- layeredComposite: false
- removeBgMode: none

再上傳 B 前台 v7，更新後應看到水彩互動版與超 Q 互動版。請只用新任務測試，舊任務圖片不會自動重畫。

## 參考圖與生成方式

每款按以下順序送出五張參考：
1. 賓客照片：唯一的人物身分參考。
2. 官方 ip.svg：IP 造型、輪廓、配色、臉部、配件的優先依據。
3. 官方 boat.svg：方舟造型、配色、電路圖案的優先依據。
4. test-scene-reference.jpg：只參考雙方同坐船內、搭肩與整體構圖。
5. 畫風參考：水彩使用構圖範例的人物局部；超 Q 使用 q-style-reference.jpg。

提示詞明確規定官方 IP 與船身原稿優先，禁止從構圖範例抄帽子、改造型或多生成一艘船。賓客與一隻指定 IP 同坐一艘方舟，人物下半身由船身自然遮擋。全部由模型整體生成，伺服器只統一尺寸與 JPEG 格式，不局部合成。

水彩版用 Leonardo gemini-2.5-flash-image；超 Q 版用 Leonardo gpt-image-2 / LOW。每款 quantity 1、1024×768。gpt-image-2 在此仍由 Leonardo 計費，沒有呼叫 OpenAI API。
Nano Banana 參考權重：人物、IP、船身 HIGH，構圖 LOW、畫風 MID。GPT Image 2 不支援參考 strength，透過提示詞區分用途。這些指示並非鎖定機制，IP 細節仍可能改變。

## 費用與驗收

正常每客兩張、兩次生成，無去背 API 費用。五張參考圖相較前版增加了輸入內容，不保證價格完全相同；請以 Leonardo API 用量紀錄確認實際扣款。失敗或超時不會自動重送付費生成，人工再次送出會產生新用量。

已做離線模擬測試：node tests/pipeline.cjs。包含五張參考順序、兩種模型、整圖不去背不覆蓋、尺寸、照片驗證及單款失敗保留另一款。
尚未執行真實付費產圖，無法宣稱已驗證 IP 相似度、人物相似度、搭肩或生成成功率。
正式印製前請檢查 IP 輪廓、臉部、配色、配件，以及是否只有一個人物、一個 IP、一艘船。整張重繪無法保證 IP 與原檔完全一致；若客戶要求完全相同，須另用固定素材方案。

前台預覽是構圖示意，不是本版實際生成案例；預覽出現的帽子等造型不代表指定 IP 原稿。

原有 Firebase base64 圖片保存方式未更換，大圖可能碰到文件大小上限。記憶體暫存不等於永久保存，請留意 Render log 的雲端同步錯誤。重啟後不會自動恢復未完成任務輪詢，請先依 generationIdA/B 查 Leonardo 紀錄再重送。

參數參考：
https://docs.leonardo.ai/docs/nano-banana
https://docs.leonardo.ai/v1.0/docs/gpt-image-2
