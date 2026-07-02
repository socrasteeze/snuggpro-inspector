@echo off
setlocal

set PORT=8787
echo Stopping server on port %PORT%...

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo Killing process %%p...
    taskkill /F /PID %%p >nul 2>&1
    set FOUND=1
)

if "%FOUND%"=="0" (
    echo No server found running on port %PORT%.
) else (
    echo Server stopped.
)

endlocal
