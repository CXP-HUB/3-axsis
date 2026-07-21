@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set "PORT=8000"
if "%DEVICE_URL%"=="" set "DEVICE_URL=http://192.168.4.1"
echo Web: http://localhost:%PORT%
echo ESP32: %DEVICE_URL%
node server.mjs
pause
