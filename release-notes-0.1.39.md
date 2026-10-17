## 變更

延續 0.1.38 的佇列表格修正，這一版把先前整理出的鍵盤、空狀態、tooltip 與窄版資訊取捨一併做完。

- **列的動作按鈕現在會跟著鍵盤焦點出現。** 以前只有滑鼠移入或列被勾選時才 `opacity-100`，用 Tab 走進「暫停／資料夾／刪除」時按鈕（連同焦點外框）是透明的，等於對著看不見的 28px 目標按 Enter。動作欄現在加上 `focus-within`，焦點一到就顯示。

- **整張表只剩一個 Tab 停留點，方向鍵在列之間移動。**
  - 以前每一列都是 `tabIndex=0`，而且每一列的勾選框與四顆動作按鈕也各自是停留點；一千筆下載就是數千次 Tab。
  - 現在只有「目前列」在 Tab 順序裡（列本身、勾選框、動作按鈕），`↑`／`↓`／`Home`／`End` 移動焦點，虛擬列表會自動捲到該列。列的 `Enter` 開啟詳情，但只在焦點在列本身時生效——按在按鈕上的 Enter 只按那顆按鈕，不會再同時把詳情面板打開。

- **篩選到沒有東西時，說的是「為什麼沒有」而不是「這裡還沒有下載」。** 以前搜尋 `zzzz` 會得到「這裡沒有下載項目／貼上連結、拖入種子檔」和「新增下載」；現在分成三種：
  - 搜尋：`找不到符合的項目`，內文帶出關鍵字，按鈕「清除搜尋」。
  - 分類：`這個分類還沒有下載`，按鈕「顯示全部分類」。
  - 狀態：`這個狀態目前沒有下載`，按鈕「顯示全部下載」。
  - 優先順序是搜尋 → 分類 → 狀態；整個佇列本來就是空的時候仍顯示原本的「還沒有下載」，因為那時「新增下載」才是有用的建議。判斷抽成純函式 `queueEmptyReason`，有單元測試。

- **tooltip 改成應用程式自己的圖層，永遠留在視窗內。** 原本用原生 `title`，位置由作業系統決定，最右欄的動作泡泡會跑出視窗；現在 `IconButton` 與所有會被省略的文字（檔名、路徑、URL、時間、種子、分段格、視窗控制鈕……）都改走 `data-tip`，由同一個 fixed 圖層繪製：
  - 滑鼠停留 300ms 才出現，鍵盤聚焦立即出現；移到子元素（圖示）不會閃退。
  - 繪製後量測寬高再夾進 viewport（右緣、左緣、太窄的視窗都測過），不再有半個泡泡在窗外。
  - 唯一保留原生 `title` 的是標題列右上角的引擎指示燈：那裡是視窗拖曳區，滑鼠事件不會傳進 renderer，自訂圖層根本收不到 hover。

- **窄版不再犧牲速度。** 5 欄佈局（表格 < 690px，也就是 720px 最小視窗）原本直接隱藏速度欄；現在進行中的列會把速度顯示在進度條下方（`38.0%    11.3 MB/s`），並在那一列隱藏已下載位元組，避免三個數字擠在 112px 裡。完成／暫停的列沒有速度可顯示，仍保留位元組。用 `:has()` 判斷，不需要額外的 JS 狀態。

- **表格的無障礙語意補齊。** 外層是 `role="table"` 並帶 `aria-rowcount`，表頭是 `columnheader`，可排序欄位帶 `aria-sort`（`ascending`／`descending`／`none`），列有 `aria-rowindex`；列上的勾選框補上 `role="checkbox"` 與 `aria-checked`。讀屏使用者現在聽得到「哪一欄在排序、往哪個方向」。

- **`Ctrl+F` 不再靠翻譯後的 placeholder 找搜尋框。** 以前是 `input[placeholder="…"]`，語言一換或文案一改就失效；現在搜尋框有 `data-search`，並新增 `/` 快捷鍵（在輸入框裡按 `/` 仍是輸入字元）。

## 說明

- 這一版沒有改動 aria2 引擎、下載選項、排程與擴充功能；**擴充功能不需要重新載入**。
- 0.1.38 的 container query 欄位收合仍在，這一版只是在上頭補行為。
- 自訂 tooltip 只替換 `title` 屬性；元件自己的 `title` prop（例如對話框標題）不受影響。

## 驗證

- `npm run typecheck` 通過（node 與 web 兩份 tsconfig）。
- `npm test`：**752 項測試通過（61 個檔案）**（0.1.37 為 742 項；新增 10 項：`tests/unit/queue-empty.test.ts` 4 項、`tests/unit/tooltip-position.test.ts` 6 項）。
- **在開發用 UI（Chromium 130 / Electron 33）實際操作並量測**：
  - **720×664 最小視窗**：表格 540px、5 欄；錯誤列四顆按鈕仍在 x=590–708，`scrollWidth` = `clientWidth` = 540，`body.scrollWidth` = 720。
  - **速度**：進行中的列在 720px 顯示 `11.3 MB/s`（`.queue-inline-speed` 可見、位元組隱藏），`queue-progress-meta` 寬度仍為 112px 沒有溢出；1240px（9 欄）時 inline 速度隱藏、速度欄與位元組回來。
  - **鍵盤**：Tab 進入「重試」後，動作欄 `opacity` 為 `1`；列上只剩一個 `tabIndex=0`，`↓` 後焦點移到下一列且該列成為唯一停留點；勾選框在非目前列為 `tabIndex=-1`。
  - **tooltip**：聚焦「重試」後 `[role="tooltip"]` 出現、位置在按鈕上方且完整落在視窗內（x=584–624）；最右的「移除」泡泡為 x=671–712，沒有超出 720；列名省略時 hover 會顯示完整檔名。
  - **空狀態**：搜尋 `zzzz` 顯示「找不到符合的項目／目前檢視中沒有符合「zzzz」的下載」與「清除搜尋」；按下後列表與搜尋框都回到原狀。
  - **快捷鍵**：`/` 與 `Ctrl+F` 都會把焦點放到 `input[data-search]`。
  - **語意**：點「檔案名稱」後該表頭 `aria-sort="ascending"`，其他可排序欄位為 `none`，`aria-rowcount="9"`（8 列＋表頭）。
- **未以 UI 驗證、但由單元測試覆蓋的部分**：分類與狀態空狀態的分流。開發用 mock bridge 的「移除」只改記憶體陣列、不發 tick，畫面不會因此少一列，所以無法在預覽中把某個狀態清空；`queueEmptyReason` 的優先順序與「全新空佇列不顯示篩選文案」都有測試。
- **封裝後的產物確含這批變更**：`app.asar` 內可找到 `queue-inline-speed`、`data-search`、`TooltipLayer` 與版本字串 `0.1.39`；兩個安裝檔為有效 PE（`MZ`）。

## 下載

- `AriaDM-0.1.39-setup.exe` — 安裝版（NSIS, x64），約 189 MB
- `AriaDM-0.1.39-portable.exe` — 免安裝版，約 189 MB

## 校驗碼（SHA-256）

```
fb6e919e65763a541d98d574a06ebaa2aa815f37472d40cb1e77fb9dd86dccfc  AriaDM-0.1.39-setup.exe
76c0f05d13486bf26f3fe778c428da275a5a497db690b3ca19bce09ca88096c4  AriaDM-0.1.39-portable.exe
```

以上雜湊就是本頁隨附的兩個安裝檔（本機 `npm run dist` 建置：electron-builder 25.x、Electron 33.4.11、x64）。推送 `v0.1.39` tag 也會觸發 CI 建置，但 CI 產出的是工作流程產物（artifact 名稱 `installers`），**與本頁發佈的檔案不會逐位元組相同**；請以本頁隨附的檔案為準。

## 內建第三方二進位檔

| 程式 | 版本 | 授權 |
| --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | GPL v2+ |
| yt-dlp (`yt-dlp.exe`) | 2026.08.19 | Unlicense |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | BtbN win64-gpl (latest) | GPL v3 |

安裝檔未進行程式碼簽章，Windows SmartScreen 可能會顯示警告。
