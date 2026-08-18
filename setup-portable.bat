@echo off
setlocal
cd /d "%~dp0"

echo Preparing portable runtime on this drive...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-portable.ps1" %*
if errorlevel 1 (
    echo.
    echo Setup failed - see the error above.
    pause
    exit /b 1
)

echo.
pause
