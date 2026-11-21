@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title D:\fish 停止服务

rem ============================================================
rem  D:\fish\stop.bat —— 停止小鲸鱼各服务
rem
rem  步骤：
rem    1) 先结束 guard-daemon 守护进程（否则服务停掉后可能被它 60 秒内重新拉起）
rem    2) 按端口结束监听进程：3000/3001/5099（SnowLuma）、3080（DSH Web）、3100（桥接）
rem    3) 复核端口是否释放
rem
rem  用法：
rem    stop.bat               正常停止
rem    stop.bat --dry-run     保险演练：只显示将结束的进程，不实际结束
rem    stop.bat --nopause     结束后不暂停（方便批处理调用）
rem
rem  注意：stop.bat 按端口结束进程，不区分进程属于旧目录还是 D:\fish。
rem        切换前后使用它是符合预期的；正在使用 3080 的 DSH 界面时会被断开。
rem ============================================================

set "FISH_HOME=D:\fish"
set "DRY="
set "NOPAUSE="
if /i "%~1"=="--dry-run" set "DRY=1"
if /i "%~1"=="--dryrun" set "DRY=1"
if /i "%~1"=="--nopause" set "NOPAUSE=1"
if /i "%~2"=="--dry-run" set "DRY=1"
if /i "%~2"=="--dryrun" set "DRY=1"
if /i "%~2"=="--nopause" set "NOPAUSE=1"

echo ============================================================
echo   小鲸鱼 · 停止服务
echo   SnowLuma（3000/3001/5099）· DSH Web（3080）· 桥接（3100）
echo ============================================================
if defined DRY echo   *** 演练模式 --dry-run：只显示，不实际结束任何进程 ***
echo.

rem ---------- 1) 守护进程 ----------
echo [1/3] 结束 guard-daemon 守护进程（防止服务被重新拉起）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$found=$false; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*guard-daemon.mjs*' } | ForEach-Object { $found=$true; Write-Host ('  [guard] PID ' + $_.ProcessId + '  ' + $_.CommandLine); if ('%DRY%' -ne '1') { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host '          已结束' } }; if (-not $found) { Write-Host '  （没有 guard-daemon 在运行）' }"

rem ---------- 2) 按端口结束 ----------
echo.
echo [2/3] 结束占用目标端口的进程...
set "ALLPIDS=,"
set "FOUNDANY="
for %%P in (3000 3001 5099 3080 3100) do (
  set "PFOUND="
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /C:":%%P " ^| findstr /C:"LISTENING"') do (
    set "PFOUND=1"
    set "FOUNDANY=1"
    call :KILLPID %%A %%P
  )
  if not defined PFOUND echo   端口 %%P：无监听进程
)
if not defined FOUNDANY echo   （没有发现任何目标端口的监听进程）

rem ---------- 3) 复核 ----------
echo.
if defined DRY (
  echo [3/3] 复核：演练模式跳过
  goto :STOP_SUMMARY
)
echo [3/3] 复核端口状态...
set "STILL="
for %%P in (3000 3001 5099 3080 3100) do (
  netstat -ano | findstr /C:":%%P " | findstr /C:"LISTENING" >nul
  if not errorlevel 1 (
    echo   端口 %%P 仍在监听
    set "STILL=1"
  )
)
if defined STILL (
  echo.
  echo   [警告] 仍有端口在监听，可能被守护进程/父进程重新拉起。
  echo          可等几秒后再运行一次 stop.bat；若仍不行，查看 node 进程：
  echo          powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Select-Object ProcessId,CommandLine"
) else (
  echo   全部目标端口已释放。
)

:STOP_SUMMARY
echo.
if defined STILL (
  echo [完成] 停止流程结束，但仍有端口在监听（见上方警告）。
  echo.
  if not defined NOPAUSE pause
  exit /b 1
)
echo [完成] 停止流程结束。
if defined DRY echo   [演练] 未实际结束任何进程；去掉 --dry-run 即为真实停止。
echo.
if not defined NOPAUSE pause
exit /b 0

rem ============================================================
rem  辅助函数：结束一个 PID（同一进程监听多个端口时自动去重）
rem  调用：call :KILLPID <PID> <端口>
rem ============================================================
:KILLPID
set "KPID=%~1"
set "KPORT=%~2"
echo !ALLPIDS! | findstr /C:",%KPID%," >nul
if not errorlevel 1 (
  echo   端口 %KPORT%：PID %KPID% 已处理过（同一进程监听多个端口），跳过
  exit /b 0
)
set "ALLPIDS=!ALLPIDS!%KPID%,"
if defined DRY (
  echo   [演练] 端口 %KPORT%：将结束 PID %KPID%
  exit /b 0
)
echo   端口 %KPORT%：结束 PID %KPID% ...
taskkill /F /T /PID %KPID% >nul 2>&1
if errorlevel 1 (
  echo     未结束：进程可能已退出或无权限
) else (
  echo     已结束
)
exit /b 0
