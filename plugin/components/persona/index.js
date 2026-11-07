// fish/components/persona/index.js
// ★ 角色（大组件）：角色卡读取 + 人设注入。
// 数据路径保持 D:\qq-bridge\roles 不变。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROLE_DIR = 'D:\\qq-bridge\\roles';

export default {
  name: 'persona',
  version: '0.1.0',
  dependencies: [],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config.components?.persona ?? {};
    this.dir = this.cfg.dir || DEFAULT_ROLE_DIR;
    this.roleFile = this.cfg.role || path.join(this.dir, '小鲸鱼.md');
    this.cache = { key: '', text: '' };
  },

  async start() {},

  /** 角色卡全文（每轮注入） */
  roleText() {
    try {
      const st = fs.statSync(this.roleFile);
      const key = `${st.mtimeMs}:${st.size}`;
      if (this.cache.key === key) return this.cache.text;
      const text = fs.readFileSync(this.roleFile, 'utf8');
      this.cache = { key, text };
      return text;
    } catch { return ''; }
  },

  async health() {
    return { ok: fs.existsSync(this.roleFile), role: this.roleFile };
  },
};
