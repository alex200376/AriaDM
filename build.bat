@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  AriaDM :: 完整建構
echo ============================================
echo.

if not exist "resources\bin\aria2c.exe" (
  echo [提示] 找不到 aria2 引擎，正在下載...
  call node scripts/fetch-aria2.mjs || (echo [錯誤] 無法取得 aria2。 & pause & exit /b 1)
)

if not exist "resources\extension\chrome\manifest.json" (
  echo [提示] 組裝瀏覽器擴充功能...
  call node scripts/build-extension.mjs || (echo [錯誤] 擴充功能建置失敗。 & pause & exit /b 1)
)

echo [1/2] 型別檢查與打包...
call npm run build
if errorlevel 1 (
  echo [錯誤] 打包失敗。
  pause
  exit /b 1
)
echo.

echo [2/2] 產生安裝檔與免安裝版...
call npx electron-builder
if errorlevel 1 (
  echo [錯誤] electron-builder 失敗。
  pause
  exit /b 1
)
echo.

echo ============================================
echo  建構完成，產物在 dist\
echo ============================================
echo   AriaDM-*-setup.exe     安裝檔（NSIS，可選安裝路徑）
echo   AriaDM-*-portable.exe  免安裝單一執行檔
echo   win-unpacked\          未封裝的執行目錄（除錯用）
echo.
echo 注意：產物未簽章，首次執行 Windows SmartScreen 會提出警告。
echo.
pause
exit /b 0
