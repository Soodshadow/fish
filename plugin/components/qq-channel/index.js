// fish/components/qq-channel/index.js
// ★ QQ 通道（大组件）：收发 + 发送工具 + 唤醒/已读，一套连续功能不拆。
//
// 分步接管策略：
//   1) 纯文本、无引用/无@ → 组件自己直连 OneBot 发送（sendTextViaOneBot）
//   2) 其余复杂消息（引用/@/图片/分条）→ 回退 bridge.sendToQQ（保留旧逻辑）
// 这样组件开始真正承担发送，但复杂路径不受影响。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_HTTP = 'http://127.0.0.1:3000';

export default {
  name: 'qq-channel',
  version: '0.2.0',
  dependencies: [],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config.components?.['qq-channel'] ?? {};
    this.bridge = null; // 待 host-dsh 注入
    this.onebot = this.cfg.onebot ?? null; // { httpUrl, accessToken }
  },

  async start(ctx) {
    this.ctx = ctx;
    // 订阅：核心/组件发来的「要发 QQ 消息」请求
    this.offSend = ctx.bus.on('qq.send.request', (payload) => {
      this.send(payload).catch((error) => {
        ctx.bus.emit('qq.send.failed', { ...payload, error: error?.message ?? String(error) });
      });
    });
  },

  async stop() {
    this.offSend?.();
  },

  /** host-dsh 把 bridge 实例注入进来（复杂消息回退用） */
  attachBridge(bridge) {
    this.bridge = bridge;
  },

  /** 解析 OneBot 连接配置：组件配置优先，其次读桥接 config.json */
  resolveOneBot() {
    if (this.onebot?.httpUrl) return this.onebot;
    try {
      const root = this.cfg.bridgeRoot ?? 'D:\\fish\\qq-bridge';
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
      return {
        httpUrl: String(cfg.snowluma?.httpUrl || DEFAULT_HTTP).replace(/\/+$/, ''),
        accessToken: String(cfg.snowluma?.accessToken || '')
      };
    } catch {
      return { httpUrl: DEFAULT_HTTP, accessToken: '' };
    }
  },

  /** 组件自己调 OneBot 发纯文本（私聊/群聊） */
  async sendTextViaOneBot(key, text) {
    return this.sendSegments(key, [{ type: 'text', data: { text: String(text) } }]);
  },

  /**
   * 组件直连 OneBot 发消息段（文本/图片/引用/@ 都支持）。
   * segments 用 OneBot 数组格式：[{type:'text',data:{text}}, {type:'image',data:{file}} ...]
   */
  async sendSegments(key, segments) {
    const { httpUrl, accessToken } = this.resolveOneBot();
    const [kind, id] = String(key).split(':');
    if (!id) throw new Error(`无效会话 key: ${key}`);
    const isGroup = kind === 'group';
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const body = isGroup ? { group_id: Number(id), message: segments } : { user_id: Number(id), message: segments };
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === 'failed' || (json.retcode !== undefined && json.retcode !== 0)) {
      throw new Error(`OneBot ${action} 失败: ${json.wording || json.retcode || res.status}`);
    }
    return json.data;
  },

  /**
   * 发送消息：
   *  - 纯文本且无引用/无@ → 组件直连 OneBot
   *  - 复杂消息 → 回退 bridge
   */
  async send({ key, text, replyTo, atUserId }) {
    const target = { key, text, replyTo, atUserId };
    this.ctx?.bus.emit('qq.message.sending', target);

    const simple = !replyTo && !atUserId && typeof text === 'string' && text.trim().length > 0;
    if (simple) {
      try {
        await this.sendTextViaOneBot(key, text);
        this.ctx?.bus.emit('qq.message.sent', { ...target, via: 'component' });
        return { ok: true, via: 'component' };
      } catch (error) {
        // 组件直发失败 → 回退 bridge（若可用），避免漏消息
        this.ctx?.bus.emit('qq.send.failed', { ...target, error: error?.message ?? String(error) });
        if (!this.bridge?.sendToQQ) throw error;
      }
    }

    if (!this.bridge?.sendToQQ) throw new Error('qq-channel 尚未接入 bridge');
    await this.bridge.sendToQQ(key, text, { replyTo, atUserId });
    this.ctx?.bus.emit('qq.message.sent', { ...target, via: 'bridge' });
    return { ok: true, via: 'bridge' };
  },

  async health() {
    const cfg = this.resolveOneBot();
    return { ok: Boolean(this.bridge), bridge: Boolean(this.bridge), onebot: cfg.httpUrl };
  },

  // 对外工具（由 host-dsh 转换成 MCP/agent 工具）
  tools: [
    {
      name: 'qq_send_message',
      description: '在当前 QQ 会话里发消息',
      handler: async ({ key, messages }) => {
        const list = Array.isArray(messages) ? messages : [messages];
        for (const m of list) await this.ctx.components.get('qq-channel')?.send?.({ key, text: m });
        return { ok: true };
      },
    },
  ],
};
