@echo off
REM Serve Puzzle Solver+ to your phone over Tailscale (tailnet only, real HTTPS cert).
cd /d "%~dp0"
where node >nul 2>nul
if not %errorlevel%==0 (
  echo Node is required to run this. Install from https://nodejs.org
  pause
  exit /b 1
)
node phone.js
pause
