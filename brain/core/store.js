// 小鱼大脑 · 共享记忆库（core）
// 设计约束：
//   1. 零依赖：只用 Node 内置模块，任何 Node/Electron 环境都能跑；
//   2. 单一来源：所有读写都走这里，桥接和桌面面板不直接碰文件；
//   3. 可并发：消息只追加（append-only），人物/会话用 tmp+rename 原子替换；
//   4. 幂等：消息 id 由 (时间|会话|角色|内容) 哈希得到，重复导入不会重复。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function messageId(record) {
  const raw = `${record.t}|${record.key}|${record.role}|${record.text}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(dataDir = 'D:\\fish\\brain\\data') {
    this.dir = dataDir;
    this.files = {
      messages: path.join(dataDir, 'messages.jsonl'),
      memories: path.join(dataDir, 'memories.jsonl'),
      people: path.join(dataDir, 'people.json'),
      conversations: path.join(dataDir, 'conversations.json'),
    };
    this.messages = [];
    this.messageIds = new Set();
    this.memories = [];
    this.people = {};
    this.conversations = {};
    this.loaded = false;
  }

  ensureDirs() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'summaries'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'core'), { recursive: true });
  }

  load() {
    if (this.loaded) return this;
    this.ensureDirs();
    this.messages = this.#readJsonl(this.files.messages);
    this.messageIds = new Set(this.messages.map((m) => m.id));
    this.memories = this.#readJsonl(this.files.memories);
    this.people = readJson(this.files.people, {});
    this.conversations = readJson(this.files.conversations, {});
    this.loaded = true;
    return this;
  }

  #readJsonl(file) {
    try {
      return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 追加消息。返回 { added, skipped }。
   * record: { t(epoch ms), key, platform, conv, role, text, source? }
   */
  appendMessages(records) {
    this.load();
    const fresh = [];
    for (const record of records) {
      const text = String(record.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text || !record.key || !record.t) continue;
      const candidate = {
        id: messageId({ ...record, text }),
        t: Number(record.t),
        key: String(record.key),
        platform: record.platform || 'qq',
        conv: record.conv || record.key,
        role: record.role === 'assistant' ? 'assistant' : 'user',
        text,
        source: record.source || 'shared-chat',
      };
      if (this.messageIds.has(candidate.id)) continue;
      this.messageIds.add(candidate.id);
      fresh.push(candidate);
    }
    if (fresh.length) {
      fs.appendFileSync(this.files.messages, `${fresh.map((m) => JSON.stringify(m)).join('\n')}\n`, 'utf8');
      this.messages.push(...fresh);
    }
    return { added: fresh.length, skipped: records.length - fresh.length };
  }

  /** 按条件搜消息（内存扫描，几万条以内足够快）。 */
  searchMessages({ query = '', key = '', since = 0, until = 0, limit = 50 } = {}) {
    this.load();
    const q = String(query).toLowerCase();
    const out = [];
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (key && m.key !== key) continue;
      if (since && m.t < since) continue;
      if (until && m.t > until) continue;
      if (q && !m.text.toLowerCase().includes(q)) continue;
      out.push(m);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 人物：{ id, platform, kind, display, policy:{proactivity, attitude}, audience:[...] } */
  getPerson(id) {
    this.load();
    return this.people[id] || null;
  }

  upsertPerson(id, patch = {}) {
    this.load();
    const current = this.people[id] || { id, platform: 'qq', kind: 'unknown', display: '', policy: {}, audience: [] };
    this.people[id] = {
      ...current,
      ...patch,
      policy: { ...(current.policy || {}), ...(patch.policy || {}) },
      audience: patch.audience ?? current.audience ?? [],
    };
    writeJsonAtomic(this.files.people, this.people);
    return this.people[id];
  }

  upsertConversation(key, patch = {}) {
    this.load();
    const current = this.conversations[key] || { key, platform: 'qq', kind: key.startsWith('group:') ? 'group' : 'private', title: '' };
    this.conversations[key] = { ...current, ...patch };
    writeJsonAtomic(this.files.conversations, this.conversations);
    return this.conversations[key];
  }

  appendMemory(record) {
    this.load();
    const entry = {
      id: record.id || `mem_${crypto.randomBytes(8).toString('hex')}`,
      kind: record.kind || 'fact',
      text: String(record.text ?? ''),
      about: record.about || [],
      scope: record.scope || {},
      audience: record.audience || [],
      t: record.t || Date.now(),
      importance: Number(record.importance ?? 0.5),
      confidence: Number(record.confidence ?? 0.8),
      source: record.source || {},
      access: { count: 0, lastAt: 0 },
    };
    fs.appendFileSync(this.files.memories, `${JSON.stringify(entry)}\n`, 'utf8');
    this.memories.push(entry);
    return entry;
  }

  readMemories() {
    this.load();
    return this.memories;
  }

  stats() {
    this.load();
    const byKey = new Map();
    for (const m of this.messages) {
      const row = byKey.get(m.key) || { key: m.key, count: 0, first: m.t, last: m.t };
      row.count += 1;
      row.first = Math.min(row.first, m.t);
      row.last = Math.max(row.last, m.t);
      byKey.set(m.key, row);
    }
    return {
      dir: this.dir,
      messages: this.messages.length,
      memories: this.memories.length,
      people: Object.keys(this.people).length,
      conversations: Object.keys(this.conversations).length,
      byConversation: [...byKey.values()].sort((a, b) => b.count - a.count),
    };
  }
}
