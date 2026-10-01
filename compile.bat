@echo off
setlocal
cd /d "%~dp0"

echo === AriaDM :: 型別檢查與編譯（不打包）===
call npm run build
if errorlevel 1 (
  echo.
  echo [錯誤] 編譯失敗，請看上方訊息。
  pause
  exit /b 1
)

echo.
echo 編譯完成。執行 run.bat 啟動，或 build.bat 產生安裝檔。
pause
exit /b 0
