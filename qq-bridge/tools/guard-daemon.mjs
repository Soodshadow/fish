// XiaoJingYu guard daemon (Node): single-instance, checks every 60s, fills missing services.
// Lightweight replacement for the PowerShell daemon (~30MB vs ~80MB).
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const LOCK = 'D:\\fish\\qq-bridge\\state\\guard.lock';

// Single instance: if the recorded pid is alive and is not us, exit.
try {
  const old = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
  if (old && old !== process.pid) {
    try { process.kill(old, 0); process.exit(0); } catch { /* stale pid */ }
  }
} catch { /* no lock yet */ }
try { fs.writeFileSync(LOCK, String(process.pid), 'utf8'); } catch {}

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SNOW_NODE = 'D:\\fish\\snow\\node.exe';
const DSH_BIN = 'D:\\dsh\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const DSH_APP = 'D:\\dsh\\DSH Desktop\\resources\\app';
const env = { ...process.env, DSH_HOME: 'C:\\Users\\Lenovo\\.dsh' };

function portOpen(port, timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function run(file, args, cwd) {
  try {
    // 不加 detached：让子进程继承守护的隐藏控制台，避免 SnowLuma 自己 spawn 的子进程弹窗
    spawn(file, args, { cwd, windowsHide: true, stdio: 'ignore', env }).unref();
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check() {
  // SnowLuma：3000 是 OneBot 通道，5099/5100 是它的 WebUI。只要 WebUI 在，说明
  // SnowLuma 已经跑起来了（可能卡在 QQ 注入、OneBot 还没起）。此时绝不能再启动新实例，
  // 否则会每 60 秒堆一个僵尸实例，把资源吃光、消息链路搞乱。
  const snowlumaAlive = (await portOpen(5099)) || (await portOpen(5100));
  if (!snowlumaAlive && !(await portOpen(3000))) {
    run(SNOW_NODE, ['index.mjs'], 'D:\\fish\\snow');
    await sleep(6000);
  }
  if (!(await portOpen(3080))) {
    run(NODE, [DSH_BIN, 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open'], DSH_APP);
    await sleep(10000);
  }
  if (!(await portOpen(3100))) {
    run(NODE, ['src\\bridge.js'], 'D:\\fish\\qq-bridge');
  }
}

check();
setInterval(check, 60000);
