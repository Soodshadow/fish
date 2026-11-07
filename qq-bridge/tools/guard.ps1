# XiaoJingYu guard: ensure SnowLuma / DSH web / bridge are listening.
# Called by a scheduled task every 2 minutes; only fills gaps, never restarts live instances.
$ErrorActionPreference = 'SilentlyContinue'
$env:DSH_HOME = 'C:\Users\Lenovo\.dsh'

$NODE = 'C:\Program Files\nodejs\node.exe'
$SNOW_NODE = 'D:\fish\snow\node.exe'
$DSH_BIN = 'D:\dsh\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'

function PortOpen([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Close() }
}

# 1) SnowLuma (3000/3001)
if (-not (PortOpen 3000)) {
  Start-Process -FilePath $SNOW_NODE -ArgumentList 'index.mjs' -WorkingDirectory 'D:\fish\snow' -WindowStyle Hidden
  Start-Sleep -Seconds 6
}

# 2) dsh web (3080, fixed port for the bridge)
if (-not (PortOpen 3080)) {
  Start-Process -FilePath $NODE -ArgumentList ('"' + $DSH_BIN + '" web --host 127.0.0.1 --port 3080 --no-open') -WorkingDirectory 'D:\dsh\DSH Desktop\resources\app' -WindowStyle Hidden
  Start-Sleep -Seconds 10
}

# 3) bridge (3100)
if (-not (PortOpen 3100)) {
  Start-Process -FilePath $NODE -ArgumentList 'src\bridge.js' -WorkingDirectory 'D:\fish\qq-bridge' -WindowStyle Hidden
}
