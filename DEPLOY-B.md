# B 機 v9：六個 IP、完整構圖、透明 PNG

## 部署

解壓縮後把全部內容覆蓋到 peysonltd-dot/AIcameraliveprint-back-B 根目錄，包括新增的 print-image.js、assets/ip-catalog.json、assets/ips/。不要只上傳 ZIP。其他同名檔案也需一起覆蓋。
Render 保留 LEONARDO_API_KEY、FIREBASE_CONFIG、APP_ID、飛鵝等環境設定；Node 22 以上，Build Command: npm ci，Start Command: npm start。
不需要 OpenAI 金鑰。舊 IMAGE_PROVIDER、OPENAI_*、REMOVE_BG_MODE 不影響本版流程。

https://aicamera-backend-b.onrender.com/health 應顯示：
- pipelineVersion: leonardo-multi-ip-print-v9
- printFormat: image/png
- printMargin: 0.08
- removeBgMode: local-chroma
- layeredComposite: false
- scenes: 六個角色 ID

接著部署 B 前台 v9，開始一筆新任務測試。A 機前後台都不需要更改。

## IP 選擇

素材來自您提供的 Google Drive / SVG 資料夾，資產 3–8，未改動畫稿。
名稱為方便選擇的外觀名稱，不當作官方角色命名：
- 綠色平板夥伴：資產 8.svg
- 黃色耳機夥伴：資產 4.svg
- 橘色探索夥伴：資產 5.svg
- 紫色魔法夥伴：資產 7.svg
- 白色雲朵夥伴：資產 6.svg
- 藍色望遠鏡夥伴：資產 3.svg

前台先選其中一個 IP，再拍照並產生水彩／超 Q 兩款。每次只生成賓客＋所選的一個 IP＋一艘船，不會一次放六隻。後台任務保存選擇的角色名稱。
後端 /api/scenes 提供角色清單；前台 assets/ip-catalog.js 和兩端 ip-catalog.json 需保持一致。

## 圖片處理

維持整張合影一起重繪。官方 IP 和船是獨立參考，模型盡量遵循；沒有固定 IP 疊回去。原稿相似度仍須人工驗收。

生成指令要求全圖縮小、含配件與水滴在內四周至少留 12% 底色。人物、IP、整艘船、藍色水花與白色泡沫一起畫出；外圍使用單一純洋紅底色以便伺服器去除，不生成奶油色方形紙張背景。

print-image.js 優先去除外圍洋紅底色，再按圖案邊界等比例置中。成功去背的結果為 1024×768 RGBA PNG，左右至少 82px、上下至少 62px 透明空隙（約 8%）。淺色且接近單色的背景會使用從邊界連通區域去背的備援方式，並標示需檢查；這類處理仍可能誤去除與背景相連的白色角色、衣服或水花，不能保證細節完整。不水平反轉；若印製工法需要反轉，仍由工作人員在印製軟體中設定。

此去背在 Render 執行，不需要現場帶著開發用電腦，也沒有另外呼叫付費去背 API。圖案仍為整張生成，與先前的固定人物位置、原稿 IP 分層合成不同。

若 AI 把主體畫到來源圖邊界，或背景無法可靠去除，會保留完整來源構圖並加邊距，輸出 JPG 預覽、標示需人工處理；不會直接把整筆任務判為失敗，也不會把 JPG 當成透明 PNG。增加空隙不能補回來源已遺失的內容。自動檢查不能辨識所有缺手、少配件等語意問題，仍需看成品。

色鍵去背有實際限制：極接近純洋紅的衣服／小配件可能被誤去除，半透明水花邊緣可能有色邊。請測試粉紫色衣物、長髮、白衣及各隻 IP。若上述情形常見，需改用分割去背方案另測品質與成本。

## 後台下載與失敗處理

可靠去背的成品含真正 alpha，後台下載和手機下載均保留 PNG；備援 JPG 保留 JPG 副檔名。後台依所選款式的 printStatus 顯示印製或待確認下載，請先檢查待確認圖檔。人工補傳結果也改存 PNG，避免透明背景被轉成 JPG。舊任務 JPG 維持 JPG，不會自動重新產圖或去背。
所有結果預覽用 object-contain，前台用棋盤格顯示透明範圍。下載圖不含棋盤格。
單款生成失敗時狀態為 partial，前台仍可選擇已完成的另一款；originalGenerationUrlA/B 及 generationIdA/B 可供查原始生成記錄。付費生成不自動重送，另建產圖任務才會產生新的生成用量。

後台新增「重新處理原圖（不重新產圖）」按鈕，呼叫 POST /api/admin/reprocess/:taskId，僅下載該任務已保存的 originalGenerationUrlA/B 再處理，不呼叫 Leonardo 生成。舊第 009 筆只有在任務及原圖連結仍保存且有效時才能恢復；逾期原圖需由工作人員從 Leonardo 取得後補傳。更新部署前請保留可下載的原圖，部署重啟不能保證恢復僅存在記憶體的任務。

## 費用與驗收

仍使用 Leonardo 的 gemini-2.5-flash-image（水彩）及 gpt-image-2 / LOW（超 Q），各一張，五張參考。每位正常兩次生成，金額以 Leonardo 實際 API 扣款紀錄為準。
已做離線模擬測試，沒有執行真實付費生成：
- node tests/print-image.cjs：透明 alpha、8% 留白、白／紫／藍保留、淺色底備援、來源裁切或不符底色時保留待確認 JPG。
- node tests/pipeline.cjs：六隻各自參考圖、兩款請求、PNG 輸出、partial 保留另一款、拒絕選缺圖款、原圖重新處理不新增生成請求。

原有 Firebase base64 保存架構未更換，PNG 容量比 JPEG 大，更可能碰到 Firestore 文件大小限制；請注意 Render 雲端同步錯誤，活動前完成儲存測試。記憶體暫存不等於永久保存，重啟後未完成任務不自動恢復。正式大量活動應另接圖片物件儲存，不能只依賴記憶體。

本版只使用本機測試資料驗證程式分支，未讀取線上第 009 筆原圖，亦未執行真實付費產圖；請部署後用一筆新任務確認實際品質。
