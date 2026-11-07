// fish/index.js —— 小鱼插件入口（同时支持两种用法）
//
// 用法 A：作为 DSH 插件被 DSH 加载（界面可见、可启用/禁用）
//   DSH 读取 cordis.patch.yml 里的 `id: fish` 行 → import 本文件 → 调用 apply(ctx, config)
//   本插件向 DSH 注册：① 系统提示词段（角色卡 + 核心记忆）② 状态查询
//
// 用法 B：作为模块被桥接引入（组件化运行）
//   const { createFish } = await import('../../plugin/index.js')
//   const fish = await createFish({ bridge })
//
// 用法 C：单独启动（只做组件健康检查/调试）
//   node index.js --health

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventBus } from './core/event-bus.js';
import { Registry } from './core/registry.js';
import { createDshHost } from './hosts/host-dsh/index.js';

import qqChannel from './components/qq-channel/index.js';
import bridge from './components/bridge/index.js';
import memory from './components/memory/index.js';
import persona from './components/persona/index.js';
import adminTools from './components/admin-tools/index.js';
import deviceControl from './components/device-control/index.js';
import search from './components/search/index.js';
import consoleComponent from './components/console/index.js';

// ═══════════════════════════════════════════════════════════════════════
// DSH 插件入口（让 fish 出现在 DSH 插件界面）
// ═══════════════════════════════════════════════════════════════════════

/** DSH 插件名。 */
export const name = 'fish';

/** 依赖 DSH 的系统提示词注册表。 */
export const inject = ['systemPrompt'];

/** 运行时配置默认值（DSH 会传入 cordis.patch.yml 里 config 的内容）。 */
const FISH_DEFAULTS = {
  enabled: true,
  memoryDir: 'D:\\fish\\memory',
  roleDir: 'D:\\fish\\roles',
  roleFile: '小鲸鱼.md',
  maxInjectChars: 12000,
};

/**
 * DSH 插件入口。
 * 向 DSH 注册一条系统提示词段：角色卡 + 核心记忆（BLUEPRINT）。
 * 这些内容会注入到每个 agent 会话的系统提示词里，作为她的人设与长期记忆。
 */
export function apply(ctx, config) {
  const cfg = { ...FISH_DEFAULTS, ...(config ?? {}) };
  if (cfg.enabled === false) return;

  const resolveRoleFile = () => {
    const candidate = path.isAbsolute(cfg.roleFile) ? cfg.roleFile : path.join(cfg.roleDir, cfg.roleFile);
    return candidate;
  };

  const readFileSafe = (file, maxChars) => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!maxChars || text.length <= maxChars) return text;
      return text.slice(0, maxChars) + '\n…（已截断）';
    } catch { return ''; }
  };

  // 注册系统提示词段（DSH 的 systemPrompt 服务）
  const section = () => {
    const role = readFileSafe(resolveRoleFile(), 0);
    const blueprint = readFileSafe(path.join(cfg.memoryDir, 'MEMORY-BLUEPRINT.md'), cfg.maxInjectChars);
    const parts = [];
    if (role) parts.push(`【小鱼角色卡】\n${role}`);
    if (blueprint) parts.push(`【小鱼核心记忆】\n${blueprint}`);
    return parts.join('\n\n');
  };

  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'fish-persona-memory',
      // 位置放在前面：人设和核心记忆优先于普通工具说明
      order: -100,
      text: section,
    }));
    console.log(`[fish] 插件已激活：角色卡 ${resolveRoleFile()}，记忆 ${path.join(cfg.memoryDir, 'MEMORY-BLUEPRINT.md')}`);
  } catch (error) {
    console.error('[fish] 注册系统提示词段失败：', error?.message ?? error);
  }

  // 阶段 1 bridge 组件已回退（投递闭环未突破，避免抢 WS/干扰桥接）。
  // 如需重新实验：把 bridge 组件移入独立测试 profile，不要挂到主 profile。
}

// ═══════════════════════════════════════════════════════════════════════
// 组件化运行入口（桥接引入时使用）
// ═══════════════════════════════════════════════════════════════════════

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, 'config', 'fish.config.json');

/** 内置组件清单（加新组件 = 在这里 import 并加入数组 + 配置里开开关） */
const BUILTIN_COMPONENTS = [qqChannel, memory, persona, adminTools, deviceControl, search, consoleComponent];

export function loadConfig(configPath = DEFAULT_CONFIG) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[fish] 读取配置失败 ${configPath}:`, error?.message ?? error);
    return { components: {} };
  }
}

export async function createFish({ configPath = DEFAULT_CONFIG, bridge = null, log = console.log } = {}) {
  const config = loadConfig(configPath);
  const bus = new EventBus();

  // ctx 先建好（组件 init 里会读 ctx.config），再把 registry 挂上去
  const ctx = {
    bus,
    config,
    log,
    registry: null,
    components: null,
    host: null,
    get(name) { return ctx.registry?.get(name); },
    /** 组件读写共享状态的小黑板（不要塞大对象） */
    state: {},
  };
  const registry = new Registry(ctx);
  ctx.registry = registry;
  ctx.components = registry;

  // 宿主
  const host = createDshHost({ bridge, log });
  ctx.host = host;
  await host.init?.(ctx);

  // 注册启用的组件
  const enabled = new Set(
    Object.entries(config.components ?? {})
      .filter(([, cfg]) => cfg?.enabled !== false)
      .map(([name]) => name)
  );
  for (const comp of BUILTIN_COMPONENTS) {
    if (!enabled.has(comp.name)) {
      log(`[fish] 组件已跳过（未启用）: ${comp.name}`);
      continue;
    }
    registry.register(comp);
  }

  const api = {
    ctx,
    registry,
    host,
    config,
    async start() {
      await registry.startAll();
      await host.start?.(ctx);
      return api;
    },
    async stop() {
      await registry.stopAll();
    },
    async health() {
      return {
        components: await registry.health(),
        host: await host.health?.(),
      };
    },
    /** 桥接初始化完成时调用，把 bridge 交给组件 */
    attachBridge(bridgeInstance) {
      return host.notifyBridgeReady?.(bridgeInstance);
    },
  };

  return api;
}

// —— CLI：node fish/index.js --health ——
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const fish = await createFish();
  if (process.argv.includes('--start')) {
    await fish.start();
    console.log('[fish] 组件已启动，按 Ctrl+C 退出');
    process.on('SIGINT', async () => { await fish.stop(); process.exit(0); });
  } else {
    // 健康检查也要先 start：组件在 init 里读配置、在 start 里挂事件。
    // 只是没有 QQ 连接，所以不会有副作用。
    await fish.start();
    const health = await fish.health();
    console.log(JSON.stringify(health, null, 2));
    await fish.stop();
    process.exit(0);
  }
}
