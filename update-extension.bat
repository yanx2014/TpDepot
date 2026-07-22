@echo off
rem Local Lead URL Lens - one-click updater.
rem Forces this clone's files to exactly match the latest code on the branch, then
rem tells you the version. After it finishes: open chrome://extensions and click the
rem reload icon on "Local Lead URL Lens" (the folder is already loaded unpacked).
setlocal
set BRANCH=claude/claude-chrome-chat-w2pjhz
cd /d "%~dp0"
echo Updating Local Lead URL Lens...
git fetch origin %BRANCH%
if errorlevel 1 (
  echo.
  echo Update FAILED at "git fetch". Check your internet connection.
  pause
  exit /b 1
)
rem Make the working tree exactly match the branch (a plain "git pull" can silently
rem abort if this clone was ever edited or diverged, leaving the OLD code on disk).
git reset --hard FETCH_HEAD
if errorlevel 1 (
  echo.
  echo Update FAILED at "git reset". Run "git status" in this folder and send me the output.
  pause
  exit /b 1
)
set VERSION=
for /f "tokens=2 delims=:," %%v in ('findstr /c:"\"version\"" local-lead-url-lens-extension\manifest.json') do set VERSION=%%~v
echo.
echo Up to date. Extension version:%VERSION%
echo If that is not the newest version, send me the line above.
echo Now open chrome://extensions and click the reload icon on "Local Lead URL Lens".
pause
endlocal
