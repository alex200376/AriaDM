## 變更

- **正在播放的播放器，本身就是面板該出現的理由（第三種回報的 `blob:` 播放器）。** 回報的標記是這樣：

  ```html
  <video id="lelevideo" class="leleplayer-video leleplayer-video-current"
         playsinline webkit-playsinline preload="auto"
         src="blob:https://play.777tv.ai/5f2b02ab-8d3e-4e38-a640-d6cbf85a5b05"></video>
  ```

  這一類（MSE）播放器有兩個麻煩：DOM 裡沒有任何檔名（`blob:` 只是指向頁面腳本自己建立的物件），而站台若把 manifest 與片段簽章化、逐一請求，Resource Timing 裡也就不會出現可辨識的串流。0.1.33 的兩條路都因此落空，於是回頭去問應用程式——偏偏這類站台對非瀏覽器請求一律回 403，應用程式只能回答「unknown」，面板就永遠不出現在使用者明明正在看影片的頁面上。

  現在掛載條件多了第三項：**元素正在播放**。`isPlaying()` 讀的是元素自己，不是頁面標記——未暫停、未結束、播放位置已前進、且已解碼出畫面（`readyState >= 2`）。那是任何播放器都藏不掉的證據，而且完全在本機判斷，所以按鈕立刻出現、少一次抓頁。

  - 判斷**不看 `id`、`class` 或任何選擇器**：掃描是 `querySelectorAll('video, audio')`，含 shadow root 與每個 iframe，再取畫面上最大的那一個。因此「其他類似的元素」自動涵蓋，改站台、改類名都不影響。
  - **佔位、預載、暫停、已結束**的播放器都不算——那些情況仍然照舊先問應用程式一次，不會在沒有影片的頁面上冒出按鈕。
  - 送出的是頁面網址，因為這一類頁面沒有更好的答案；`itemUrlNear()` 的順序不變（能具名的位址永遠優先，見 0.1.33）。規則集中在 `urls.js` 的 `localMediaEvidence()`，`content.js` 只是呼叫它，因此可以測試。

## 修正

- **指令發出的 poll 被丟掉，剛刪除的下載變成幽靈。** `tick()` 原本一開頭就是 `if (this.inFlight) return`；當刪除動作碰上正在跑的輪詢，`remove()` 結尾那一次 tick **整批被略過**，於是檔案已刪、歷史紀錄已刪，`getItems()` 卻還回報那一筆，直到下一次排程輪詢（預設 150 ms，應用程式為 1 s）才消失。現在：
  - tick 會**排隊**（`tickChain`），所以指令的 tick 一定跑在指令之後，指令返回時讀到的狀態就是指令造成的結果；
  - 排程輪詢仍然會跳過進行中的那一輪（`poll()`），否則引擎一慢就會堆積出一長串待跑的 tick；
  - `remove()` 清除 aria2 的 stopped 結果後會**強制重讀 stopped 清單**（`invalidateStopped()`）：forceRemove 與 purge 會讓引擎的 `numStopped` 一升一降、淨變化為零，只靠計數器簽章判斷有可能把已刪除的項目留在清單裡。

  這個競態是 0.1.33 新增的 tick 契約測試逼出來的（同一檔案連續執行約 **2/3 失敗**）；修好後連續 **6 次全過**，並以 0.1.32 的 `manager.ts` 對照確認舊版同樣會發生（3 次皆為綠燈的那 3 次只是還沒踩到）。

## 說明

- **擴充功能需要重新載入一次**（`chrome://extensions` 按重新載入，或重新「載入未封裝項目」）；安裝版會把新的建置一起裝進去。
- 這一版**沒有**改動 aria2 引擎、下載選項、排程行為或介面文字。
- `localMediaEvidence()` 的第二項（正在播放）只在**未知站台**的掛載判斷上生效；已知站台（`media-sites.json`）的行為不變。

## 驗證

- `npm run typecheck` 通過（node 與 web 兩份 tsconfig）
- `npm test`：**703 項測試通過（55 個檔案）**
- **tick 契約與刪除競態以真的 aria2 驗證**（`tests/integration/engine.test.ts`）：連續 6 次執行皆為 **13/13** 通過；修好前同一檔案約 2/3 的執行會失敗在 `refuses a duplicate of something already in flight unless asked to`（剛剛刪除的項目仍在 `getItems()` 裡）。
- **擴充功能的判斷以 `tests/unit/extension-urls.test.ts`（51 項，0.1.33 為 46）驗證**，新增 5 項針對第三次回報的播放器：
  - `localMediaEvidence` 在「`blob:`、頁面沒說出任何位址、但正在播放」時為 true（面板出現，不問應用程式）；
  - 同一個元素**暫停／載入中／已結束**時為 false（仍照舊問應用程式）；
  - 有具名位址時（`<source src>`、或 Resource Timing 讀到的 manifest）true——與是否正在播放無關。
  - `isPlaying` 另以 2 項驗證：播放中為 true；暫停、`currentTime` 為 0、已結束、`readyState` 未達 2、`null` 皆為 false。
- **擴充功能的產物與原始碼逐位元組相同**（`src/`、`chrome/`、`firefox/` 三處的 `urls.js` 與 `content.js` SHA-256 一致），並確認封裝後的 `dist/win-unpacked/resources/extension/` 也是同一份。
- **封裝後的產物確含這批變更**：`app.asar` 內可找到 `localMediaEvidence` 與 `isPlaying`，`resources/extension/chrome/urls.js` 亦同；安裝檔與免安裝版皆為有效的 PE 檔（`MZ`）。
- 未以自動化驗證、需人工確認的部分：面板在真實瀏覽器上對這類 MSE 播放器的行為——需要載入未封裝擴充功能並造訪實際站台；`isPlaying` 依賴的 `readyState`、`currentTime` 只有真實播放中才有值。

## 下載

- `AriaDM-0.1.34-setup.exe` — 安裝版（NSIS, x64），約 190 MB
- `AriaDM-0.1.34-portable.exe` — 免安裝版，約 190 MB

## 校驗碼（SHA-256）

```
905a96fca4afdcd3c4f37e9ba4db6e81f217bdda1c4b9f023f072513a14e177b  AriaDM-0.1.34-setup.exe
0eb1f74dd970277f8dfae1f725f3e46504583e82d1bd61cdcf9a45c9e9abe8fa  AriaDM-0.1.34-portable.exe
```

以上雜湊**就是本頁隨附的兩個安裝檔**（本機 `npm run dist` 建置：electron-builder 25.x、Electron 33.4.11、x64）。推送 `v0.1.34` tag 也會觸發 CI 建置，但 CI 產出的是工作流程產物（artifact 名稱 `installers`），**與本頁發佈的檔案不會逐位元組相同**；請以本頁隨附的檔案為準。

## 內建第三方二進位檔

| 程式 | 版本 | 授權 |
| --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | GPL v2+ |
| yt-dlp (`yt-dlp.exe`) | 2026.08.19 | Unlicense |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | BtbN win64-gpl (latest) | GPL v3 |

安裝檔未進行程式碼簽章，Windows SmartScreen 可能會顯示警告。
