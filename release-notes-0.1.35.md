## 修正

- **背景圖片超過約 1.5 MB 時完全不會顯示。** 這是回報的原始問題：「設定好了，但什麼都沒出現，可是換另一張圖就可以」。原因不在圖片、也不在設定：

  - 主行程把圖片讀成 **base64 data URL** 交給畫面，畫面再把它寫進 CSS 自訂屬性 `--wallpaper-image`。一張 1.69 MB 的 PNG（就是回報的那張截圖）換算出來是 **2,364,382 個字元**的宣告值。
  - **Blink 會默默丟掉超過 2 MiB 的 CSS 宣告**：屬性不會被設定，圖層退回 `background-image: none`，於是視窗只有介面底色。沒有錯誤、沒有警告，設定檔裡的路徑照樣寫入，而同一份位元組當成圖片載入時解碼完全正常——所以「有些圖可以、有些圖不行」，取決的只是那張圖的 base64 有沒有跨過 2 MiB。
  - 實測（Chromium 130，與 Electron 33 相同）：2,097,152 字元的宣告被接受，再長一點就直接消失（`getComputedStyle` 讀到 `none`）；而同一支 2.7 MB 的 data URL 用 `new Image()` 載入是成功的。也就是說**只有 CSS 這條路有這個上限**。
  - 也就是說設定頁寫的「8 MB 以內」在這個上限面前是錯的：只要圖片的 base64 超過約 2 MiB（原始檔約 1.5 MB），就一定畫不出來。

- **修法：交給 CSS 的改成 `blob:` URL，而不是 data URL。** 新增 `src/shared/wallpaper-url.ts`：把 data URL 的 base64 解回位元組、包成 `Blob`、產生 object URL（幾十個字元，不論圖片多大）。`paintLook()` 與 `measure()` 都走這一條，所以宣告值永遠是短的、永遠會被接受；同時瀏覽器的圖片載入器直接吃位元組，不需要讓樣式系統去解析好幾 MB 的文字。
  - object URL 依 data URL 快取（`applyAppearance` 每次設定刷新都會跑，包含每次視窗取得焦點），換圖時會 `revokeObjectURL` 回收上一張，所以連續試圖只會留一份。
  - 轉換失敗（手改過的設定、非 base64 的 data URL）時退回原本行為，不會變成空白。
  - **CSP 只放寬一個字**：`img-src 'self' data: blob:`。仍舊沒有任何遠端內容：blob URL 只能由這個視窗裡已在執行的腳本建立，而這個視窗不載入任何遠端內容。
  - 迴歸測試 `tests/unit/wallpaper-url.test.ts`（5 項）把重點放在**「宣告裡拿到的不能是 data URL」**——也就是這個 bug 真正違反的那件事：給 CSS 的是 blob URL 且長度遠低於上限、位元組與 MIME 逐位元組相同、連 8 MB 上限換算出來的最壞情況（約 11 MB）也仍是短的、以及非 base64 輸入會退回原值。

## 說明

- **擴充功能不受影響**，這一版也不需要重新載入擴充功能。
- 這一版沒有改動 aria2 引擎、下載選項、排程或介面文字。
- 已經設定好的背景圖**不需要重新選擇**：升級後第一次啟動就會用新的路徑重畫。

## 驗證

- `npm run typecheck` 通過（node 與 web 兩份 tsconfig）
- `npm test`：**708 項測試通過（56 個檔案）**（0.1.34 為 703 項；新增的 5 項就是 `wallpaper-url.test.ts`）
- **上限本身以真實 Chromium 量測**（不是推測）：對 CSS 自訂屬性做二分搜尋，2,097,152 字元的宣告被接受、再長就被丟棄且屬性保持未設定（`computedStyle` 讀到 `none`）；同時確認同一支 2.7 MB data URL 以 `new Image()` 載入成功——證明問題只在 CSS 這條路。
- **修法在真實瀏覽器、走真實 UI 驗證**：以開發用 UI（`npm run dev:ui`，mock bridge）載入 `localhost`，把 `readImage` 換成 **2,352,514 字元**的 PNG data URL（與回報的 2,364,382 同級），再**實際按下設定頁的「選擇圖片」**。結果：宣告 70 個字元、被接受、內容是 `blob:` 且不含 base64；`data-wallpaper="on"`、圖層 `display:block`、`body` 透明、`--wallpaper-size` 已被算出（代表圖片真的解碼並套用了裁切幾何）；把面板不透明度降到 30% 後截圖可見整張圖貼在介面之後。修正前同樣的流程會得到 `none`。
- **CSP 放寬的那一個字也一併驗證**：在帶有本專案原始 CSP 的頁面上，`blob:` 圖片的載入會被**擋掉**（`img-src 'self' data:`），加入 `blob:` 之後載入與繪製都成功；因此這一版的 CSP 變更是必要且足夠的。
- **封裝後的產物確含這批變更**，且兩個部分各自出貨：
  - 渲染端：`app.asar` 內的 `out/renderer/index.html` 帶著新的 CSP（`img-src 'self' data: blob:`），打包後的 JS 內可找到 blob 轉換邏輯。
  - 擴充功能不在 `app.asar` 內，而是以獨立資源目錄出貨；這一版未改動它，內容與 0.1.34 相同。
  - 安裝檔與免安裝版皆為有效的 PE 檔（`MZ`）。
- 未以自動化驗證、需人工確認的部分：真實 Windows 視窗（Electron）而非開發預覽中的顯示結果——不過上限是 Blink 本身的行為、兩邊是同一個 Chromium 130，且開發預覽跑的是同一份 `appearance.ts` 與同一條 CSP。

## 下載

- `AriaDM-0.1.35-setup.exe` — 安裝版（NSIS, x64），約 190 MB
- `AriaDM-0.1.35-portable.exe` — 免安裝版，約 190 MB

## 校驗碼（SHA-256）

```
41f6d21180bbfc7f223bc3811f9ebdd1c854c92e10dab046c19e149d1c9bf044  AriaDM-0.1.35-setup.exe
886bd621b07de83311c111f1a724d5df294077af764eb2f7c5c0d5ae93cfa8ec  AriaDM-0.1.35-portable.exe
```

以上雜湊**就是本頁隨附的兩個安裝檔**（本機 `npm run dist` 建置：electron-builder 25.x、Electron 33.4.11、x64）。推送 `v0.1.35` tag 也會觸發 CI 建置，但 CI 產出的是工作流程產物（artifact 名稱 `installers`），**與本頁發佈的檔案不會逐位元組相同**；請以本頁隨附的檔案為準。

## 內建第三方二進位檔

| 程式 | 版本 | 授權 |
| --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | GPL v2+ |
| yt-dlp (`yt-dlp.exe`) | 2026.08.19 | Unlicense |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | BtbN win64-gpl (latest) | GPL v3 |

安裝檔未進行程式碼簽章，Windows SmartScreen 可能會顯示警告。
