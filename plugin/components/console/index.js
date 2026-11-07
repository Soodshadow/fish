// fish/components/console/index.js
// ★ 控制台（大组件）：桥接自带的 HTTP 控制台（3100）—— 状态/日志/指令。
// 它独立于 admin-tools 和 device-control：那两者是 QQ/设备能力，这里是运维界面。

export default {
  name: 'console',
  version: '0.1.0',
  dependencies: [],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config.components?.console ?? {};
    this.port = Number(this.cfg.port) || 3100;
  },

  async start(ctx) {
    // 现状：控制台由 bridge.js 内建（3100），这里只做健康检查适配。
    // 后续若把 HTTP 控制台拆出来，实现放这里，接口不变。
  },

  async health() {
    const net = await import('node:net');
    return await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: this.port }, () => {
        socket.destroy();
        resolve({ ok: true, port: this.port });
      });
      socket.on('error', () => resolve({ ok: false, port: this.port }));
      socket.setTimeout(1500, () => { socket.destroy(); resolve({ ok: false, port: this.port, timeout: true }); });
    });
  },
};
