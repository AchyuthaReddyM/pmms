@echo off
REM PMMS — Windows launcher
REM Installs dependencies (if needed) and starts the server.

echo === PMMS - Ways Automation ===
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed. Please install it from https://nodejs.org first.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies (first run only)...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

echo Starting PMMS server...
echo.
call npm start
pause
