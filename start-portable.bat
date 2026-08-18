@echo off
setlocal
cd /d "%~dp0"

set "PORT=3001"
set "NODE_EXE="

if exist "%~dp0runtime\node.exe" (
    set "NODE_EXE=%~dp0runtime\node.exe"
    goto :have_node
)

where node >nul 2>&1
if errorlevel 1 goto :no_node
for /f "delims=" %%i in ('where node') do (
    set "NODE_EXE=%%i"
    goto :have_node
)

:no_node
echo No Node.js found on this PC.
echo Double-click setup-portable.bat once (needs internet) to download
echo a portable Node runtime into this folder, then try again.
echo.
pause
exit /b 1

:have_node

if not exist "%~dp0.env" goto :no_env
if not exist "%~dp0node_modules\dotenv" goto :no_deps

netstat -ano 2>nul | findstr /C:":%PORT% " | findstr /C:"LISTENING" >nul
if not errorlevel 1 goto :already_running

echo Starting SnuggPro Inspector...
echo Close this window to stop the server.
echo.
set "OPEN_BROWSER=1"
"%NODE_EXE%" "%~dp0proxy.js"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
    echo Proxy exited with code %ERR%.
)
pause
exit /b %ERR%

:no_env
echo Missing .env
echo Copy .env.example to .env and fill in your SnuggPro API keys.
echo.
pause
exit /b 1

:no_deps
echo Missing dependencies.
echo Double-click setup-portable.bat once to install them onto this drive.
echo.
pause
exit /b 1

:already_running
echo Already running on port %PORT% - opening the browser.
start "" "http://localhost:%PORT%"
echo.
pause
exit /b 0
