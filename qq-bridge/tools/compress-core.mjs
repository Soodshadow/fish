// 每月压缩核心记忆：把 ⭐ 核心记忆 区合并成更凝练的条目，避免长期膨胀后被挤掉。
// 用法：node tools\compress-core.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:\\fish\\qq-bridge';
const MD = 'D:\\fish\\memory\\MEMORY-BLUEPRINT.md';
const LOG = path.join('D:\\fish\\memory', 'memory-consolidation.log');
const CORE_MARK = '## ⭐ 核心记忆（长期保留）';
const FLOW_MARK = '## 📔 记忆流水（最近 14 天）';
const TARGET_LINES = 8;

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
}

// 计划任务每天 00:30 跑一次，只在每月 1 号真正执行（--force 可强制）
if (new Date().getDate() !== 1 && !process.argv.includes('--force')) {
  process.exit(0);
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

const md = fs.readFileSync(MD, 'utf8');
const ci = md.indexOf(CORE_MARK);
const fi = md.indexOf(FLOW_MARK);
if (ci < 0 || fi < ci) { log('没找到核心记忆区，跳过。'); process.exit(0); }

const head = md.slice(0, ci + CORE_MARK.length);
const coreText = md.slice(ci + CORE_MARK.length, fi).trim();
const tail = md.slice(fi);
const lines = coreText.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));

if (lines.length <= TARGET_LINES && coreText.length <= 2200) {
  log(`核心记忆 ${lines.length} 条 / ${coreText.length} 字，暂不需要压缩。`);
  process.exit(0);
}

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

const prompt = `下面是小鲸鱼的核心记忆条目：\n\n${lines.join('\n')}\n\n请把它们合并压缩成最多 ${TARGET_LINES} 条要点，每条一行以「- 」开头。要求：保留日期、人名、约定、具体细节（地点/物品/数字），可以合并同类项，但不要丢事实、不要写成空话、不要添加原文没有的内容。只输出这些行。`;

const cwd = path.join(os.tmpdir(), 'kxt-compress-' + Date.now());
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
  const bullets = String(ended.text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ') && l.length > 5);
  if (!bullets.length) { log('模型没有返回有效条目，保持原样。'); process.exit(0); }

  const next = `${head}\n\n${bullets.join('\n')}\n\n${tail}`;
  fs.writeFileSync(MD, next, 'utf8');
  log(`核心记忆已压缩：${lines.length} 条 → ${bullets.length} 条（${md.length} → ${next.length} 字）`);
  try { await api.workspace.archiveSession({ sessionId }); } catch {}
  process.exit(0);
} catch (e) {
  log(`压缩失败：${e?.message ?? e}`);
  if (sessionId) { try { await api.workspace.archiveSession({ sessionId }); } catch {} }
  process.exit(1);
}
