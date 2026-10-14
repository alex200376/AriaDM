## 修正

- **取消下載後，`.part` 與分段檔會一直留在下載資料夾。** 這是回報的問題，附圖就是一整排 `index [index].mp4.part`、`index [index].mp4.part-FragN`、`index [index].mp4.ytdl`：

  - yt-dlp **不會**直接寫入目標檔。位元組先寫進 `<name>.part`，完成後才改名成 `<name>`；HLS/DASH 這類分段下載的每一塊是 `<name>.part-FragN`，還在收的那一塊再多一層 `.part`（`<name>.part-FragN.part`），另外還有一個 `<name>.ytdl` 記錄續傳狀態。
  - 而取消／移除時，程式只刪 `job.outputPaths` 裡的檔案，那份清單**要等某一段被「搬進定位」之後才會有值**。下載途中被取消的那一筆——也正是留下最多垃圾的情況——清單還是空的，於是**一個檔案都沒刪到**；即使按的是「移除並刪除檔案」也一樣，因為它連檔名都還不知道。
  - 舊碼另外也漏掉了 `.part-FragN` 與 `.ytdl`：它只刪 `<target>` 和 `<target>.part` 兩個名字。回報的截圖裡，`marvel rivals invisible woman…` 那一組與 `index [index].mp4…` 那一組都是同一個原因。

- **修法：新增 `src/main/media/partial-files.ts`，用「名字」認出工作檔並清掉。**

  - 名字來自兩份記錄：`outputPaths`（已完成的檔）與 `job.streams`（yt-dlp 執行中回報的實際檔名，也就是 `%(progress.filename)`）。後者才是關鍵——被取消的那一筆只有它知道檔名，而分段下載時它甚至會直接報出分塊的名字（`…mp4.part-Frag7.part`），所以也一併處理。
  - 每個名字會先化約回下載本身的名稱（剝掉 `.part`、`.part-FragN`），再比對 `<name>.part`、`<name>.part-FragN`、`<name>.part-FragN.part`、`<name>.ytdl`，以及 ffmpeg 合併時的 `<name>.temp.<ext>`。比對是**整段相等**而不是前綴：`a video.mp4.partial-notes.txt` 這種只是開頭相同的檔案不會被誤刪。
  - 掃描範圍只有該檔案所在的那個資料夾，且只刪這些名字；回報中的 `.part` 檔名一律如此，所以不會動到使用者自己放在同一個資料夾裡的東西（測試有涵蓋）。

- **取消未完成的下載時也會清掉這些工作檔，不必勾「刪除檔案」。** 理由不是為了省事：`.part` 沒有任何檢視器打得開，而列被移除之後也沒有東西能續傳它（`-c` 只續傳 App 還知道的下載）。「刪除檔案」的語意因此不變——它仍然只決定**完成檔**要不要一起刪；而**暫停完全不會動 `.part`**，暫停不是取消。

- **刪除前先等行程真的結束。** 這是同一個 bug 的另一半，也是為什麼「就算知道檔名」也刪不掉：Windows 上**另一個行程還開著的檔案根本無法刪除**（不是排到關閉後才刪，是直接失敗），而 `kill()` 只是送出訊號——`taskkill /T /F` 還在跑、子行程還握著 `.part`。現在 `YtDlpRunner` 多了一個 `exited`（在 `close` 事件才 resolve，代表 handle 已釋放），取消流程先 `await` 它（上限 2 秒）才開始刪；刪除本身另有最多 5 次、每次遞增 150ms 的重試，收掉剩下的競態。無法刪除時會寫進應用程式記錄，不再無聲無息。

## 說明

- 這一版**沒有**改動 aria2 引擎、下載選項、排程、介面文字與擴充功能；**擴充功能不需要重新載入**（manifest 版本與 0.1.34～0.1.36 相同）。
- **aria2 的下載行為不變。** aria2 的續傳狀態是自己的 `.aria2` 控制檔，而且它有 `--continue=true`，所以「移除」時保留部分資料是刻意的——這一版只處理 yt-dlp 引擎（也就是會產生 `.part`／`.part-FragN`／`.ytdl` 的那條路）。
- 取消之後若用同一條連結重新下載，會從 0 開始（工作檔已清掉）。想保留續傳資料請用「暫停」。

## 驗證

- `npm run typecheck` 通過（node 與 web 兩份 tsconfig）。
- `npm test`：**742 項測試通過（59 個檔案）**（0.1.36 為 731 項；新增 8 項 `tests/unit/media-cancel-cleanup.test.ts` ＋ 3 項 `tests/integration/media-cancel.test.ts`）。
- **以真實 yt-dlp 端對端驗證**（`tests/integration/media-cancel.test.ts`；使用專案內建的 yt-dlp 對本機 fixture 伺服器下載，取消後檢查資料夾實際內容）：
  - **分段下載**（HLS，`--concurrent-fragments 4`）取消前，資料夾裡就是回報的那一組：`hls-cancel.mp4.part`、`hls-cancel.mp4.part-Frag1.part`、`…Frag2.part`、`…Frag3.part`、`…Frag4.part`、`hls-cancel.mp4.ytdl`。取消後 `readdir` **為空**，且記錄裡沒有任何 `failed to delete`。
  - **單檔下載**取消前是 `cancel-me.unknown_video.part`，取消後為空。
  - **同一組整合測試在舊碼上會失敗**（把 `jobs.ts` 與 `ytdlp.ts` 還原成 0.1.36 後重跑，3 項全數失敗，訊息就是 `expected [ 'hls-cancel.mp4.part', …(5) ] to deeply equal []`）。這證明測到的是回報的 bug 本身，而不只是「新碼會通過」。
  - **暫停**：暫停後 `.part` 仍在（續傳因此仍然便宜），列被移除之後才消失。
- 單元測試（8 項）涵蓋名稱辨識（Windows 路徑與中文檔名、`my.part.song.mp4` 不被誤判、`…partial-notes.txt` 不被誤刪、`.temp.mp4` 算工作檔）與 MediaJobs 的行為（先等行程結束才刪、刪除範圍、無關檔案與 `holiday photo.jpg` 不受影響）。同一組測試在舊碼上有 6 項失敗。
- **封裝後的產物確含這批變更**：`app.asar` 內可找到新的比對式樣（`part(-Frag`、`temp(\.[A-Za-z0-9]`）、`markExited` 與 `failed to delete`，版本字串為 `0.1.37`；擴充功能仍以獨立資源目錄出貨、內容與 0.1.36 相同；兩個安裝檔皆為有效的 PE 檔（`MZ`）。
- 未以自動化驗證、需人工確認的部分：安裝後在真實 Electron 視窗按「取消」的顯示結果。取消走的是同一條主行程路徑（`mediaJobs.remove`），單元與整合測試都直接呼叫它，但視窗本身沒有自動化。

## 下載

- `AriaDM-0.1.37-setup.exe` — 安裝版（NSIS, x64），約 189 MB
- `AriaDM-0.1.37-portable.exe` — 免安裝版，約 189 MB

## 校驗碼（SHA-256）

```
1277369784b3f0a2308d967d79ab6959588aa94034e3865eb15ab32fffa916f3  AriaDM-0.1.37-setup.exe
9c46223f9fd1be4f4b9e6f75f5d948c3143b686ae0735c5bbd14a372ca555393  AriaDM-0.1.37-portable.exe
```

以上雜湊**就是本頁隨附的兩個安裝檔**（本機 `npm run dist` 建置：electron-builder 25.x、Electron 33.4.11、x64）。推送 `v0.1.37` tag 也會觸發 CI 建置，但 CI 產出的是工作流程產物（artifact 名稱 `installers`），**與本頁發佈的檔案不會逐位元組相同**；請以本頁隨附的檔案為準。

## 內建第三方二進位檔

| 程式 | 版本 | 授權 |
| --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | GPL v2+ |
| yt-dlp (`yt-dlp.exe`) | 2026.08.19 | Unlicense |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | BtbN win64-gpl (latest) | GPL v3 |

安裝檔未進行程式碼簽章，Windows SmartScreen 可能會顯示警告。
