@echo off
chcp 65001 >nul
cd /d "%~dp0"

title 校招看板 - 本地服务

echo.
echo   正在启动本地服务…
echo.

start "" http://127.0.0.1:7788/admin.html

node server.mjs

pause
