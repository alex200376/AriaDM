# AriaDM

以 [aria2](https://aria2.github.io/) 為引擎的現代化下載管理器，介面取向類似 IDM，
但補上 IDM 沒有的東西：BitTorrent、Metalink、影音下載、佇列排程、瀏覽器接管。

Electron + React + TypeScript + Tailwind，aria2 以子程序方式內嵌，不需要使用者自行安裝。

---

## 快速開始

```bat
install.bat      :: 安裝相依套件、下載 aria2、產生圖示與擴充功能
dev.bat          :: 開發模式（熱重載）
```

正式建構與啟動：

```bat
build.bat        :: 型別檢查 → 打包 → 產生安裝檔與免安裝版（dist\）
run.bat          :: 啟動已建構的應用程式
compile.bat      :: 只做型別檢查與打包，開發時最快
test.bat         :: 執行全部測試
```

需求：Windows 10/11 x64 與 Node.js 20+。

建構產物：

| 檔案 | 用途 |
| --- | --- |
| `dist\AriaDM-<版本>-setup.exe` | NSIS 安裝檔（可自選安裝路徑、建立捷徑） |
| `dist\AriaDM-<版本>-portable.exe` | 免安裝單一執行檔 |
| `dist\win-unpacked\` | 未封裝目錄，除錯時直接執行 `AriaDM.exe` |

兩個 target 預設會輸出同一個檔名，因此 `electron-builder.yml` 明確分開命名——
否則免安裝版會無聲覆蓋掉安裝檔。

---

## 架構

三層，每個信任邊界只跨越一次：

```
aria2c 子程序（只聽 127.0.0.1，每次啟動產生隨機 rpc-secret）
      ▲ JSON-RPC over HTTP ＋ WebSocket
      │
Electron 主行程（唯一的信任邊界）
  ├─ 監督 aria2c：啟動、健康檢查、當掉重啟、日誌環狀緩衝
  ├─ 輪詢與狀態合併（1 Hz system.multicall）＋ 事件（WebSocket 通知）
  ├─ 自有歷史紀錄、設定、排程、整合、工具下載
  └─ rpc-secret 只存在這裡，渲染行程拿不到
      ▲ contextBridge（contextIsolation 開、nodeIntegration 關、sandbox 開）
      │
渲染行程（React，無法直接觸及 Node 或檔案系統）
```

### 為什麼是「WebSocket ＋ 輪詢」兩套

aria2 的 `onDownload*` 通知只走 WebSocket，HTTP JSON-RPC 完全沒有通知機制。所以：

- **WebSocket**：拿到 `onDownloadComplete`、`onDownloadError` 這類離散事件，反應即時。
- **1 Hz `system.multicall`**：位元組級進度需要連續取樣，一次往返抓完
  `tellActive` / `tellWaiting` / `tellStopped` / `getGlobalStat`，進度條才平滑。

輪詢是狀態的來源，通知只用來縮短延遲，不負責建立狀態——這樣事件漏掉也不會讓 UI 說謊。

---

## 功能

**下載引擎**

- HTTP／HTTPS／FTP／SFTP，多連線分段下載（`split` 最高 16）
- BitTorrent：magnet、`.torrent`、DHT、PEX、LPD、檔案選擇、做種比例
- Metalink
- 續傳：aria2 的工作階段檔 ＋ 我們自己的歷史紀錄，重開機後仍在
- 全域與單項限速、暫停／繼續、排序、重試、改選項

**介面**

- 虛擬化清單（`@tanstack/react-virtual`），上萬筆也不卡
- 即時速度曲線、ETA、連線數、分段進度
- 詳情抽屜：**分片檢視**、檔案、節點、伺服器、mirror 狀態、可調選項
- 分片檢視：aria2 對 HTTP 分段下載與 BitTorrent 都會回報 bitfield，因此兩種
  下載都能看到逐格的分片完成度（部分完成的格子會標成紫色，而不是被四捨五入）
- 命令面板（`Ctrl+K`）、狀態篩選、分類、全文搜尋
- 深／淺色主題、密度切換、系統匣與常駐

**整合**

- **瀏覽器擴充功能**（Chrome／Edge／Firefox）：右鍵下載、接管瀏覽器下載、
  一次送出整頁連結，並附上 cookie／referer／user-agent
- **影音下載**：內建 yt-dlp 與 ffmpeg，可選格式並自動合併音軌
- **剪貼簿監看**：複製到連結就提示加入
- **排程**：依星期與時段套用不同的速度設定檔
- **完成後動作**：開檔、開資料夾、通知、自訂指令（`%f` `%d` `%n`，以 execFile 傳參數執行）

---

## 外部執行檔

三個外部工具都不預設要你自己裝，但都可以用系統版本覆蓋：

| 工具 | 取得方式 | 備註 |
| --- | --- | --- |
| `aria2c` | 首次啟動或 `npm run fetch:aria2` | **版本釘選並驗證 SHA-256** |
| `yt-dlp` | 內建於安裝檔 | 版本釘選，驗證上游 `SHA2-256SUMS` |
| `ffmpeg` | 內建於安裝檔（`ffmpeg.exe` + `ffprobe.exe`） | 用於合併影音 |

三個工具都內建在安裝檔裡，所以裝好即可用，不必先下載任何東西。
建置時由 `npm run fetch:aria2`、`fetch:ytdlp`、`fetch:media` 放進 `resources/bin/`，
electron-builder 再把它們打包進去；這也正是安裝檔偏大的原因（ffmpeg 的靜態建置就占了約 336 MB）。
「設定 → 工具與引擎」的重新下載只用於換成較新的版本，會安裝到使用者資料夾並覆蓋內建版本。

aria2 的雜湊必須由我們自己釘選：GitHub release API 對這個資產回報 `digest: null`，
上游沒有公布可驗證的值。第一次抓取時算出並寫進 `scripts/aria2-manifest.json`，
之後每次啟動都會比對；不符就擋下並提示重新下載。

版本刻意釘在 1.37.0（2023 年 11 月）：上游發版節奏自那之後就停滯，
跟著 `latest` 走等於把使用者的環境交給一個不確定的目標。

---

## 專案結構

```
AriaDM/
├── src/
│   ├── shared/      共用型別與純函式（格式化、URI、錯誤表、IPC 契約）
│   ├── main/        主行程
│   │   ├── aria2/   supervisor（子程序）、rpc-client、選項對應、工作階段
│   │   ├── downloads/  manager（輪詢與命令）、history-store、categorizer、speed-meter
│   │   ├── integrations/ handoff API、排程、剪貼簿、完成後動作
│   │   ├── media/   yt-dlp 工作
│   │   └── ipc/     IPC 處理器
│   ├── preload/     contextBridge 白名單
│   └── renderer/    React UI（含 mock-bridge，可在瀏覽器獨立預覽）
├── scripts/         取得外部工具、產生圖示、組裝擴充功能
├── resources/       bin（aria2c）、icons、extension
├── tests/           unit 與 integration
└── *.bat            見上方
```

---

## 測試

```bat
test.bat
```

- **unit**：格式化、檔名消毒、URI 分類、錯誤碼對應、aria2 參數對應、分類規則、
  速度取樣、歷史查詢。
- **integration**：啟動**真正的 aria2c**，對本機 fixture 伺服器（支援 Range）下載，
  驗證位元組級正確性（SHA-256）、404 錯誤碼對應、續傳、暫停後位元組不再增加、
  重複偵測、佇列閒置事件。
- **rpc-protocol**：把 aria2 RPC 的參數形狀釘住。這個檔案存在的原因很實際——
  以下兩點都在開發時真的踩到，而且症狀都是同一個 HTTP 400：
  1. 省略的選擇性參數不能以 `null` 送出；
  2. `system.multicall` 的權杖要放在每個子呼叫裡，不能放在最外層。

UI 可以在瀏覽器裡獨立跑，不需要引擎：`npm run dev:ui` 會啟動一個 mock bridge 版本。

---

## 已知限制

- **安裝檔未簽章**：首次執行會有 Windows SmartScreen 警告。
- **aria2 版本固定在 1.37.0**：升級需要手動更新 manifest 中的版本與雜湊。
- **擴充功能未上架**：目前以「載入未封裝項目」方式安裝，見
  [resources/extension/README.md](resources/extension/README.md)。
- **安裝檔偏大**：aria2、yt-dlp、ffmpeg 都內建，其中 ffmpeg 的靜態建置就約 336 MB。
  要更新這三個工具只能重新安裝新版。
- **Playwright E2E 尚未撰寫**：`test:e2e` 已接好，測試案例待補。

---

## 授權

MIT。aria2、yt-dlp、ffmpeg 各自為獨立專案，版權與授權見其原始碼庫；
AriaDM 隨附的是它們的官方發行檔，因此安裝檔同時散布這些第三方二進位檔，
個別授權與版本詳見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
