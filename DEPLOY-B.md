# B 機 V19：圖片雲端保存修正

## 更新內容

- 完整 PNG／JPEG 存到 Firebase Storage，Firestore 只保存檔案位置、成品下載網址與訂單資料，避免 resultImageB 超過 1 MB。
- 儲存時直接上傳既有圖片位元組，不降低尺寸、不轉成 JPG，透明 PNG 保留透明度。
- 原照也改存 Storage，沒有公開下載權杖，只能透過已登入的後台讀取。
- 成品下載網址不設定到期時間；持有成品網址的人可以下載，Storage 本身不需設成公開寫入。
- 後台新增雲端保存狀態、重新保存。保存失敗會保留本次記憶體中的圖片，並有限次重試；人工重新保存不呼叫 Leonardo。
- 客人仍可直接預覽已生成的圖片。只有保存未完成時，「確定」會請客人稍後重試，避免發出沒有可靠圖片的下載 QR Code；不需工作人員核准畫質。
- 原照保存成功後才發出付費產圖請求。未設定 Storage、原照上傳失敗、歷史資料讀取失敗時，停止接收新產圖。
- 重啟時從 Firestore 恢復號碼、成品網址、賓客選擇。中斷中的生成不自動重新付費；保留任務 ID／原圖網址供後台處理。
- 保留 V13 白底、單張超 Q、六個 IP、Leonardo GPT Image 2 LOW、透明處理與留白；產圖提示詞及 print-image.js 未更動。

## 先保留舊成品

**修改 Render 設定也可能觸發重新部署。請先把目前後台中需要保留的成品下載到電腦，再修改設定或更新。**

舊版保存失敗、只存在 Render 記憶體的圖不會隨更新自動移入新版。

- 已存在 Firestore 的舊版 base64 圖片會保留可讀；部署後可在該筆按「重新保存」轉存 Storage。
- 舊筆沒有成品但有有效原圖網址，可用「重新處理原圖」；這不會重新產圖。
- 舊筆只有 Leonardo 任務 ID，可由工作人員從 Leonardo 找回原圖，再補傳。
- 若只剩已下載的 PNG，部署後在對應筆「補傳合影」。不要再次拍照來補救保存問題，以免重新計費。

## 1. 確認使用哪個 Firebase 專案

在 **B 機 Render → Environment → FIREBASE_CONFIG** 查看 `projectId`，再到 Firebase 的「專案設定 → 一般設定 → 專案 ID」核對。
專案顯示名稱不一定等於專案 ID。不要僅因名稱像 AIcameraliveprint-back 就更換設定。
沿用相同的 `FIREBASE_CONFIG` 與 `APP_ID`；如果原本未設定 APP_ID，程式原有預設是 `photo-booth-app`。不要任意換成新值，否則會讀到另一組訂單。

## 2. 啟用同一專案的 Storage

在 Firebase 左側 Storage 確認已有儲存空間；若尚未建立，依畫面建立。
目前 Cloud Storage for Firebase 需要 Blaze 計費方案。已是 Blaze 不必重複升級；若仍是 Spark，需由專案擁有者確認計費後啟用。
這次程式更新沒有替你開啟計費；實際儲存與下載用量依 Firebase 計費。

複製 Storage 的儲存空間名稱，例如 `你的專案.firebasestorage.app` 或原有的 `你的專案.appspot.com`。不要自行推算名稱；以 Firebase 顯示的實際值為準。
不要為了上傳而把 Storage 規則改成允許所有人讀寫。本版用伺服器端服務帳戶寫入，不需要放寬規則，也沒有更動其他專案或其他系統的規則。

## 3. 設定後端服務帳戶

到相同 Firebase 專案的「專案設定 → 服務帳戶 → Firebase Admin SDK」，取得供本後端使用的服務帳戶金鑰 JSON。
請保存在 Render 的 Secret File，**不要上傳公開 GitHub，也不要貼進聊天或前台 HTML**。
建議做法：Render → Environment → Secret Files，新增 `firebase-service-account.json`，內容貼上 JSON。
然後新增環境變數：

| 名稱 | 值 |
| --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/etc/secrets/firebase-service-account.json` |
| `FIREBASE_STORAGE_BUCKET` | 實際的儲存空間名稱，不含 `gs://` |

也支援直接用 Render Secret 環境變數 `FIREBASE_SERVICE_ACCOUNT` 放完整 JSON；兩種擇一即可。若兩種都設定，程式優先使用 FIREBASE_SERVICE_ACCOUNT。

此帳戶需有同專案 Firestore 讀寫與指定 Storage bucket 物件上傳／讀取權限。若出現 403，檢查帳戶是否具備 Cloud Datastore User、Storage Object Admin 或等效且範圍合適的權限；不要靠開放安全規則排除錯誤。
服務帳戶的 project_id 必須等於既有 FIREBASE_CONFIG 的 projectId，程式會檢查，避免誤用另一個專案。

原本的 `ADMIN_PASSWORD`（此次指定 admin888）、`LEONARDO_API_KEY`、`FIREBASE_CONFIG`、`APP_ID`、出票設定全部保留。管理密碼只放 Render，不寫入公開程式碼。

## 4. 部署

1. 設定完成後，將後端包解壓縮，內容覆蓋到 `peysonltd-dot/AIcameraliveprint-back-B` 根目錄。
2. Render 使用 Node 22 以上；Build Command `npm ci`，Start Command `npm start`。
3. 再將前台 V19 包解壓縮，覆蓋到 `peysonltd-dot/AIimageliveprintB` 根目錄。前台首頁、Loading 與合影頁沿用 V18。
4. 後台重新登入，確認沒有「圖片儲存尚未設定」提示，再試拍。

`/health` 應顯示 `storageVersion: v19`、`storageConfigured: true`、`ordersLoaded: true`、`acceptingUploads: true`。
`storageConfigured` 只表示設定齊全，不代表已通過實際雲端上傳驗收。`pipelineVersion` 仍是 `leonardo-chibi-print-v13`，這是刻意保留的產圖版本。

## 5. 上線驗收

1. 建立一筆測試，等待成品，後台該筆應顯示「已保存至雲端」。
2. 客人按確定後，後台下載 PNG，手機掃 QR Code 下載，確認都能開啟。
3. 確認該筆已保存後再重啟 Render，重新登入後台，確認同號碼及圖片仍可下載，QR Code 也可下載。
4. 若保存未完成，先下載成品備份，檢查 Storage、服務帳戶與網路，再按「重新保存」。不要因此重新付費拍攝。
5. 登入前 `/api/admin/all-tasks` 與新增的下載／重新保存接口仍應回覆 401。

## 清除排隊與圖片保留

「重製機台 B 排隊」仍會刪除該 APP_ID 的訂單並歸零號碼，舊 QR Code 的任務查詢會失效。
本次不會在重製時刪除 Storage 中的圖片，也不會自動清理 bucket、其他 APP_ID 或其他系統的檔案。圖片會持續占用 Storage，保留期限可之後另行設定。
新任務使用隨機儲存路徑，號碼歸零後不會覆寫上一場的圖。
本版仍以單一 B 後端執行個體設計；多個副本並行接單需要另做共用流水號與登入狀態。

## 已完成的離線驗證

- `node tests/cloud-storage.cjs`：大於 1 MB 的真 PNG、位元組與透明通道、原照私有、Firestore 小文件、重新建立服務後下載、保存失敗／重試、舊圖轉存、設定與啟動失敗停止付費任務、重製保留圖片。
- `node tests/pipeline.cjs`：六個 IP 各一次單張超 Q 模擬產圖、成功預覽確認、透明留白、處理與補傳，不增加產圖請求。
- `node tests/admin-auth.cjs`：登入、到期、登出、錯密碼限制，包含新接口的驗證。
- `node tests/white-v13.cjs`：既有白底處理與透明邊距。
- 前台 JS／JSX 語法與後台 DOM 模擬：保存提示、重試按鈕、新網址取代舊快取、PNG 下載、登入到期清除資料。

所有測試使用本機及模擬服務。未存取正式賓客資料、未呼叫付費產圖、未替你部署、未在你的實際 Firebase bucket 做上傳驗收。實際配置完成後請按上述步驟試拍。

## 官方參考

- Firebase Storage 與伺服器端設定：https://firebase.google.com/docs/storage/admin/start
- Firebase 服務帳戶設定：https://firebase.google.com/docs/admin/setup
- Storage 計費方案要求：https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024
- Firestore 文件限制：https://firebase.google.com/docs/firestore/quotas
