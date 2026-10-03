@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS or newer, then reopen this launcher.
  pause
  exit /b 1
)
if not exist node_modules\yauzl\package.json (
  echo Run npm ci --ignore-scripts in this repository first.
  pause
  exit /b 1
)
node tools\companion\cli.mjs --open
if errorlevel 1 (
  pause
  exit /b 1
)
