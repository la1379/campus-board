@echo off
chcp 65001 >nul
cd /d "%~dp0"

title 校招看板 - 发布

echo.
echo   校招看板 · 一键发布
echo   ==================
echo.
echo   这个会把当前数据生成网页并传到 GitHub，
echo   同学刷新就能看到最新内容。
echo.
echo   如果还没导入新数据，先关掉这个窗口，
echo   跑 start.bat 打开后台导入 Excel。
echo.

set /p CONFIRM=继续发布？(Y/N):
if /i not "%CONFIRM%"=="Y" goto :cancel

echo.
node scripts/deploy.mjs

if errorlevel 1 (
  echo.
  echo   [失败] 上面有错误信息，截图发我。
) else (
  echo.
  echo   [完成] 等 30 秒左右，同学刷新就是新的了。
)

echo.
pause
exit /b

:cancel
echo 已取消。
pause
exit /b
