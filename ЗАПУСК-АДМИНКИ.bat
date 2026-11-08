@echo off
chcp 65001 >nul
title Админка ЖКС
cd /d "%~dp0admin"
echo Админка запускается на http://127.0.0.1:4777
echo Не закрывайте это окно, пока работаете с админкой.
node server.mjs
pause
