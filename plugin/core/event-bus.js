// fish/core/event-bus.js
// 组件之间唯一允许的通信方式：发事件、收事件。
// 任何组件都不能直接 require 另一个组件的内部实现。

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    this.wildcards = new Set();
  }

  /** 订阅事件（返回取消订阅函数） */
  on(event, fn) {
    if (typeof fn !== 'function') throw new Error('handler 必须是函数');
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(fn);
    return () => this.off(event, fn);
  }

  /** 订阅所有事件（调试用） */
  onAny(fn) {
    this.wildcards.add(fn);
    return () => this.wildcards.delete(fn);
  }

  off(event, fn) {
    const set = this.handlers.get(event);
    if (set) { set.delete(fn); if (!set.size) this.handlers.delete(event); }
  }

  /** 同步派发；单个 handler 抛错不影响其他 handler */
  emit(event, payload) {
    const set = this.handlers.get(event);
    if (set) {
      for (const fn of [...set]) {
        try { fn(payload); } catch (error) { console.error(`[fish/event-bus] handler 抛错 (${event}):`, error?.message ?? error); }
      }
    }
    for (const fn of [...this.wildcards]) {
      try { fn(event, payload); } catch {}
    }
  }

  /** 异步派发（按顺序等待） */
  async emitAsync(event, payload) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { await fn(payload); } catch (error) { console.error(`[fish/event-bus] async handler 抛错 (${event}):`, error?.message ?? error); }
    }
  }
}

/** 标准事件名（尽量集中在这里，避免各处魔法字符串） */
export const EVENTS = Object.freeze({
  // QQ 通道
  MESSAGE_RECEIVED: 'qq.message.received',   // 收到消息 { key, kind, id, sender, text, raw }
  MESSAGE_SENT: 'qq.message.sent',           // 发出消息 { key, text }
  WAKE: 'qq.wake',                           // 唤醒 { key, reason }
  TURN_END: 'qq.turn.end',                   // 一轮结束 { key, user, assistant }
  // 记忆
  TURN_RECORDED: 'memory.turn.recorded',     // 记录了一轮对话
  // 生命周期
  COMPONENT_READY: 'fish.component.ready',
  COMPONENT_FAILED: 'fish.component.failed',
  FISH_READY: 'fish.ready',
  FISH_STOPPING: 'fish.stopping',
});
