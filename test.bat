@echo off
setlocal
cd /d "%~dp0"

echo === AriaDM :: 測試 ===
echo.
echo 整合測試會啟動真正的 aria2c 並綁定 loopback 連接埠，
echo 因此必須先執行過 install.bat（需要 resources\bin\aria2c.exe）。
echo.

call npx vitest run %*
if errorlevel 1 (
  echo.
  echo [失敗] 有測試未通過。
  pause
  exit /b 1
)

echo.
echo 全部測試通過。
pause
exit /b 0
