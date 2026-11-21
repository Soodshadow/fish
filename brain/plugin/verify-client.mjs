// 离线验证 dsh-fish-brain 的客户端模块（左侧栏插件页形态）：
// 1) module/exports 约定 + 语法；
// 2) 是否注册了左栏图标 + 主面板；
// 3) 组件能否渲染（stub React）。
// 不接触桌面端。

import fs from 'node:fs';
import vm from 'node:vm';

const FILE = 'D:/fish/brain/plugin/client.js';
const src = fs.readFileSync(FILE, 'utf8');

let definition = null;
const sandbox = { window: { __ModuleLoader__: { load(def) { definition = def; } } }, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: FILE });
if (!definition) throw new Error('没有调用 __ModuleLoader__.load');
console.log('✓ 模块已注册:', definition.id);

const stubReact = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  Fragment: 'Fragment',
};
const mod = definition.factory((name) => {
  if (name === 'react') return stubReact;
  throw new Error(`意外的 require: ${name}`);
});
if (typeof mod.apply !== 'function') throw new Error('未导出 apply');
console.log('✓ exports.apply / inject:', JSON.stringify(mod.inject));

const regs = [];
const ctx = {
  slots: {
    inject(name, cb) { cb(); },
    register(options, component) {
      regs.push({ options, component });
      return () => {};
    },
  },
};

mod.apply(ctx);
console.log('✓ 注册的席位:', regs.map((r) => r.options.name).join(', '));
if (regs.length !== 2) throw new Error(`期望 2 个席位，实际 ${regs.length}`);
const names = regs.map((r) => r.options.name);
for (const required of ['sidebar.panellist', 'main']) {
  if (!names.includes(required)) throw new Error(`缺少席位 ${required}`);
}

for (const reg of regs) {
  const tree = reg.component({ size: 20, active: false });
  if (!tree) throw new Error(`${reg.options.name} 渲染为空`);
  console.log('✓ 渲染通过:', reg.options.name);
}

console.log('\n全部通过。');
