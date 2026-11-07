// fish/components/admin-tools/index.js
// ★ 管理工具（大组件）：改资料/头像/昵称/状态/说说/撤回/点赞。
// 只有管理员私聊可用（权限由 host-dsh 侧 preset 控制，这里只做能力声明）。

export default {
  name: 'admin-tools',
  version: '0.1.0',
  dependencies: ['qq-channel'],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config.components?.['admin-tools'] ?? {};
  },

  async start() {},

  /** 管理工具清单（由 host-dsh 注册成 MCP 工具；具体调用走 qq-channel 的 onebot 通道） */
  tools: [
    { name: 'qq_set_nickname', description: '修改昵称', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'qq_set_avatar', description: '修改头像', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'qq_set_profile', description: '修改资料', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'qq_set_online_status', description: '修改在线状态', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'qq_post_qzone', description: '发说说', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'qq_delete_msg', description: '撤回消息', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'qq_send_like', description: '点赞', handler: async () => ({ ok: false, error: '待接入' }) },
  ],

  async health() {
    return { ok: true, note: '能力声明阶段，实际工具仍由 mcp-qq-admin.js 提供' };
  },
};
