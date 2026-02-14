@echo off
cd /d "%~dp0"

set PORT=8090

:: Check if port is already in use
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Port %PORT% is already in use.
    echo Please close the other process or change PORT in this file.
    pause
    exit /b 1
)

start "" python -m http.server %PORT%
timeout /t 2 > nul
start "" "http://localhost:%PORT%/index.html"
