# B 後端 V13：純白底生成

## 上傳位置
解壓縮後將內容覆蓋到 peysonltd-dot/AIcameraliveprint-back-B 專案根目錄，不要只上傳 ZIP。
Render 保留既有金鑰、Firebase、APP_ID 與出票設定。Node 22 以上，Build: npm ci，Start: npm start。
/health 應顯示 pipelineVersion: leonardo-chibi-print-v13、removeBgMode: local-white。
前台沿用 V12；如果尚未更新 V12 前台，需要另行更新 AIimageliveprintB 的 V12 前台包，才有有圖直接預覽的流程。
A 機 AIcameraliveprint 與 -AIcameraliveprint-back 不需更新。

## 改動
- 新生成提示詞改用 uniform pure white #FFFFFF，移除桃紅底要求，禁止桃紅背景、光暈與棋盤格。
- 保留超 Q 風格、六個 IP、五張參考圖、人物/IP/船/水花整體重繪，以及 12% 生成留白要求。
- 保留原生白色角色、衣物與水花；以原有插畫輪廓區分背景。
- 外圍去背採更窄的近白色容差，僅處理與邊界相連區域，不全圖刪除白色。
- 白底與已透明的圖片不再做桃紅色替換；舊桃紅底原圖仍可使用既有去背處理。
- 生成模型仍為 Leonardo gpt-image-2、LOW、單張，沒有新增 OpenAI 金鑰、付費去背 API 或自動付費重試。

## 輸出與限制
成功去背輸出 1024×768 透明 PNG，約 8% 邊距，不水平反轉。白底本身並不等於透明，本版仍需後端去背。
白底處理的 PNG 會保留 review 提示：白色細節若與背景相連、輪廓不封閉，可能被去掉；封閉空隙可能留白。此方法不是語意智慧去背，不保證能區分所有白色 IP 與水花。
來源碰邊或背景無法處理時保留未去背 JPEG 預覽，不能當作透明 PNG 印製。
V12 前台可直接顯示已有圖片、確認與 QR 下載；工作人員仍須印前檢查，賓客確認不會把 review 改成 ready。

## 舊任務
更新只影響之後新生成的白底圖片，不會自動重繪舊成品。
後台重新處理原圖不會重新產圖，也不會將舊桃紅底改為白底；原圖網址與任務需仍有效。
既有 Firebase base64 保存方式未更換，大檔可能超過文件大小限制；若雲端同步失敗，記憶體中的圖片不代表已永久保存，重啟前請下載需要保留的圖片。

## 驗證
- tests/white-v13.cjs：合成白底圖去背、透明邊距、封閉白色區域／粉紅／淡藍保留，保留 review。
- tests/print-image.cjs：透明 PNG、邊距、異常來源備援。
- tests/pipeline.cjs：模擬 Leonardo 請求確認純白提示詞、單張生成、預覽確認與後台恢復流程。
未呼叫付費 API，也未以現場真人照片做生成品質驗收；需部署後實拍確認白色 IP 與水花效果。
