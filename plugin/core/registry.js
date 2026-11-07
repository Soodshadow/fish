// fish/core/registry.js
// 组件注册表：按名字管理组件，负责生命周期顺序（依赖先启动、反向停止）。

export class Registry {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Map<string, object>} */
    this.components = new Map();
    this.order = [];
  }

  /**
   * 注册一个组件。
   * 组件对象约定（最小集）：
   *   { name, version?, dependencies?, init?, start?, stop?, health?, tools?, events?, emits? }
   */
  register(component) {
    if (!component || typeof component.name !== 'string' || !component.name) {
      throw new Error('组件必须有 name');
    }
    if (this.components.has(component.name)) {
      throw new Error(`组件重复注册: ${component.name}`);
    }
    for (const key of ['init', 'start', 'stop', 'health']) {
      if (component[key] !== undefined && typeof component[key] !== 'function') {
        throw new Error(`组件 ${component.name} 的 ${key} 必须是函数`);
      }
    }
    this.components.set(component.name, component);
    this.ctx.bus.emit('fish.component.registered', { name: component.name });
    return component;
  }

  get(name) {
    return this.components.get(name);
  }

  list() {
    return [...this.components.values()];
  }

  _topoSort() {
    const names = [...this.components.keys()];
    const state = new Map(); // 0=未访问 1=访问中 2=完成
    const result = [];
    const visit = (name, chain) => {
      const s = state.get(name) ?? 0;
      if (s === 2) return;
      if (s === 1) throw new Error(`组件依赖成环: ${chain.concat(name).join(' -> ')}`);
      state.set(name, 1);
      const comp = this.components.get(name);
      for (const dep of comp?.dependencies ?? []) {
        if (!this.components.has(dep)) throw new Error(`组件 ${name} 依赖的 ${dep} 未注册`);
        visit(dep, chain.concat(name));
      }
      state.set(name, 2);
      result.push(name);
    };
    for (const name of names) visit(name, []);
    return result;
  }

  async startAll() {
    this.order = this._topoSort();
    for (const name of this.order) {
      const comp = this.components.get(name);
      try {
        if (comp.init) await comp.init(this.ctx);
        if (comp.start) await comp.start(this.ctx);
        // 注册组件声明的事件订阅
        for (const [event, handler] of Object.entries(comp.events ?? {})) {
          if (typeof handler === 'function') this.ctx.bus.on(event, (payload) => handler(payload, this.ctx));
        }
        this.ctx.bus.emit('fish.component.ready', { name });
        console.log(`[fish] 组件已启动: ${name}`);
      } catch (error) {
        this.ctx.bus.emit('fish.component.failed', { name, error: error?.message ?? String(error) });
        console.error(`[fish] 组件启动失败: ${name}`, error?.message ?? error);
        // 一个组件失败不拖垮整个进程；需要强依赖的组件自己判断 health
      }
    }
    this.ctx.bus.emit('fish.ready', { components: this.order });
    return this.order;
  }

  async stopAll() {
    this.ctx.bus.emit('fish.stopping', {});
    for (const name of [...this.order].reverse()) {
      const comp = this.components.get(name);
      try {
        if (comp.stop) await comp.stop(this.ctx);
      } catch (error) {
        console.error(`[fish] 组件停止失败: ${name}`, error?.message ?? error);
      }
    }
  }

  async health() {
    const out = {};
    for (const [name, comp] of this.components) {
      try {
        out[name] = comp.health ? await comp.health() : { ok: true };
      } catch (error) {
        out[name] = { ok: false, error: error?.message ?? String(error) };
      }
    }
    return out;
  }
}
