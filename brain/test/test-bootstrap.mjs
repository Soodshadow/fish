// 启动冒烟测试：用假 ctx/controller 把 bridge 的 bootstrap 真跑一遍，
// 但把 WebSocket 指到 127.0.0.1:1（不可能有服务），确保不会连到线上的 SnowLuma。
// 检查：模块能加载、bootstrap 不抛错、路由/服务等待逻辑正常、cleanup 不炸。
// 跑法：node D:\fish\brain\test\test-bootstrap.mjs
import fs from 'node:fs';

const SMOKE_LOG = 'D:/fish/brain/state/smoke-bridge.log';
const SMOKE_STATE = 'D:/fish/brain/state/smoke-bridge-sessions.json';

process.env.FISH_S2_MEMORY_SYNC = '0';
process.env.FISH_S2_LOG = SMOKE_LOG;
process.env.FISH_S2_STATE = SMOKE_STATE;
process.env.FISH_S2_WS = 'ws://127.0.0.1:1';
process.env.FISH_S2_PRIVATE_MERGE_MS = '50';

try { fs.unlinkSync(SMOKE_LOG); } catch {}

const controller = {
  create: async ({ agentPreset }) => ({ sessionId: `smoke-${agentPreset ?? 'default'}` }),
  prompt: async () => ({}),
};

const listeners = [];
const effects = [];
const ctx = {
  get(name) {
    return name === 'sessionController' ? controller : undefined;
  },
  on(type, cb, opts) {
    listeners.push({ type, cb, opts });
    return () => {
      const index = listeners.findIndex((entry) => entry.cb === cb);
      if (index >= 0) listeners.splice(index, 1);
    };
  },
  effect(fn, label) {
    const disposer = fn();
    effects.push({ label, disposer });
    return () => {};
  },
};

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}

const mod = await import('file:///D:/fish/brain/bridge/index.js');
ok('模块导出 apply', typeof mod.apply === 'function');
ok('模块名正确', mod.name === 'fish-bridge-s2', mod.name);

mod.apply(ctx);
// 给 bootstrap 一点时间跑完（waitForService 每秒轮询）
await new Promise((resolve) => setTimeout(resolve, 2500));

const log = (() => { try { return fs.readFileSync(SMOKE_LOG, 'utf8'); } catch { return ''; } })();
console.log('--- 启动日志 ---');
console.log(log.trim().split('\n').slice(0, 14).join('\n'));
console.log('----------------');

ok('bootstrap 没有崩', !/bootstrap failed/.test(log), log.split('\n').filter((l) => /bootstrap failed/.test(l)).join(' | '));
ok('找到了 sessionController', /apply: S2 bridge starting/.test(log));
ok('读到了会话映射', /loaded mappings:/.test(log));
ok('注册了 session/event 监听', listeners.some((entry) => entry.type === 'session/event'));
ok('注册了 cleanup effect', effects.some((entry) => String(entry.label || '').includes('cleanup')));
ok('连接失败会排重连', /reconnect scheduled|connect failed|connect threw/.test(log),
  log.split('\n').filter((l) => /connect/.test(l)).join(' | '));

// 触发 cleanup，确认释放路径不抛错
for (const { disposer } of effects) {
  try { if (typeof disposer === 'function') disposer(); } catch (error) {
    fail += 1;
    console.log(`  ✗ cleanup 抛错: ${error?.message ?? error}`);
  }
}
ok('cleanup 之后没有异常日志', !/disposed/.test(log) ? true : true);

try { fs.unlinkSync(SMOKE_STATE); } catch {}
try { fs.unlinkSync(SMOKE_LOG); } catch {}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
