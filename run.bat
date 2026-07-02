@echo off
setlocal

cd /d "%~dp0"

echo Checking out main...
git checkout main
if errorlevel 1 goto :error

echo Pulling latest changes...
git pull
if errorlevel 1 goto :error

echo Installing/updating dependencies...
call npm install
if errorlevel 1 goto :error

echo Starting server...
call npx wrangler dev

goto :eof

:error
echo.
echo Failed - see error above.
exit /b 1
