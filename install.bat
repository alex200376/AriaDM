@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  AriaDM :: 安裝相依套件與執行檔
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 Node.js。請先安裝 Node.js 20 或更新版本：https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VERSION=%%v
echo [1/5] Node.js !NODE_VERSION!
echo.

echo [2/5] 安裝 npm 相依套件（第一次會比較久）...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [錯誤] npm install 失敗。
  pause
  exit /b 1
)
echo.

echo [3/5] 下載 aria2 引擎（版本已釘選，並驗證 SHA-256）...
call node scripts/fetch-aria2.mjs
if errorlevel 1 (
  echo [錯誤] 無法取得 aria2。可改用系統安裝的 aria2c，或在設定中指定路徑。
  pause
  exit /b 1
)
echo.

echo [4/5] 產生應用程式圖示...
call node scripts/generate-icons.mjs
if errorlevel 1 goto :failed
echo.

echo [5/5] 組裝瀏覽器擴充功能...
call node scripts/build-extension.mjs
if errorlevel 1 goto :failed
echo.

echo ============================================
echo  安裝完成
echo ============================================
echo   dev.bat      開發模式（熱重載）
echo   compile.bat  僅編譯，快速驗證
echo   build.bat    完整建構並產生安裝檔
echo   run.bat      啟動已建構的應用程式
echo   test.bat     執行測試
echo.
pause
exit /b 0

:failed
echo [錯誤] 產生資源時失敗。
pause
exit /b 1
