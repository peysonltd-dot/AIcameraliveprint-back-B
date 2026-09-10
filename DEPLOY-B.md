# B 後端 v10：只生成一張超 Q 合影

## 覆蓋與部署
解壓縮後把全部內容覆蓋到 peysonltd-dot/AIcameraliveprint-back-B 根目錄，包含 server.js、print-image.js、assets/、套件檔與 tests/。不要只上傳 ZIP。
Render 保留既有 LEONARDO_API_KEY、FIREBASE_CONFIG、APP_ID、飛鵝等設定。Node 22 以上；Build Command：npm ci；Start Command：npm start。
先部署本後端，再部署 B 前台 v10。A 機 AIcameraliveprint 與 -AIcameraliveprint-back 均不更動。

/health 應顯示 pipelineVersion: leonardo-chibi-print-v10、styles: [chibi]、generationsPerGuest: 1。

## 單張生成與費用
新任務只呼叫 Leonardo gpt-image-2，quality LOW、quantity 1，保留五張參考圖與六個 IP 選項。停止呼叫水彩模型。每位正常只有一次生成請求，不自動付費重送。
圖片仍是人物、所選 IP、船與水花一起重新繪製，沒有改成固定 IP 分層合成。IP 相似度仍須驗收，無法保證與原稿完全相同。
既有 B 欄位保留存放超 Q 合影，避免舊下載及出票串接失效；新任務 styleMode 為 chibi-only。舊任務的 A/B 圖片不會刪除。
不需要 OpenAI 金鑰，也沒有新增付費去背服務。停止水彩請求會減少原先該部分用量；實際金額依 Leonardo 帳戶扣款為準，並非宣稱總費用恰好減半。

## 去背、色邊與完整構圖
v10 從圖片邊界取樣實際粉紅／洋紅底色，處理與外圍相連的相近色調及淡色光暈，避免只辨識固定 #FF00FF。只在圖案外沿的窄範圍進行色邊修正；不全圖刪白色，不全圖替換粉紅衣服。
成功處理後等比例置中為 1024×768 RGBA PNG，左右至少 82px、上下至少 62px 透明邊距（約 8%），不水平反轉。預覽及下載不裁切。
來源圖已缺失的部位無法靠加留白補回。背景不可辨識、來源碰邊時保留 JPG 預覽供後台處理；近白底備援或可疑封閉色塊會標示 review。前台不能選取／確認 review，API 也會拒絕送出。
粉紅／紫色衣物與底色接近、細髮、半透明水滴、封閉空隙都仍有誤判可能。ready 表示通過程式處理條件，不等於人工品質認證；正式印製前仍應檢查原稿一致性、色邊與白色細節。
去背在 Render 執行，不需現場帶著開發電腦。

## 工作人員恢復同一筆任務
1. 後台「重新處理原圖（不重新產圖）」僅下載該筆既有 originalGenerationUrl，再執行圖片處理。新任務只處理 B 款，不呼叫生成 API。
2. 若仍為待確認，下載檢查；需修改時補傳處理完成的透明 PNG。
3. PNG 待確認圖片可由工作人員在確認背景透明、完整構圖及無色邊後，按「檢查完成，提供賓客預覽」。JPG 不能透過此按鈕冒充透明檔。
4. 賓客停留的預覽頁會自動更新，再按確認送出。
原圖連結需仍有效、任務需仍存在；重新部署不保證恢復只有記憶體暫存的舊任務。沒有任何自動重拍或重新付費產圖。

## 已驗證與限制
node tests/print-image.cjs：alpha、8% 邊距、白/紫/藍保留、異常圖保留待確認。
node tests/chroma-v10.cjs：不同粉紅底、淡色光暈、混色邊緣、封閉可疑區域。
node tests/pipeline.cjs：六個 IP、新任務僅一次 gpt-image-2 請求、無水彩／自動付費重試、待確認不可送出、原圖重新處理、補傳與人工放行。
API 測試均為模擬，不會扣款，未拿線上賓客原圖做真實生成驗收。

原有 Firebase base64 保存架構未更換，較大 PNG 可能超過 Firestore 文件大小限制。若 Render 顯示雲端同步失敗，記憶體中的圖不代表永久保存；請先下載需要保留的圖片再重啟。正式活動大量儲存仍需另接圖片物件儲存。
