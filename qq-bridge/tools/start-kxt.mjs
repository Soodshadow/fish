// 小鲸鱼一键启动：SnowLuma -> 注入 QQ -> 桥接
// 用法：node tools\start-kxt.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = 'D:\\fish\\qq-bridge';
const SNOW_DIR = 'D:\\fish\\snow';
const SNOW_NODE = path.join(SNOW_DIR, 'node.exe');
const SNOW_BASE = 'http://127.0.0.1:5099';
const SNOW_PW = 'Kxt-1000000002-Aa!';
const BOT_QQ = '1000000002';
const DSH_EXE = 'D:\\dsh\\DSH Desktop\\DSH Desktop.exe';
const DSH_WEB_BIN = 'D:\\dsh\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const CONFIG = path.join(ROOT, 'config.json');
const CONSOLE_PORT = 3100;
const BRIDGE_LOG = path.join(ROOT, 'bridge-run.log');
const SAFE_HOME = path.join(process.env.APPDATA, 'DSH Desktop', 'safe-mode', 'dsh-home');
const NORMAL_HOME = path.join(process.env.USERPROFILE, '.dsh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function log(msg) { console.log(`[${stamp()}] ${msg}`); }

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function fetchJson(url, opts = {}, timeout = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  } finally { clearTimeout(t); }
}

async function waitFor(fn, timeoutMs, intervalMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

// ── 预设自检：Safe Mode 环境被重建后 preset 会丢，启动前先补 ──────────────
function profileHasBridge(home, profile) {
  const pkg = path.join(home, 'profiles', profile, 'package.json');
  try { return fs.readFileSync(pkg, 'utf8').includes('qq-agent-presets'); } catch { return false; }
}

function ensurePresets() {
  const targets = [
    { home: SAFE_HOME, profile: 'desktop-safe-mode', label: 'Safe Mode' },
    { home: NORMAL_HOME, profile: 'desktop', label: '普通模式' },
  ];
  for (const t of targets) {
    const dir = path.join(t.home, 'profiles', t.profile);
    if (!fs.existsSync(dir)) continue;
    if (profileHasBridge(t.home, t.profile)) continue;
    log(`${t.label} profile 缺少 qq preset，正在补装…`);
    try {
      execFileSync(process.execPath, ['scripts\\setup-dsh.mjs', t.profile], {
        cwd: ROOT, env: { ...process.env, DSH_HOME: t.home }, stdio: 'inherit',
      });
    } catch (e) {
      log(`补装失败（${t.label}）：${e?.message ?? e}`);
    }
  }
}

// ── SnowLuma ────────────────────────────────────────────────────────────────
async function snowReady() {
  // 5099 已被监听就说明 SnowLuma 在跑；/api/status 需要登录态，不能拿它当探活。
  if (await portOpen(5099)) return true;
  try {
    const r = await fetchJson(`${SNOW_BASE}/api/status`, {}, 1500);
    return r.status > 0 && r.status < 500;
  } catch { return false; }
}

async function ensureSnowLuma() {
  if (await snowReady()) { log('SnowLuma 已在运行'); return; }
  log('启动 SnowLuma…');
  const out = fs.openSync(path.join(SNOW_DIR, 'run-out.log'), 'a');
  const err = fs.openSync(path.join(SNOW_DIR, 'run-err.log'), 'a');
  spawn(SNOW_NODE, ['index.mjs'], { cwd: SNOW_DIR, detached: true, windowsHide: true, stdio: ['ignore', out, err] }).unref();
  const ok = await waitFor(snowReady, 60000, 1500);
  if (!ok) throw new Error('SnowLuma 没有起来（60 秒内 5099 端口未就绪），请手动双击 D:\\fish\\snow\\launcher.bat 看报错');
  log('SnowLuma 已就绪');
}

async function snowLogin() {
  for (let i = 0; i < 3; i++) {
    const r = await fetchJson(`${SNOW_BASE}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: SNOW_PW }),
    });
    if (r.status === 200 && r.json?.token) return r.json.token;
    if (r.status === 429) { log('登录被限速，等 5 秒重试…'); await sleep(5000); continue; }
    throw new Error(`SnowLuma 登录失败（HTTP ${r.status}）：密码可能被改过，请打开 ${SNOW_BASE} 确认`);
  }
  throw new Error('SnowLuma 登录失败：多次重试仍未成功');
}

function botProcess(token, list) {
  return (list ?? []).find((p) => String(p?.account?.uin ?? '') === BOT_QQ);
}

async function ensureQQOnline(token) {
  let procs = (await fetchJson(`${SNOW_BASE}/api/processes`, { headers: { 'x-snowluma-token': token } }, 5000)).json?.list;
  let item = botProcess(token, procs);
  if (!item) {
    throw new Error(`QQ 里还没登录小号 ${BOT_QQ}。请先在电脑版 QQ 登录它，再重新双击一键启动。`);
  }
  if (item.status === 'online') { log(`QQ ${BOT_QQ} 已在线，跳过注入`); return; }

  log(`注入 SnowLuma 到 QQ 进程 PID ${item.pid}…`);
  const load = await fetchJson(`${SNOW_BASE}/api/processes/${item.pid}/load`, {
    method: 'POST',
    headers: { 'x-snowluma-token': token, 'content-type': 'application/json' },
    body: '{}',
  }, 15000);
  if (!load.json?.success && load.status !== 200) throw new Error(`注入失败：${JSON.stringify(load.json)}`);

  const online = await waitFor(async () => {
    const r = await fetchJson(`${SNOW_BASE}/api/processes`, { headers: { 'x-snowluma-token': token } }, 5000);
    const p = botProcess(token, r.json?.list);
    return p?.status === 'online' ? p : null;
  }, 45000, 1500);
  if (!online) throw new Error('注入后 45 秒仍未 online，请在 SnowLuma 面板「QQ 进程」看错误信息');
  log(`QQ ${BOT_QQ}（${online.account?.nickname ?? ''}）已 online`);
}

// ── DSH ────────────────────────────────────────────────────────────────────
function dshPids() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DSH Desktop.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((l) => l.match(/^"([^"]+)","(\d+)"/)).filter(Boolean).map((m) => m[2]);
  } catch { return []; }
}

async function dshPort() {
  // 只认固定 3080（dsh web 实例）。
  // 桌面 DSH 自己也会开随机 API 端口（本次是 59700），但它的会话事件流
  // 和桥接协议不兼容（连上后 0 帧），所以绝不能把桌面端口当成桥接入口。
  for (const p of [3080]) {
    try {
      const r = await fetchJson(`http://127.0.0.1:${p}/`, {}, 1200);
      if (r.status === 401 || r.status === 200) return p;
    } catch {}
  }
  return null;
}

function dshIsSafeMode() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='DSH Desktop.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { encoding: 'utf8' });
    return out.includes('--dsh-desktop-safe-mode');
  } catch { return false; }
}

async function ensureDSH() {
  let port = await dshPort();
  if (!port) {
    // 不碰用户正在长开的 DSH Desktop：只补一个固定 3080 的 web 实例供桥接使用。
    // Desktop 的 43120 只服务 Electron 窗口、外部一律 403，桥接连不了；
    // web 实例的 3080 接受桥接的 cookie，且端口固定，DSH 长开时也稳定。
    log('启动 DSH web 实例（127.0.0.1:3080，不影响桌面 DSH）…');
    spawn(process.execPath, [DSH_WEB_BIN, 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open'], {
      detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, DSH_HOME: process.env.DSH_HOME || NORMAL_HOME },
    }).unref();
    port = await waitFor(dshPort, 120000, 2000);
    if (!port) {
      throw new Error('固定 3080 的 DSH web 实例启动失败。请检查 DSH 安装路径，或手动运行 '
        + `node "${DSH_WEB_BIN}" web --host 127.0.0.1 --port 3080 --no-open 后重试；`
        + '不要为此重启你的 DSH Desktop。');
    }
  }
  log(`DSH 在线（端口 ${port}）`);

  // 端口可能每次启动变化：同步到桥接配置
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const want = `http://127.0.0.1:${port}`;
  let changed = false;
  if (cfg.dsh.baseUrl !== want) { cfg.dsh.baseUrl = want; changed = true; }
  if (changed) {
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
    log(`已更新桥接配置 dsh.baseUrl -> ${want}`);
  }
  return { port, changed };
}

// ── 桥接 ───────────────────────────────────────────────────────────────────
function killByPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(new RegExp(`^TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)$`));
      if (m) execFileSync('taskkill', ['/PID', m[1], '/F'], { stdio: 'ignore' });
    }
  } catch {}
}

async function ensureBridge(dshHome, dshPortChanged) {
  const running = await portOpen(CONSOLE_PORT);
  if (running && !dshPortChanged) { log(`桥接已在运行（控制台 ${CONSOLE_PORT}）`); return; }
  if (running) { log('DSH 端口变了，重启桥接…'); killByPort(CONSOLE_PORT); await sleep(2500); }

  log('启动桥接…');
  const startSize = fs.existsSync(BRIDGE_LOG) ? fs.statSync(BRIDGE_LOG).size : 0;
  const out = fs.openSync(BRIDGE_LOG, 'a');
  spawn(process.execPath, ['src\\bridge.js'], {
    cwd: ROOT, detached: true, windowsHide: true,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', out, out],
  }).unref();

  const up = await waitFor(() => portOpen(CONSOLE_PORT), 30000, 1000);
  if (!up) throw new Error('桥接 30 秒内没有启动，请看 D:\\fish\\qq-bridge\\bridge-run.log');
  const connected = await waitFor(() => {
    try {
      const size = fs.statSync(BRIDGE_LOG).size;
      const len = size - startSize;
      if (len <= 0) return false;
      const fd = fs.openSync(BRIDGE_LOG, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, startSize);
      fs.closeSync(fd);
      const fresh = buf.toString('utf8');
      return fresh.includes('SnowLuma 已连接') && fresh.includes('DSH 已就绪');
    } catch { return false; }
  }, 30000, 1000);
  if (!connected) throw new Error('桥接已启动但没连上 SnowLuma/DSH，请看 D:\\fish\\qq-bridge\\bridge-run.log');
  log('桥接已连接 SnowLuma + DSH');
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
try {
  console.log('════════ 小鲸鱼一键启动 ════════');
  ensurePresets();
  await ensureSnowLuma();
  const token = await snowLogin();
  await ensureQQOnline(token);

  const { changed } = await ensureDSH();
  const home = dshIsSafeMode() ? SAFE_HOME : NORMAL_HOME;
  log(`DSH 数据目录：${home}`);

  await ensureBridge(home, changed);

  const consoleToken = fs.existsSync(path.join(ROOT, 'state', 'console-token'))
    ? fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim()
    : '(未生成)';

  console.log('\n════════ 全部就绪 ════════');
  console.log(`机器人 QQ ：${BOT_QQ} 大肥鱼一条`);
  console.log(`桥接控制台：http://127.0.0.1:${CONSOLE_PORT}?token=${consoleToken}`);
  console.log(`SnowLuma  ：${SNOW_BASE}`);
  console.log('现在可以在 QQ 里找她说话了。关掉本窗口不影响运行。');
  console.log('停止：任务管理器结束 node.exe，或在桥接窗口按 Ctrl+C。');
} catch (e) {
  console.error(`\n[启动失败] ${e?.message ?? e}`);
  process.exitCode = 1;
}
