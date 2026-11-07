@echo off
title SnowLuma (fish)
cd /d "%~dp0"

echo ============================================================
echo   Starting SnowLuma from D:\fish\snow
echo ============================================================
echo.

if not exist "%~dp0node.exe" (
  echo [ERROR] node.exe not found in %~dp0
  pause
  exit /b 1
)

rem Cleanup leftover update temp dirs (source of EPERM errors)
for /d %%D in ("%TEMP%\snowluma-update-*") do rd /s /q "%%D" 2>nul

echo [START] node.exe index.mjs
echo ------------------------------------------------------------
"%~dp0node.exe" "%~dp0index.mjs"
set EXITCODE=%errorlevel%
echo ------------------------------------------------------------
echo.
echo [SnowLuma exited] exit=%EXITCODE%
echo.
pause
