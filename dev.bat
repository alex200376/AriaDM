@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [錯誤] 尚未安裝相依套件，請先執行 install.bat。
  pause
  exit /b 1
)

if not exist "resources\bin\aria2c.exe" (
  echo [提示] 找不到 aria2 引擎，正在下載...
  call node scripts/fetch-aria2.mjs || (echo [錯誤] 無法取得 aria2。 & pause & exit /b 1)
)

echo 啟動 AriaDM 開發模式（關閉此視窗即結束）。
call npm run dev
exit /b %errorlevel%
