# AriaDM 下載助手（瀏覽器擴充功能）

擴充功能把瀏覽器裡的連結與下載交給 AriaDM。它不會直接碰 aria2：所有請求都會經過
AriaDM 主行程的 loopback handoff API，並以權杖驗證。

## 建置

`resources/extension/chrome` 與 `resources/extension/firefox` 是產物，不是手寫的。
修改 `src/` 之後要重新產生：

```bat
npm run build:extension
```

兩個版本共用 `src/` 裡的所有程式碼，差別只在 manifest：Chrome 需要
`background.service_worker`，Firefox 用 `background.scripts`（事件頁）。

## 安裝（未封裝）

1. 先啟動一次 AriaDM，讓它開始在 `127.0.0.1:7070`（被占用時依序改用 7071–7074）提供配對服務。
2. **Chrome / Edge / Brave**：`chrome://extensions` → 開啟「開發人員模式」→
   「載入未封裝項目」→ 選擇 `resources/extension/chrome`。
3. **Firefox**：`about:debugging#/runtime/this-firefox` → 「載入暫時性附加元件」→
   選擇 `resources/extension/firefox/manifest.json`。

**不需要填寫任何設定。** 擴充功能安裝後會自己向 AriaDM 配對（取得連接埠與權杖），
之後每分鐘檢查一次，所以先開瀏覽器或先開應用程式都可以。工具列圖示上的徽章
顯示目前狀態：`ON`（綠色）＝已連線，`OFF`（紅色）＝尚未連線。

若徽章一直顯示 `OFF`，請確認 AriaDM 正在執行；按彈出視窗的「重新連線」也會立刻重試。
彈出視窗會列出已經嘗試過的連接埠。

自動配對會依序嘗試 `7070`–`7074`：`7070` 同時是 AnyDesk 的預設直連連接埠，
很常被占用，AriaDM 遇到占用時會自動換到下一個，並持續重試。只有在這幾個連接埠
全部被占用時，才需要展開「進階：手動指定連線」，或在 AriaDM 的
「設定 → 整合與工具」確認自動配對顯示的連接埠。

## 功能

| 功能 | 說明 |
| --- | --- |
| 影片下載面板 | 在支援的影音網站上，滑鼠移到播放器上方會出現「下載此影片」面板，按一下即以最佳畫質交給 AriaDM（類似 IDM 的浮動下載列） |
| 右鍵下載連結 | 對連結、圖片、影音按右鍵 → 「用 AriaDM 下載」 |
| 傳送目前頁面 | 把目前分頁網址送進佇列 |
| 傳送所有連結 | 收集頁面上所有 `http`/`ftp` 連結，一次送出（最多 200 個） |
| 攔截瀏覽器下載 | 開啟後，瀏覽器開始的下載會被取消，改由 AriaDM 接手 |
| 連線徽章 | 工具列圖示顯示 `ON`/`OFF`，一眼看出是否已設定完成 |

### 影片下載面板

- 只在 `media-sites.json` 列出的網站出現；送到 AriaDM 的是**頁面網址**而不是影片元素
  的 `src`，因為後者通常是幾分鐘後就失效的串流片段（這正是 X 能成功的原因）。
- 播放器換掉、版面改變、進入劇院模式都會重新定位；`all_frames` 讓嵌入 iframe 的播放器
  也偵測得到。
- 面板會在影片過小時自動收成只有圖示的圓形按鈕。

## 登入狀態與 Cookie

需要登入的網站（X、Instagram、Facebook、有年齡限制的 YouTube）由 AriaDM 端處理：
主行程會用 `--cookies-from-browser` 讀取你已登入的瀏覽器工作階段。可在
「設定 → 整合與工具 → 影音下載 → 使用瀏覽器 Cookie」指定來源，預設為自動偵測。

由擴充功能送出的下載則會附上該頁面當下的 Cookie、Referer 與 User-Agent——只有瀏覽器
知道那些值。這種情況下不會再另外讀取瀏覽器 Cookie 檔，避免兩份不同的工作階段互相衝突。

Chromium 系瀏覽器在執行中會鎖住 Cookie 資料庫，讀不到時請先完全關閉瀏覽器再試。

## 安全性

- 請求帶 `x-ariadm-token` 標頭，AriaDM 以固定時間比較驗證。
- API 只綁定 `127.0.0.1`，且只接受來源為擴充功能的請求，網頁無法代你發起下載。
- 權杖只存在 `chrome.storage.local`，不會離開本機。
- 配對用的 `/discover` 端點不需要權杖（那正是取得權杖的方式），但仍然只回應擴充功能的來源，
  而且只在固定連接埠上提供，不接受任何下載請求。
- 擴充功能只有在對方回報自己是 `AriaDM` 時才接受該連接埠，因此不會誤把佔用連接埠的
  其他程式當成應用程式。
