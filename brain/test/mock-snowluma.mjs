// 测试用：替换 @snowluma/sdk，不连真实网关。
// 由 test-flow.mjs 通过 module.register 注入。
export class SnowLumaWebSocketClient {
  constructor(options = {}) {
    this.options = options;
    this.handlers = new Map();
    this.sent = [];
    this.closed = false;
    globalThis.__mockBots = globalThis.__mockBots || [];
    globalThis.__mockBots.push(this);
  }

  on(event, callback) {
    const list = this.handlers.get(event) || [];
    list.push(callback);
    this.handlers.set(event, list);
    return this;
  }

  emit(event, ...args) {
    for (const callback of this.handlers.get(event) || []) {
      try { callback(...args); } catch {}
    }
  }

  onPrivateMessage(cb) { this.privateHandler = cb; return this; }
  onGroupMessage(cb) { this.groupHandler = cb; return this; }
  onNotice(cb) { this.noticeHandler = cb; return this; }

  async connect() {
    // 直接当连上了，避免 bootstrap 里的重连逻辑干扰测试
    this.emit('open');
  }

  close() { this.closed = true; }

  async sendPrivateMessage(id, segments) {
    this.sent.push({ kind: 'private', id, segments });
    return { message_id: `mock-p-${this.sent.length}` };
  }

  async sendGroupMessage(id, segments) {
    this.sent.push({ kind: 'group', id, segments });
    return { message_id: `mock-g-${this.sent.length}` };
  }

  async groupPoke() {}
  async friendPoke() {}
}
