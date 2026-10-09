## 變更

- **英文介面不再跳出中文。** 主行程與共用模組裡的使用者可見字串本來全部硬寫成中文——錯誤訊息、系統通知、系統匣選單、更新提示都是。切到 English 的人看到的介面是英文，但一下載失敗，通知與對話框裡的中文錯誤就冒出來了：`media-errors.ts` 的註解甚至寫著「a sentence to show the user, in the app's language」，而那些句子只有中文。這次把 138 條字串搬進字典（`en.ts` / `zh-TW.ts` 各 851 → 989 條），並補上真正的根因：**主行程從來沒有呼叫過 `setLocale`**，所以即使有字典，`t()` 永遠讀到預設的繁體中文。現在啟動時與語言設定變更時都會同步，系統匣也會跟著重建。
  - `aria2` 錯誤碼本來就是從字典取字的，這批只是把同一個模式補到其餘路徑（媒體錯誤分類、IPC 丟回的錯誤、引擎監督、更新流程、工具下載、完成後動作、品質選單標籤）。
  - 刻意**不動**的東西：會寫進設定檔或檔案名稱的字串（速度設定檔名稱、分類名稱、magnet 的預設檔名）、引擎日誌行、以及命令面板的搜尋關鍵字（中英並列才兩種語言都找得到）。

- **每秒的清單更新改成只送變更（delta）。** 以前每個 tick 都是整份清單：最多 1000 筆 stopped 結果被重新建立、跨行程複製、在渲染端重新渲染，即使整個佇列完全沒動。現在：
  - `TickPayload` 多了 `removedGids` 與 `full`；tick 只帶「這一秒重建過的項目」與「消失的 gid」，`full` 只出現在第一次（其餘由 `downloads:list` 提供基準）。
  - stopped 清單**不再每秒重抓**，而且解析後的物件會重用（終止狀態不會自己變），只有 `numStopped` / `numStoppedTotal` 變動、或使用者編輯了某個已結束項目的選項時才重讀。
  - 完全沒有變化、也沒有引擎狀態變化時，**整個 tick 不會送出**。
  - 渲染端（`shared/merge-items.ts`）按 gid 合併 upsert 與移除，保留原有順序；表格本來就依使用者選擇自行排序。

- **擴充功能：`blob:`（MSE）播放器也認得了。** 這一類播放器在 DOM 裡什麼都沒有——`<video src="blob:https://…">` 的位址只存在頁面自己的腳本裡，所以這種頁面以前看起來完全無法下載。現在會讀**頁面自己的 Resource Timing**：頁面抓過的 manifest 與媒體檔都在那份清單裡，而且不需要任何額外權限。
  - 只接受 HLS/DASH manifest 或已知媒體副檔名，廣告追蹤與縮圖不可能被當成影片。
  - 同一個站（主機名的後兩段，CDN 子網域算自己人）優先於第三方，同站之中取**最近一次請求**的那一個——那就是現在正在播的畫質層。
  - manifest 優先於單一檔案：一個請求就能拿到整部影片，而單一 fragment 只有幾秒。

- **擴充功能：無副檔名的來源也認得了。** 有些播放器的網址沒有副檔名（`/stream/18992745`），檔型寫在標記裡：`<source src="…" type="video/mp4">`。現在會讀這個 `type`，但**只在 http(s) 協定通過之後**才參考它，所以 `blob:`、`data:`、`mediastream:` 不會因為一個 `type` 屬性被升格成下載。

- **擴充功能：本機能確定檔案時，不再多問應用程式一次。** 面板在未知站台上會先請應用程式讀頁面；但**對非瀏覽器請求一律回 403 的站台（rule34 與所有 Cloudflare 前站）那個問題永遠得不到答案**，結果是使用者明明在看影片，面板卻永遠不出現。現在只要播放器的位址／頁面自己的下載連結／剛剛請求過的串流三者之一能確定，就直接掛上面板，完全不發問——既更可靠也少一次抓頁。

## 修正

- **`engine.*` 字串撞名。** 引擎監督行程的訊息原本也放在 `engine.*` 命名空間，與渲染端的引擎狀態標籤（`engine.starting` 等）正面衝突；已改為 `supervisor.*`。
- **品質選單的標籤與提示。** `media-formats.ts` 原本自帶一份中文標籤，與 `ytdlp.ts` 的新字典條目重複；現在兩邊共用同一組 `main.format.*` 字串。
- **兩個漏掉的可見字串**：速度圖表的 tooltip（`等待數據` / `峰值 …`）與對話框右上角的關閉鈕標籤（`關閉`），後者原本在英文介面下連螢幕閱讀器都會念中文。

## 說明

- **擴充功能需要重新載入一次**（`chrome://extensions` 按重新載入，或重新「載入未封裝項目」）；安裝版會把新的建置一起裝進去。
- `blob:` 那一項依賴 Resource Timing，只有在**真正在播放**的頁面上才有資料；面板出現的前提仍是該頁面確實有可量測的播放器。若某個站台把串流放在 iframe 裡，面板會在該 iframe 內運作（內容腳本本來就注入每個框架）。
- 未送出的 tick 不會影響系統匣與工作列進度：兩者在同一個回呼裡更新，與是否有新資料給渲染端無關。
- 這一版沒有改動 aria2 引擎、下載選項或排程行為。

## 驗證

- `npm run typecheck` 通過（node 與 web 兩份 tsconfig）
- `npm test`：**691 項測試通過（55 個檔案）**（0.1.32 為 680 項）
- `npm run build` 通過
- 字典完整性由既有測試守住：英文不得殘留中文、兩份字典的 key 與 `{placeholder}` 必須一致
- **tick 契約以真的 aria2 驗證**（`tests/integration/engine.test.ts`，新增 2 項）：第一個 payload `full: true`、其後一律 `full: false`；佇列靜止時抵達的 payload 全部是空的 delta（不會重送已結束的下載）；下載完成會以 upsert 出現一次，之後不再出現；移除會以 `removedGids` 送出。
- 渲染端的合併邏輯另以 `tests/unit/app-store-merge.test.ts`（5 項）驗證：新增、就地更新（不改變順序）、移除、同時變更與移除。
- **擴充功能的 URL 判斷以 `tests/unit/extension-urls.test.ts`（46 項）驗證**，其中新增的 10 項針對這次回報的兩種播放器：`<source src>` 的 mp4、以及 `blob:` 播放器對應的 resource timing（同站優先、廣告被排除、沒有可用資源時退回頁面網址、`type` 不能把 blob 升格成下載）。
- 應用程式端的 HTML 掃描另加一項測試，使用回報的實際標記：`<source src="…mp4">` 會被找到，而同一顆 `<video>` 上的 `poster` 縮圖不會被當成影片。
- **擴充功能的產物與原始碼逐位元組相同**（`urls.js`、`content.js` 等 11 個檔案在 `src/`、`chrome/`、`firefox/` 三處 SHA-256 一致），並確認兩個建置都含新的判斷邏輯。
- **封裝後的產物確含這批變更**（`dist/win-unpacked`）：`app.asar` 內可找到 `main.tray.backgroundTitle`、`supervisor.crashLoop`、`speedGraph.peak`、`main.update.installerGone` 等新字串；附帶的擴充功能（`resources/extension/chrome/urls.js`）含 `observedStreamAddress`。安裝檔與免安裝版皆為有效的 PE 檔（`MZ`）。
- 未以自動化驗證、需人工確認的部分：面板在真實瀏覽器上對 `<source>`、`blob:`（MSE）與 shadow DOM 播放器的行為——需要載入未封裝擴充功能並造訪實際頁面；Resource Timing 的可見性也只能在真實頁面上確認。

## 下載

- `AriaDM-0.1.33-setup.exe` — 安裝版（NSIS, x64），約 190 MB
- `AriaDM-0.1.33-portable.exe` — 免安裝版，約 190 MB

## 校驗碼（SHA-256）

```
d17dc06a30aad173b2ad3f2be4e92b8fcd7308031815d423aac201f343d7f974  AriaDM-0.1.33-setup.exe
56fb75b081c16ff45903c70ba69002777ce3e24f209701b9ac1e9466b0390cf4  AriaDM-0.1.33-portable.exe
```

以上雜湊**就是本頁隨附的兩個安裝檔**（本機 `npm run dist` 建置：electron-builder 25.x、Electron 33.4.11、x64）。推送 `v0.1.33` tag 也會觸發 CI 建置，但 CI 產出的是工作流程產物（artifact 名稱 `installers`），**與本頁發佈的檔案不會逐位元組相同**；請以本頁隨附的檔案為準。

## 內建第三方二進位檔

| 程式 | 版本 | 授權 |
| --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | GPL v2+ |
| yt-dlp (`yt-dlp.exe`) | 2026.08.19 | Unlicense |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | BtbN win64-gpl (latest) | GPL v3 |

安裝檔未進行程式碼簽章，Windows SmartScreen 可能會顯示警告。
