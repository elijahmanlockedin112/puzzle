@echo off
REM Camera access needs a secure context, and localhost counts as one.
REM Opening index.html straight off the disk works, but only for photo upload.
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8123
  node serve.js 8123
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8123
  python -m http.server 8123
  goto :eof
)
echo Need Node or Python installed to serve this folder.
pause
