@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
echo 源码模式启动内核，端口见 data\config.json（默认 8787）
echo 自检用：start-dev.cmd --doctor
echo.
"%NODE%" server.js %*
pause

