// fish/components/search/index.js
// ★ 联网搜索（大组件）：web_search / web_fetch。

export default {
  name: 'search',
  version: '0.1.0',
  dependencies: [],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config.components?.search ?? {};
  },

  async start() {},

  tools: [
    { name: 'web_search', description: '联网搜索', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'web_fetch', description: '抓取网页正文', handler: async () => ({ ok: false, error: '待接入' }) },
  ],

  async health() {
    return { ok: true, note: '能力声明阶段，实际工具仍由 mcp-web-search-safe.js 提供' };
  },
};
