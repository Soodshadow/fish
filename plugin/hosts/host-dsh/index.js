// fish/hosts/host-dsh/index.js
// 宿主适配：host-dsh —— 复用 DSH 的 agent 循环。
//
// 现阶段（0.1.0）：
//   - 不接管 QQ 收发（仍由 bridge.js 负责）
//   - 把 bridge 实例注入 qq-channel，让组件可以主动发消息
//   - 提供 health / status
//
// 后续演进：
//   - 把 bridge.js 的「agent 调用」替换成调用本 host 的 adapter（接口不变）
//   - 组件通过 ctx 访问 host，而不是直接碰 bridge 内部

export function createDshHost({ bridge = null, log = console.log } = {}) {
  let attached = false;

  return {
    name: 'host-dsh',

    async init(ctx) {
      this.ctx = ctx;
      this.log = log;
    },

    async start(ctx) {
      this.ctx = ctx;
      // 如果调用方已有 bridge 实例，把它接到 qq-channel
      if (bridge) this.attachBridge(bridge);
      this.log('[fish/host-dsh] 已就绪（复用 DSH agent 循环）');
    },

    attachBridge(bridgeInstance) {
      const channel = this.ctx?.components?.get?.('qq-channel');
      if (!channel) {
        this.log('[fish/host-dsh] 找不到 qq-channel，跳过 bridge 注入');
        return false;
      }
      channel.attachBridge(bridgeInstance);
      attached = true;
      this.log('[fish/host-dsh] bridge 已注入 qq-channel');
      return true;
    },

    /** 供桥接在初始化完成后调用：fish 组件现在可以主动发消息了 */
    notifyBridgeReady(bridgeInstance) {
      if (bridgeInstance) this.attachBridge(bridgeInstance);
      this.ctx?.bus?.emit('host.dsh.bridge.ready', { attached });
    },

    async health() {
      return { ok: true, attached, mode: 'dsh' };
    },
  };
}
