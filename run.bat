@echo off
setlocal
cd /d "%~dp0"

if not exist "out\main\index.js" (
  echo [錯誤] 尚未建構，請先執行 compile.bat 或 build.bat。
  pause
  exit /b 1
)

if not exist "resources\bin\aria2c.exe" (
  echo [錯誤] 找不到 aria2 引擎，請執行 install.bat。
  pause
  exit /b 1
)

echo 啟動 AriaDM...
call npx electron .
exit /b %errorlevel%
