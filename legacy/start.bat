@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title D:\fish 小鲸鱼一键启动

rem ============================================================
rem  D:\fish\start.bat —— 小鲸鱼总目录一键启动
rem  启动顺序：SnowLuma（3000/3001/5099）→ DSH Web（3080）→ QQ 桥接（3100）
rem
rem  用法：
rem    start.bat            自动模式（默认）。调用 qq-bridge\tools\start-kxt.mjs，
rem                         由它等待端口就绪、完成 SnowLuma 登录与 QQ 注入，再起 DSH 与桥接。
rem    start.bat --manual   分步模式。固定等待 15s / 40s，分三步拉起服务（不自动注入 QQ）。
rem    start.bat --check    只做环境预检，不启动任何服务。
rem
rem  注意：关闭本窗口不会停止服务（服务进程已独立运行）；停止请用 stop.bat。
rem ============================================================

set "FISH_HOME=D:\fish"
set "DSH_HOME=%USERPROFILE%\.dsh"
set "DSH_APP=D:\dsh\DSH Desktop\resources\app"
set "DSH_BIN=%DSH_APP%\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "SNOW_DIR=%FISH_HOME%\snow"
set "BRIDGE_DIR=%FISH_HOME%\qq-bridge"
set "KXT=%BRIDGE_DIR%\tools\start-kxt.mjs"

set "NODE_SYS=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_SYS%" set "NODE_SYS=node"
set "NODE_SNOW=%SNOW_DIR%\node.exe"
if not exist "%NODE_SNOW%" set "NODE_SNOW=%NODE_SYS%"

set "MODE=auto"
if /i "%~1"=="--manual" set "MODE=manual"
if /i "%~1"=="--check" set "MODE=check"

set /a ERRORS=0
set /a WARNS=0
set "BUSY="
set "DSH_RUNNING="

echo ============================================================
echo   小鲸鱼 · D:\fish 一键启动
echo   SnowLuma -^> DSH Web -^> QQ 桥接      模式：!MODE!
echo ============================================================
echo.

rem ---------- 预检 1：关键文件 ----------
echo [预检 1/3] 运行环境
if exist "%SNOW_DIR%\index.mjs" (
  echo   [OK] SnowLuma 入口：%SNOW_DIR%\index.mjs
) else (
  echo   [错误] 找不到 %SNOW_DIR%\index.mjs
  set /a ERRORS+=1
)
if exist "%NODE_SNOW%" (
  echo   [OK] SnowLuma 运行时：%NODE_SNOW%
) else (
  echo   [提示] 没有 snow\node.exe，将改用系统 node：%NODE_SYS%
)
if exist "%DSH_BIN%" (
  echo   [OK] DSH Web：%DSH_APP%
) else (
  echo   [错误] 找不到 DSH：%DSH_BIN%
  set /a ERRORS+=1
)
if exist "%BRIDGE_DIR%\src\bridge.js" (
  echo   [OK] 桥接入口：%BRIDGE_DIR%\src\bridge.js
) else (
  echo   [错误] 找不到 %BRIDGE_DIR%\src\bridge.js
  set /a ERRORS+=1
)
if exist "%BRIDGE_DIR%\node_modules" (
  echo   [OK] 桥接依赖：%BRIDGE_DIR%\node_modules
) else (
  echo   [警告] 缺少桥接 node_modules，请先在 %BRIDGE_DIR% 执行：npm install
  set /a WARNS+=1
)
if exist "%DSH_HOME%\.credentials.yaml" (
  echo   [OK] DSH 凭据：%DSH_HOME%\.credentials.yaml
) else (
  echo   [警告] 没找到 %DSH_HOME%\.credentials.yaml，桥接可能连不上 DSH（请先登录过 DSH）
  set /a WARNS+=1
)

rem ---------- 预检 2：端口占用 ----------
echo.
echo [预检 2/3] 端口占用
for %%P in (3000 3001 5099 3100) do (
  set "PF="
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /C:":%%P " ^| findstr /C:"LISTENING"') do (
    set "PF=1"
    echo   [占用] 端口 %%P 已被 PID %%A 监听
  )
  if not defined PF echo   [OK] 端口 %%P 空闲
  if defined PF set "BUSY=1"
)
netstat -ano | findstr /C:":3080 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  set "DSH_RUNNING=1"
  echo   [提示] 端口 3080 已有 DSH Web 在运行，将复用现有实例
) else (
  echo   [OK] 端口 3080 空闲，将启动新的 DSH Web
)
if defined BUSY (
  echo.
  echo   [提示] 3000/3001/5099/3100 被占用，通常是旧服务还在运行（D:\snow 或 D:\qq-bridge）。
  echo          请先运行 D:\fish\stop.bat（会结束占用这些端口的进程），或手动关闭旧服务。
  set /a ERRORS+=1
)

rem ---------- 预检 3：结论 ----------
echo.
echo [预检 3/3] 结论
if !ERRORS! gtr 0 (
  echo   [中止] 预检发现 !ERRORS! 个阻塞问题，未启动任何服务。
  echo.
  if /i not "!MODE!"=="check" pause
  exit /b 1
)
if !WARNS! gtr 0 (
  echo   [继续] 预检通过，但有 !WARNS! 条警告，请留意上面的提示。
) else (
  echo   [通过] 预检全部通过。
)
if /i "!MODE!"=="check" (
  echo.
  echo [完成] --check 模式：只做预检，未启动任何服务。
  exit /b 0
)

if /i "!MODE!"=="manual" goto :MANUAL

rem ============================================================
rem  自动模式：调用经过验证的 qq-bridge\tools\start-kxt.mjs
rem ============================================================
:AUTO
echo.
echo [启动] 自动模式：%KXT%
echo        依次完成：SnowLuma 就绪 -^> SnowLuma 登录 -^> QQ 注入 -^> DSH Web 就绪 -^> 桥接连上
echo.
if not exist "%KXT%" (
  echo   [警告] 找不到 %KXT%，自动退回分步模式。
  goto :MANUAL
)
"%NODE_SYS%" "%KXT%"
set "RC=!errorlevel!"
echo.
if not "!RC!"=="0" (
  echo [失败] 自动启动未成功（exit !RC!）。排查建议：
  echo   1^) 电脑版 QQ 是否已登录小号 1000000002
  echo   2^) 是否有旧服务/守护进程占着端口（可先运行 D:\fish\stop.bat）
  echo   3^) 日志：%SNOW_DIR%\run-err.log、%SNOW_DIR%\logs\、%BRIDGE_DIR%\bridge-run.log
  pause
  exit /b !RC!
)
echo [完成] 全部就绪，现在可以在 QQ 里找小鲸鱼了。
echo        桥接控制台：http://127.0.0.1:3100
echo        控制台令牌：%BRIDGE_DIR%\state\console-token
pause
exit /b 0

rem ============================================================
rem  分步模式：固定等待 15s / 40s，逐段启动
rem ============================================================
:MANUAL
echo.
echo [启动] 分步模式（固定等待，不自动注入 QQ）
echo.

echo [1/3] 启动 SnowLuma（%SNOW_DIR%）...
start "SnowLuma" /D "%SNOW_DIR%" "%NODE_SNOW%" index.mjs
echo        等待 15 秒...
timeout /t 15 /nobreak >nul 2>&1
if errorlevel 1 ping -n 16 127.0.0.1 >nul
call :WAITPORT 3000 20
if errorlevel 1 (
  echo   [警告] 3000 端口仍未监听，SnowLuma 可能启动失败。请查看 %SNOW_DIR%\run-err.log 或 %SNOW_DIR%\logs\
  set /a WARNS+=1
) else (
  echo   [OK] SnowLuma 已监听（3000/3001/5099）
)

echo.
echo [2/3] 准备 DSH Web（端口 3080，DSH_HOME=%DSH_HOME%）...
if defined DSH_RUNNING (
  echo   [跳过] 3080 已有 DSH Web 在运行，复用现有实例
) else (
  start "DSH Web" /D "%DSH_APP%" "%NODE_SYS%" "%DSH_BIN%" web --host 127.0.0.1 --port 3080 --no-open
  echo        等待 40 秒...
  timeout /t 40 /nobreak >nul 2>&1
  if errorlevel 1 ping -n 41 127.0.0.1 >nul
  call :WAITPORT 3080 20
  if errorlevel 1 (
    echo   [警告] 3080 端口仍未监听，DSH Web 可能启动失败。
    echo          可手动运行： "%NODE_SYS%" "%DSH_BIN%" web --host 127.0.0.1 --port 3080 --no-open
    set /a WARNS+=1
  ) else (
    echo   [OK] DSH Web 已监听 3080
  )
)

echo.
echo [3/3] 启动 QQ 桥接（%BRIDGE_DIR%）...
start "QQ Bridge" /D "%BRIDGE_DIR%" "%NODE_SYS%" "%BRIDGE_DIR%\src\bridge.js"
echo        等待 15 秒...
timeout /t 15 /nobreak >nul 2>&1
if errorlevel 1 ping -n 16 127.0.0.1 >nul
call :WAITPORT 3100 20
if errorlevel 1 (
  echo   [警告] 3100 端口仍未监听，桥接可能启动失败。请查看 %BRIDGE_DIR%\bridge-run.log
  set /a WARNS+=1
) else (
  echo   [OK] 桥接控制台已监听 3100
)

echo.
echo [提示] 分步模式不会注入 QQ。若 QQ 不在线：
echo        - 打开 http://127.0.0.1:5099 登录 SnowLuma，在「QQ 进程」中加载小号 1000000002；或
echo        - 关闭本窗口后重新双击 start.bat（自动模式会自动完成注入）。
echo        桥接控制台：http://127.0.0.1:3100（令牌见 %BRIDGE_DIR%\state\console-token）
echo.
if !WARNS! gtr 0 (
  echo [完成] 服务已拉起，但有 !WARNS! 条警告，请按上面提示检查。
  pause
  exit /b 1
)
echo [完成] 服务已拉起，可在 QQ 里找小鲸鱼了。
pause
exit /b 0

rem ============================================================
rem  辅助函数：等待端口监听（call :WAITPORT <端口> <最多秒数>）
rem  成功 exit /b 0；超时 exit /b 1
rem ============================================================
:WAITPORT
set "WP=%~1"
set "WL=%~2"
for /l %%I in (1,1,%WL%) do (
  netstat -ano | findstr /C:":%WP% " | findstr /C:"LISTENING" >nul
  if not errorlevel 1 exit /b 0
  timeout /t 1 /nobreak >nul 2>&1
)
exit /b 1
