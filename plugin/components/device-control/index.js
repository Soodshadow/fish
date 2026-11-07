// fish/components/device-control/index.js
// ★ 设备控制（大组件）：安卓模拟器通过 ADB 截图/点击/输入/shell。
// 只有管理员私聊可用。

export default {
  name: 'device-control',
  version: '0.1.0',
  dependencies: [],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config.components?.['device-control'] ?? {};
    this.adb = this.cfg.adb || 'adb';
    this.serial = this.cfg.serial || null; // 可配置默认设备
  },

  async start() {},

  tools: [
    { name: 'android_screenshot', description: '截取模拟器屏幕', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'android_tap', description: '点击屏幕坐标', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'android_swipe', description: '滑动', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'android_text', description: '输入文本', handler: async () => ({ ok: false, error: '待接入' }) },
    { name: 'android_shell', description: '执行 adb shell 命令', handler: async () => ({ ok: false, error: '待接入' }) },
  ],

  async health() {
    return { ok: true, note: '能力声明阶段，实际工具仍由 mcp-android.js 提供' };
  },
};
