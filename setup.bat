@echo off
REM Karma Connect - one-click setup for Windows.
REM Double-click this file. It installs everything and starts the app.

cd /d "%~dp0"
echo ============================================
echo    Karma Connect - setup (Windows)
echo ============================================
echo.

REM 1) Node.js must be installed.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is NOT installed.
  echo Please install the LTS version from:  https://nodejs.org
  echo Then double-click this file again.
  echo.
  pause
  exit /b
)
echo Node.js found.
echo.

REM 2) Install dependencies.
echo Installing dependencies (this can take a minute)...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Check your internet connection and try again.
  pause
  exit /b
)
echo.

REM 3) Create .env with your Anthropic key (only if it does not exist yet).
if exist .env goto run
set /p KEY="Paste your Anthropic API key (starts with sk-ant-...) and press Enter: "
echo ANTHROPIC_API_KEY=%KEY%> .env
echo VITE_SUPABASE_URL=>> .env
echo VITE_SUPABASE_ANON_KEY=>> .env
echo .env created.
echo.

:run
REM 4) Start the app.
echo Starting the app - open the http://localhost link shown below in your browser.
echo (To stop the app later, press Control+C in this window.)
echo.
call npm run dev
