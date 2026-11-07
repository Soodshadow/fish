// fish/components/memory/index.js
// ★ 记忆（大组件）：BLUEPRINT + ARCHIVE + 共享池 + 注入，一套连续功能不拆。
//
// 数据路径保持不变（D:\her-memory），这样插件化不影响她已有的记忆。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MEMORY_DIR = 'D:\\her-memory';

export default {
  name: 'memory',
  version: '0.1.0',
  dependencies: [],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config.components?.memory ?? {};
    this.dir = this.cfg.dir || DEFAULT_MEMORY_DIR;
    this.files = {
      blueprint: this.cfg.blueprint || path.join(this.dir, 'MEMORY-BLUEPRINT.md'),
      archive: this.cfg.archive || path.join(this.dir, 'MEMORY-ARCHIVE.md'),
      shared: this.cfg.shared || path.join(this.dir, 'shared-chat.jsonl'),
    };
    this.cache = { blueprint: { key: '', text: '' }, archive: { key: '', lines: [] } };
  },

  async start(ctx) {
    this.ctx = ctx;
    // 记录每一轮对话（供共享池/后续整理）
    this.offTurn = ctx.bus.on('qq.turn.end', (turn) => {
      this.recordTurn(turn).catch(() => {});
    });
  },

  async stop() {
    this.offTurn?.();
  },

  _statKey(file) {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch { return ''; }
  },

  /** 核心记忆全文（每轮注入）；文件没变化时用缓存 */
  blueprintText() {
    const key = this._statKey(this.files.blueprint);
    if (!key) return '';
    if (this.cache.blueprint.key === key) return this.cache.blueprint.text;
    try {
      const text = fs.readFileSync(this.files.blueprint, 'utf8');
      this.cache.blueprint = { key, text };
      return text;
    } catch { return ''; }
  },

  /** 归档行（自动回忆用） */
  archiveLines() {
    const key = this._statKey(this.files.archive);
    if (!key) return [];
    if (this.cache.archive.key === key) return this.cache.archive.lines;
    try {
      const lines = fs.readFileSync(this.files.archive, 'utf8')
        .split(/\r?\n/).filter((l) => l.trim().startsWith('- '));
      this.cache.archive = { key, lines };
      return lines;
    } catch { return []; }
  },

  /** 共享池文本（当前策略：只共享群聊内容，私聊隔离） */
  sharedText(currentKey) {
    try {
      const key = `${this._statKey(this.files.shared)}:${currentKey}`;
      if (this._sharedKey === key) return this._sharedText;
      const lines = fs.readFileSync(this.files.shared, 'utf8').split(/\r?\n/).filter(Boolean);
      const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const filtered = recs.filter((r) => {
        const k = String(r.key || '');
        if (!k.startsWith('group:')) return false;
        if (k === currentKey) return false;
        return true;
      }).slice(-100);
      this._sharedKey = key;
      this._sharedText = filtered.map((r) => this._formatRecord(r)).join('\n');
      return this._sharedText;
    } catch { return ''; }
  },

  _formatRecord(r) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(Number(r.t) || Date.now());
    const ts = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const groupId = String(r.key || '').replace('group:', '');
    const who = r.role === 'user' ? '对方' : '她';
    const text = safeSlice(stripNonBmp(String(r.text || '')), 220);
    return `[${ts}][群 ${groupId}] ${who}：${text}`;
  },

  async recordTurn({ key, user, assistant } = {}) {
    if (!key) return;
    const lines = [];
    const append = (role, text) => {
      const clean = stripNonBmp(String(text ?? '').replace(/\s+/g, ' ').trim());
      if (!clean) return;
      lines.push(JSON.stringify({ t: Date.now(), key, role, text: safeSlice(clean, 500) }));
    };
    append('user', user);
    append('assistant', assistant);
    if (!lines.length) return;
    fs.appendFileSync(this.files.shared, lines.join('\n') + '\n', 'utf8');
    this.ctx?.bus.emit('memory.turn.recorded', { key });
  },

  async health() {
    return {
      ok: fs.existsSync(this.files.blueprint),
      blueprint: this.files.blueprint,
      exists: fs.existsSync(this.files.blueprint),
    };
  },
};

// —— 工具函数（与 bridge.js 里的实现保持一致）——

/** 按码点截断，绝不在 emoji 代理对中间切断 */
export function safeSlice(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** 去掉所有非 BMP 字符与代理，彻底避免编码问题（emoji 曾被截断成孤立代理导致 400） */
export function stripNonBmp(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    if (cp > 0xFFFF) continue;
    out += ch;
  }
  return out;
}
