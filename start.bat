@echo off
rem LAST CORDON - one-click launcher: starts the local server and opens the game in your browser.
title LAST CORDON
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
set NEED=0
if not exist "node_modules\three\build\three.module.js" set NEED=1
if not exist "node_modules\ws\package.json" set NEED=1
if "%NEED%"=="1" (
  echo First run: fetching the runtime libraries ^(three.js for graphics, ws for multiplayer^)...
  call npm install --omit=dev --no-audit --no-fund
)
node server.mjs --open
pause
