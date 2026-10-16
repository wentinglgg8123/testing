# 小日子記帳

繁體中文的個人記帳工具，以新臺幣（TWD）計算。可使用本機帳本，也可建立帳號，讓手機、電腦登入同一帳號同步收支。

**帳號與跨裝置同步必須使用 Node.js 後端。GitHub Pages 只能提供本機記帳，無法執行登入或資料庫。** 專案已提供後端、Dockerfile 與 Render 設定；這些檔案本身不會建立線上服務。

## 本機啟動

需要 **Node.js 24**，沒有第三方 npm 依賴，不必先安裝套件：

```sh
npm start
```

在本機瀏覽器開啟 `http://localhost:3000`。此指令同時啟動網站、帳號 API 與 SQLite 資料庫。若要變更設定，可將 `.env.example` 複製成 `.env` 後調整；`npm start` 會載入它。雲端開發環境需透過平台的連接埠存取功能開啟。

| 設定 | 用途 |
| --- | --- |
| `PORT` | 服務連接埠，預設 `3000` |
| `LEDGER_HOST` | 預設 `0.0.0.0` |
| `LEDGER_DATA_DIR` | 資料庫目錄，預設 `.ledger-data`；正式部署必須指向持久磁碟 |
| `LEDGER_ORIGIN` | 完整網站來源，例如 `https://ledger.example.com`，不含路徑或結尾斜線 |
| `NODE_ENV` | 正式部署設 `production`，此時必須設定 HTTPS 的網站來源 |

Render 可自動使用平台提供的 `RENDER_EXTERNAL_URL` 作為來源；自訂網域請另設 `LEDGER_ORIGIN`。未設定來源的開發模式只接受與請求網站同來源的操作。不同網址不共用登入 Cookie，請固定使用同一正式網址。

## 使用帳號

1. 按右上角「登入 / 註冊」，再選「建立帳號」。
2. 帳號使用 3–32 個英文字母、數字或底線，不區分大小寫；密碼為 10–128 個字元，須再次輸入確認。
3. 註冊後自動登入。新增、編輯、刪除與備份還原會儲存至目前帳號。
4. 其他裝置開啟**同一個後端網站網址**，用相同帳號與密碼登入。按「重新同步」可立即取得更新；頁面回到前景時與每 30 秒也會自動檢查，編輯期間暫停。
5. 按「登出」可結束此裝置的登入。登入有效期為七天，不影響其他獨立裝置的工作階段。

目前沒有電子郵件驗證或忘記密碼重設，請妥善保管密碼。密碼使用 scrypt 雜湊保存；前端不會將密碼或登入憑證寫入 `localStorage`。

### 搬移舊帳本

登入不會自動上傳本機資料。按「加入本機紀錄」並確認，才會加入目前帳號。相同識別碼保留帳號中的紀錄，不覆寫或重複加入；原本的瀏覽器資料仍保留，登出後可繼續使用。

若舊帳本位於 GitHub Pages 或另一個網址，先到舊網站「下載備份」，再到新網站登入帳號並「匯入備份」。**匯入會取代目前帳號所有裝置的帳本**，請先確認內容；帳號為空時最適合做第一次移轉。

### 同步失敗與同時編輯

更新時會檢查帳本版本。兩台裝置同時修改時，較舊的操作會被拒絕，並嘗試取得最新資料。表單輸入會保留，請確認紀錄後再次儲存；系統不會直接用舊版覆蓋另一台裝置。

網路中斷或逾時時，不會顯示儲存成功。請先按「重新同步」確認伺服器上的內容，再繼續。若帳號已在另一分頁切換，舊分頁不能寫入新帳號，須重新登入。帳號模式不提供離線寫入佇列。

## 部署至 Render

Render 可以從 GitHub 建立同時提供網頁、帳號與資料庫的網站。**`render.yaml` 使用付費 Starter Web Service 與 1 GB 持久磁碟，請在 Render 確認當時的方案與費用後再部署。** 目前尚未建立或購買服務。

1. 在 [Render](https://render.com/) 登入並連接 GitHub。
2. 選 **New → Blueprint**，選擇此儲存庫及 `main` 分支，載入 `render.yaml`。
3. 確認服務方案與持久磁碟後建立服務。
4. 等待部署成功，開啟 Render 顯示的 HTTPS 網址，再建立帳號。
5. 手機與電腦都使用這個新網址登入。GitHub Pages 舊網址仍只有本機帳本。

若平台不支援 Blueprint，可手動建立 Docker Web Service：使用根目錄的 `Dockerfile`，掛載持久磁碟至 `/app/data`，設定 `NODE_ENV=production`、`LEDGER_DATA_DIR=/app/data`、`LEDGER_ORIGIN=實際 HTTPS 來源`。健康檢查路徑為 `/health`；Render 官方網域可省略 `LEDGER_ORIGIN`，改用平台自動提供的 `RENDER_EXTERNAL_URL`。

正式環境須由 HTTPS 反向代理提供 TLS，登入 Cookie 會設定 `Secure`。SQLite 使用本機磁碟，請維持單一服務實例；磁碟必須在服務重啟及重新部署後仍保留。**沒有持久磁碟的免費暫存服務不能保存正式帳本。**

### 其他 Docker 主機

```sh
docker build -t little-ledger .
docker volume create little-ledger-data
docker run -d --name little-ledger --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e LEDGER_ORIGIN=https://ledger.example.com \
  --mount source=little-ledger-data,target=/app/data \
  little-ledger
```

將範例網域換成你的 HTTPS 網址，設定主機的反向代理至 3000 埠。此指令只將埠開在主機 loopback，須由主機反向代理對外提供服務。

### 資料與備份

帳號、密碼雜湊、登入工作階段與帳本保存在 `LEDGER_DATA_DIR/ledger.sqlite`。資料目錄與 `.env` 不應提交 Git 或作為靜態檔案公開；後端只提供明確列出的網頁資產。

使用者可下載自己的 JSON 備份。伺服器管理者另應備份資料庫：使用 SQLite 備份工具，或**先停止服務再完整複製資料目錄**。不要在寫入中僅複製 `.sqlite` 主檔而漏掉 WAL。移轉主機時還原整個目錄，確認服務帳號有讀寫權限。

驗證機制包含隨機鹽值 scrypt、HttpOnly / SameSite Cookie、儲存雜湊的隨機工作階段、同來源檢查與登入次數限制。帳本擁有者只由伺服器端工作階段決定，不能由前端指定其他人的帳號。

## 記帳功能

- 收入與支出新增、編輯、刪除，含日期、分類、金額與備註。
- 每月收支／結餘統計、支出分類圖表、搜尋與篩選。
- CSV 匯出篩選結果、完整 JSON 備份與確認後還原。
- 手機版面與鍵盤操作；本機模式支援瀏覽器分頁同步。

金額最多九位整數與兩位小數，以整數分運算。每個帳本最多 20,000 筆，JSON 匯入上限 5 MB。本機模式依賴此瀏覽器與網站來源的 `localStorage`，不會自動同步；清除網站資料或關閉無痕瀏覽器可能失去資料，請定期備份。

## 驗證

```sh
npm test
```

測試涵蓋註冊與登入、密碼與工作階段儲存、帳號隔離、跨裝置 API、版本衝突、跨來源拒絕、登入過期與限流、重啟後資料保留，以及金額、日期、統計、備份及 CSV。

若環境已安裝 Python Playwright 與 Chromium：

```sh
# 需在另一個終端先執行 npm start；檢查本機記帳功能。
python3 tests/browser_smoke.py

# 自動啟動獨立後端及暫存資料庫，不寫入正式帳本。
python3 tests/account_browser.py
```

第一個腳本預設使用 `http://127.0.0.1:3000`，可用 `LEDGER_TEST_URL` 覆寫。兩者可用 `LEDGER_CHROMIUM` 指定 Chromium，預設 `/usr/bin/chromium`。截圖寫入 `/tmp/little-ledger-*.png`。開發環境已驗證 Docker 建置、正式模式 Cookie、非 root 執行、持久磁碟寫入，以及容器重啟後的帳號、工作階段與帳本保留；Render 等託管平台部署尚未執行，仍需另行驗證。

主要檔案：`index.html`、`styles.css`（介面）；`app.js`、`account.js`（互動與同步）；`ledger.js`（帳本處理）；`backend.js`、`server.js`（帳號與資料庫）。原有會議紀錄 `test.md`、`week4.md` 保留。
