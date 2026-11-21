// dsh-fish-brain · 后台半（Node 半）
// 职责：把大脑数据（D:\fish\brain\data）通过同源路由暴露给桌面面板。
// 只读为主；写入等权限功能接入后再加。

import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../core/store.js';

export const name = 'fish-brain';
export const inject = ['webServer'];

const DATA_DIR = 'D:\\fish\\brain\\data';
const STATE_DIR = 'D:\\fish\\brain\\state';
const MEMORY_ARCHIVE = 'D:\\fish\\memory\\MEMORY-ARCHIVE.md';
const LOG_FILE = path.join(STATE_DIR, 'host.log');

function log(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // 日志失败不能影响插件加载
  }
}

function sendJson(res, statusCode, value) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

/**
 * 每次请求都重新读库：桥接会持续追加，缓存会看到旧数据。
 * 但 4.6k 条消息 ≈ 925KB，面板一次打开就要读好几次（stats / search / memory-graph），
 * 所以按 messages.jsonl 的 size+mtime 做缓存：文件没变就复用上一份解析结果。
 */
let cachedStore = null;
let cachedStamp = '';
function openStore() {
  const file = path.join(DATA_DIR, 'messages.jsonl');
  let stamp = 'missing';
  try {
    const st = fs.statSync(file);
    stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    stamp = 'missing';
  }
  if (cachedStore && stamp === cachedStamp) return cachedStore;
  cachedStore = new Store(DATA_DIR).load();
  cachedStamp = stamp;
  return cachedStore;
}

// 记忆库只有几 KB，但 stats 和 memory-graph 会各读一次；1 秒内复用
let archiveCache = { at: 0, text: '' };
function readArchive() {
  const now = Date.now();
  if (now - archiveCache.at < 1000) return archiveCache.text;
  let text = '';
  try { text = fs.readFileSync(MEMORY_ARCHIVE, 'utf8'); } catch { text = ''; }
  archiveCache = { at: now, text };
  return text;
}

function handleSearch(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const query = url.searchParams.get('q') ?? '';
  const key = url.searchParams.get('key') ?? '';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40));
  const store = openStore();
  const items = store.searchMessages({ query, key, limit });
  sendJson(res, 200, { ok: true, total: store.messages.length, count: items.length, items });
}

function handleStats(req, res) {
  const store = openStore();
  const archive = readArchive();
  const memoryEntries = archive ? archive.split(/\r?\n/).filter((line) => /^-\s/.test(line)).length : 0;
  sendJson(res, 200, { ok: true, ...store.stats(), memoryEntries });
}

/** 语义星图：读 MEMORY-ARCHIVE.md 的记忆条目，按 kind 分组。 */
function handleMemoryGraph(req, res) {
  let entries = [];
  try {
    const text = readArchive();
    const lines = text.split(/\r?\n/);
    let date = '';
    for (const line of lines) {
      const section = line.match(/^###\s*(\d{4}-\d{2}-\d{2})/);
      if (section) { date = section[1]; continue; }
      const entry = line.match(/^-\s*(?:(\d{2}-\d{2}|\d{2}:\d{2})\s*)?(?:\[([^\]]+)\]\s*)?(.+)$/);
      if (!entry || !date) continue;
      let body = entry[3].trim();
      let source = '';
      let manualWeight = 1;
      let refreshed = '';
      const wm = body.match(/[｜|]\s*w\s*=\s*([0-9.]+)/i);
      if (wm) { manualWeight = Number(wm[1]); body = body.replace(/[｜|]\s*w\s*=\s*[0-9.]+\s*/i, ' '); }
      const rm = body.match(/[｜|]\s*r\s*=\s*(\d{4}-\d{2}-\d{2})/i);
      if (rm) { refreshed = rm[1]; body = body.replace(/[｜|]\s*r\s*=\s*\d{4}-\d{2}-\d{2}\s*/i, ' '); }
      const tagged = body.match(/^(.*)（([^（）]+)）$/);
      if (tagged) { body = tagged[1].trim(); source = tagged[2].trim(); }
      body = body.trim();
      const baseDate = refreshed && refreshed > date ? refreshed : date;
      const days = Math.max(0, (Date.now() - Date.parse(`${baseDate}T12:00:00+08:00`)) / 86400000);
      const weight = Math.min(1, manualWeight) * Math.exp(-days / 30);
      entries.push({
        date,
        time: entry[1] && entry[1].includes(':') ? entry[1] : '',
        kind: entry[2] || 'memory',
        text: body.slice(0, 200),
        source,
        weight,
      });
    }
  } catch {
    entries = [];
  }
  entries.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const recent = entries.slice(-200);
  const counts = {};
  for (const entry of recent) counts[entry.kind] = (counts[entry.kind] || 0) + 1;
  sendJson(res, 200, { ok: true, entries: recent, counts, total: entries.length });
}

const PERSON_FIELDS = ['display', 'relation', 'attitude', 'tone', 'taboos', 'notes'];

function handlePeople(req, res) {
  if (req.method === 'GET') {
    const store = openStore();
    const people = Object.values(store.people || {}).map((person) => ({
      id: person.id,
      display: person.display || '',
      relation: person.relation || '',
      attitude: person.attitude || '',
      tone: person.tone || '',
      taboos: person.taboos || '',
      notes: person.notes || '',
    }));
    return sendJson(res, 200, { ok: true, people });
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    try {
      const input = JSON.parse(body || '{}');
      const id = String(input.id || '');
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
      const patch = {};
      for (const key of PERSON_FIELDS) {
        if (typeof input.patch?.[key] === 'string') patch[key] = input.patch[key].slice(0, 500);
      }
      const store = openStore();
      const person = store.upsertPerson(id, patch);
      return sendJson(res, 200, { ok: true, person });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
}

export function apply(ctx) {
  log(`host apply node=${process.versions.node} electron=${process.versions.electron ?? '-'}`);

  try {
    const routes = [
      ['/api/fish-brain/ping', (req, res) => sendJson(res, 200, { ok: true, at: new Date().toISOString() })],
      ['/api/fish-brain/stats', handleStats],
      ['/api/fish-brain/search', handleSearch],
      ['/api/fish-brain/people', handlePeople],
      ['/api/fish-brain/memory-graph', handleMemoryGraph],
    ];
    ctx.effect(() => {
      const disposers = routes.map(([routePath, handler]) => ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler: (req, res) => {
          try {
            if (routePath !== '/api/fish-brain/ping') log(`hit ${routePath} ${req.url ?? ''}`);
            handler(req, res);
          } catch (error) {
            log(`route error ${routePath}: ${error?.message ?? error}`);
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }));
      log(`routes registered: ${routes.map(([p]) => p).join(' ')}`);
      return () => disposers.forEach((dispose) => dispose());
    }, 'fish-brain: routes');
  } catch (error) {
    log(`route register failed: ${error?.message ?? error}`);
  }

  // 由本插件拉起 QQ 桥接（同一个宿主进程）。
  // 单独把桥接做成 profile 条目时，桌面端的加载器不认这个新条目；挂在已加载的插件上最稳。
  import('../bridge/index.js')
    .then((mod) => {
      log('starting bridge module');
      return mod.apply(ctx);
    })
    .catch((error) => log(`bridge start failed: ${error?.stack ?? error?.message ?? error}`));
}
