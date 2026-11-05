@echo off
REM ------------------------------------------------------------------
REM TrackVault - double-click launcher (Windows)
REM Installs dependencies on first run, builds, then serves the app and
REM opens it in your default browser. Press Ctrl+C in this window to stop.
REM ------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Node.js is not installed or not on your PATH.
  echo Install the LTS build from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies. This only happens once...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo Building the app...
call npm run build
if errorlevel 1 (
  echo.
  echo ERROR: Build failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo ==========================================================
echo  TrackVault is starting.
echo  Your browser will open automatically at localhost:1420
echo  Keep this window open while you use it.
echo  Press Ctrl+C here to stop.
echo ==========================================================
echo.

start "" http://localhost:1420
call npx vite preview --port 1420 --strictPort --open

endlocal