# XiaoJingYu guard daemon: single-instance, loop forever, every 60s ensure services are up.
# Started hidden at logon via Startup folder (no admin needed).
$ErrorActionPreference = 'SilentlyContinue'
$env:DSH_HOME = 'C:\Users\Lenovo\.dsh'

$lockFile = 'D:\fish\qq-bridge\state\guard.lock'
if (Test-Path $lockFile) {
  $pidText = (Get-Content $lockFile -Raw).Trim()
  if ($pidText -match '^\d+$') {
    $existing = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if ($existing -and $existing.Id -ne $PID) { exit }
  }
}
Set-Content -Path $lockFile -Value $PID -Encoding ASCII

$NODE = 'C:\Program Files\nodejs\node.exe'
$SNOW_NODE = 'D:\fish\snow\node.exe'
$DSH_BIN = 'D:\dsh\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'

function PortOpen([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Close() }
}

while ($true) {
  if (-not (PortOpen 3000)) {
    Start-Process -FilePath $SNOW_NODE -ArgumentList 'index.mjs' -WorkingDirectory 'D:\fish\snow' -WindowStyle Hidden
    Start-Sleep -Seconds 6
  }
  if (-not (PortOpen 3080)) {
    Start-Process -FilePath $NODE -ArgumentList ('"' + $DSH_BIN + '" web --host 127.0.0.1 --port 3080 --no-open') -WorkingDirectory 'D:\dsh\DSH Desktop\resources\app' -WindowStyle Hidden
    Start-Sleep -Seconds 10
  }
  if (-not (PortOpen 3100)) {
    Start-Process -FilePath $NODE -ArgumentList 'src\bridge.js' -WorkingDirectory 'D:\fish\qq-bridge' -WindowStyle Hidden
  }
  Start-Sleep -Seconds 60
}
