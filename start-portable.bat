@echo off
setlocal
cd /d "%~dp0"

set "PORT=3001"
set "NODE_EXE="

if exist "%~dp0runtime\node.exe" (
    set "NODE_EXE=%~dp0runtime\node.exe"
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%i in ('where node') do (
            set "NODE_EXE=%%i"
            goto :have_node
        )
    )
    echo No Node.js found on this PC.
    echo Double-click setup-portable.bat once (needs internet) to download
    echo a portable Node runtime into this folder, then try again.
    echo.
    pause
    exit /b 1
)

:have_node

if not exist "%~dp0.env" (
    echo Missing .env
    echo Copy .env.example to .env and fill in your SnuggPro API keys.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0node_modules\dotenv" (
    echo Missing dependencies.
    echo Double-click setup-portable.bat once to install them onto this drive.
    echo.
    pause
    exit /b 1
)

netstat -ano 2>nul | findstr ":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo Already running on port %PORT% — opening the browser.
    start "" "http://localhost:%PORT%"
    exit /b 0
)

echo Starting SnuggPro Inspector...
echo Close this window to stop the server.
echo.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
"%NODE_EXE%" "%~dp0proxy.js"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
    echo Proxy exited with code %ERR%.
    pause
    exit /b %ERR%
)
