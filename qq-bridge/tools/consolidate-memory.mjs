// 每天 00:00 的记忆整理：读取上次之后的新消息 → DSH 提炼 → 三层落盘
//   1) 永久归档 MEMORY-ARCHIVE.md（只追加，永不删）
//   2) 核心记忆（★ 标记，长期保留、每轮注入）
//   3) 最近 14 天流水（滚动，控制注入体积）
// 用法：node tools\consolidate-memory.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:\\fish\\qq-bridge';
const MD = 'D:\\fish\\memory\\MEMORY-BLUEPRINT.md';
const ARCHIVE = 'D:\\fish\\memory\\MEMORY-ARCHIVE.md';
const MEMORY_DIR = 'D:\\fish\\memory';
const STATE = path.join(ROOT, 'state');
const CURSOR = path.join(MEMORY_DIR, 'memory-cursor.json');
const LOG = path.join(MEMORY_DIR, 'memory-consolidation.log');

const CORE_MARK = '## ⭐ 核心记忆（长期保留）';
const FLOW_MARK = '## 📔 记忆流水（最近 14 天）';
const OLD_FLOW_MARK = '## 📔 记忆流水（自动整理）';
const KEEP_ENTRIES = 14;
const MAX_CORE_CHARS = 2600;
const MAX_FLOW_CHARS = 3000;

const now = Date.now();
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
}

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='DSH Desktop.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { encoding: 'utf8' });
    if (out.includes('--dsh-desktop-safe-mode')) {
      return path.join(process.env.APPDATA, 'DSH Desktop', 'safe-mode', 'dsh-home');
    }
  } catch {}
  return path.join(process.env.USERPROFILE, '.dsh');
}

// ── 收集新消息 ──────────────────────────────────────────────────────────────
const social = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8'));
let since = 0;
try { since = Number(JSON.parse(fs.readFileSync(CURSOR, 'utf8')).lastTime) || 0; } catch {}
const floor = since || now - 26 * 3600 * 1000;

const lines = [];
let maxTime = since;
for (const [, conv] of Object.entries(social.conversations ?? {})) {
  for (const m of conv.recentMessages ?? []) {
    const t = Number(m.time) || 0;
    if (t <= floor) continue;
    const text = String(m.text ?? m.plain ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const who = m.isSelf ? '你(小鲸鱼)' : (m.sender || m.userId || '对方');
    const hhmm = new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    lines.push(`${hhmm} ${who}: ${text.slice(0, 300)}`);
    if (t > maxTime) maxTime = t;
  }
}

if (!lines.length) { log('没有新消息，跳过。'); process.exit(0); }
log(`收集到 ${lines.length} 条新消息`);

// ── 调 DSH 提炼 ─────────────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const baseUrl = cfg.dsh?.baseUrl || 'http://127.0.0.1:43120';
process.env.DSH_HOME = dshHome();

const { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } =
  await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-client.js')).href);

const api = new NodeApiClient(baseUrl, undefined, {
  token: cfg.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg.dsh?.authHeader,
  prefix: cfg.dsh?.authPrefix,
});

const prompt = `下面是你（小鲸鱼）和主人在 QQ 上的聊天记录，时间从早到晚：\n\n${lines.join('\n')}\n\n请提炼出 3~8 条值得记住的事，每条一行，以「- 」开头，写清日期（MM-DD）。\n规则：\n- 约定/计划、重要日子、主人说的重要的话、情绪转折、新称呼或雷点 → 行首用「- ★ 」标记（这些会永久保留）\n- 其余日常小事 → 用「- 」即可（只保留最近 14 天）\n- 不要复述整段聊天，不要解释，不要写空话\n如果确实没有值得记的，只输出 NONE。`;

const cwd = path.join(os.tmpdir(), 'kxt-memory-' + Date.now());
fs.mkdirSync(cwd, { recursive: true });

let sessionId;
try {
  const created = unwrap(await api.sessions.create({ cwd }), 'session.create');
  sessionId = created.sessionId;
  const collector = createTurnCollector();
  let openResolve;
  const opened = new Promise((res) => { openResolve = res; });
  const stream = api.events.mux({}, undefined, () => openResolve());
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待模型回复超时（120s）')), 120000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) { clearTimeout(timer); resolve(ended); return; }
        }
        if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error('事件流错误')); return; }
      }
    })().catch((e) => { clearTimeout(timer); reject(e); });
  });
  await opened;
  stream.follow(sessionId);
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }), 'session.prompt');
  const ended = await done;
  const reply = String(ended.text ?? '').trim();
  log(`模型回复 ${reply.length} 字`);

  const rawBullets = reply.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ') && l.length > 5);
  if (!rawBullets.length || /^NONE$/i.test(reply.trim())) {
    log('模型认为没有值得记的内容，跳过。');
    fs.writeFileSync(CURSOR, JSON.stringify({ lastTime: maxTime }), 'utf8');
    process.exit(0);
  }

  const dateLabel = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

  // ── 1) 永久归档：全量，永不删除 ──────────────────────────────────────────
  const archiveText = rawBullets.map((b) => b.replace(/^-\s*★\s*/, '- ')).join('\n');
  fs.appendFileSync(ARCHIVE, `\n### ${dateLabel}\n${archiveText}\n`, 'utf8');

  // ── 2)+3) 蓝图：核心记忆 + 最近流水 ─────────────────────────────────────
  let md = fs.readFileSync(MD, 'utf8').replace(OLD_FLOW_MARK, FLOW_MARK);
  const ci = md.indexOf(CORE_MARK);
  const fi = md.indexOf(FLOW_MARK);

  let base = md, coreText = '', flowText = '';
  if (ci >= 0) {
    base = md.slice(0, ci).trimEnd();
    coreText = md.slice(ci + CORE_MARK.length, fi > ci ? fi : undefined).trim();
    if (fi >= 0) flowText = md.slice(fi + FLOW_MARK.length).trim();
  } else if (fi >= 0) {
    base = md.slice(0, fi).trimEnd();
    flowText = md.slice(fi + FLOW_MARK.length).trim();
  }

  const coreLines = coreText.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));
  for (const b of rawBullets) {
    if (/^-\s*★/.test(b)) coreLines.push(b.replace(/^-\s*★\s*/, '- '));
  }
  // 核心记忆超长时淘汰最旧的
  while (coreLines.length > 1 && coreLines.join('\n').length > MAX_CORE_CHARS) coreLines.shift();

  const flowBlocks = flowText.split(/\n(?=### )/).map((b) => b.trim()).filter((b) => b.startsWith('### '));
  const heading = `### ${dateLabel}`;
  const todayLines = rawBullets.map((b) => b.replace(/^-\s*★\s*/, '- '));
  const existingIdx = flowBlocks.findIndex((b) => b.split('\n')[0].trim() === heading);
  if (existingIdx >= 0) {
    // 同一天多次整理：合并进当天那一段，不新增重复日期块
    const oldLines = flowBlocks[existingIdx].split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    const add = todayLines.filter((l) => !oldLines.includes(l));
    flowBlocks[existingIdx] = [heading, ...oldLines, ...add].join('\n');
  } else {
    flowBlocks.push(`${heading}\n${todayLines.join('\n')}`);
  }
  let keptFlow = flowBlocks.slice(-KEEP_ENTRIES);
  while (keptFlow.length > 1 && keptFlow.join('\n\n').length > MAX_FLOW_CHARS) keptFlow = keptFlow.slice(1);

  const coreSection = coreLines.length ? `${CORE_MARK}\n\n${coreLines.join('\n')}` : `${CORE_MARK}\n\n（还没有标记为长期保留的事）`;
  md = `${base}\n\n${coreSection}\n\n${FLOW_MARK}\n\n${keptFlow.join('\n\n')}\n`;
  fs.writeFileSync(MD, md, 'utf8');
  fs.writeFileSync(CURSOR, JSON.stringify({ lastTime: maxTime }), 'utf8');

  const starCount = rawBullets.filter((b) => /^-\s*★/.test(b)).length;
  log(`写入 ${rawBullets.length} 条（核心 ${starCount} 条，流水 ${rawBullets.length - starCount} 条）；蓝图 ${md.length} 字`);

  try { await api.workspace.archiveSession({ sessionId }); } catch {}
  process.exit(0);
} catch (e) {
  log(`整理失败：${e?.message ?? e}`);
  if (sessionId) { try { await api.workspace.archiveSession({ sessionId }); } catch {} }
  process.exit(1);
}
