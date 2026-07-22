@echo off
rem Local Lead URL Lens - one-click updater.
rem Pulls the latest extension code from GitHub into this clone.
rem After it finishes: open chrome://extensions and click the reload icon
rem on "Local Lead URL Lens" (the folder is already loaded unpacked).
cd /d "%~dp0"
echo Updating Local Lead URL Lens...
git pull --ff-only origin claude/claude-chrome-chat-w2pjhz
if errorlevel 1 (
  echo.
  echo Update FAILED. Check your internet connection, or run "git status" in this folder.
  pause
  exit /b 1
)
for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" local-lead-url-lens-extension\manifest.json') do set VERSION=%%~v
echo.
echo Up to date. Extension version: %VERSION%
echo Now open chrome://extensions and click the reload icon on "Local Lead URL Lens".
pause
