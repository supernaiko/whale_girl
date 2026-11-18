@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "NODE=%LOCALAPPDATA%\..\..\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=C:\Users\1\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

rem 服务没起就静默拉起
powershell -NoProfile -Command "if(-not (Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue)){ Start-Process -FilePath '%NODE%' -ArgumentList '%HERE%server.js' -WindowStyle Hidden }" >nul 2>&1

rem 用 Edge 的应用窗口打开：没有地址栏/标签页，看起来就是软件自带的一个面板
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" start "" http://127.0.0.1:8899 & exit /b
start "" "%EDGE%" --app=http://127.0.0.1:8899 --window-size=1120,820 --window-position=120,60
