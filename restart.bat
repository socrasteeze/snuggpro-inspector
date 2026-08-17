@echo off
setlocal

cd /d "%~dp0"

call "%~dp0stop.bat"

echo.
echo Restarting...
echo.

call "%~dp0start.bat"

endlocal
