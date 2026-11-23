// 她自己写日记的回归测试：不连模型，用假 controller / ctx。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfDiary } from '../bridge/self-diary.js';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-diary-'));
const dir = path.join(root, 'diary');

function makeFixture(reply) {
  const events = [];
  const ctx = {
    on(eventName, handler) {
      if (typeof handler !== 'function') return () => {};
      events.push(handler);
      return () => {
        const i = events.indexOf(handler);
        if (i >= 0) events.splice(i, 1);
      };
    },
  };
  const controller = {
    async create() { return { sessionId: 'session-diary' }; },
    async prompt() {
      setTimeout(() => {
        for (const handler of [...events]) {
          handler({ id: 'session-diary' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } });
          handler({ id: 'session-diary' }, { type: 'turn/end', data: {} });
        }
      }, 0);
      return {};
    },
  };
  const store = { messages: [{ t: Date.now() - 3600000, key: 'group:20001', role: 'user', text: '今天群里聊了开学' }] };
  return { ctx, controller, store };
}

console.log('\n[1] 会写的时候：一天一个文件');
{
  const { ctx, controller, store } = makeFixture('今天有点累，但还行。');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: path.join(root, 's1.json'), dir });
  await diary.maybeWrite(new Date('2026-11-23T23:00:00'));
  const file = path.join(dir, '2026-11-23.md');
  ok('文件按日期生成', fs.existsSync(file), fs.readdirSync(dir).join(','));
  ok('内容是她的原文', fs.readFileSync(file, 'utf8').includes('今天有点累'));
  ok('记下当天已处理', diary.state.lastDay === '2026-11-23');

  // 再写一天：直接调 append，验证是两个文件、不互相覆盖
  diary.append('2026-11-24', '第二天的内容');
  ok('第二天生成新文件', fs.existsSync(path.join(dir, '2026-11-24.md')), fs.readdirSync(dir).join(','));
  ok('第一天的还在', fs.readFileSync(file, 'utf8').includes('今天有点累'));
}

console.log('\n[2] 选择不写');
{
  const dir2 = path.join(root, 'diary2');
  const { ctx, controller, store } = makeFixture('[SKIP]');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: path.join(root, 's2.json'), dir: dir2 });
  await diary.maybeWrite(new Date('2026-11-23T23:10:00'));
  ok('没有创建目录/文件', !fs.existsSync(dir2), fs.existsSync(dir2) ? fs.readdirSync(dir2).join(',') : '');
  ok('记下今天已处理', diary.state.lastDay === '2026-11-23');
}

console.log('\n[3] 不到点不写');
{
  const { ctx, controller, store } = makeFixture('不该被写进去');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: path.join(root, 's3.json'), dir: path.join(root, 'diary3') });
  await diary.maybeWrite(new Date('2026-11-23T15:00:00'));
  ok('白天不触发', !diary.state.lastDay);
}

console.log('\n[4] 最近几篇按日期取');
{
  const dir4 = path.join(root, 'diary4');
  fs.mkdirSync(dir4, { recursive: true });
  fs.writeFileSync(path.join(dir4, '2026-11-20.md'), '星期一的事\n', 'utf8');
  fs.writeFileSync(path.join(dir4, '2026-11-21.md'), '星期二的事\n', 'utf8');
  fs.writeFileSync(path.join(dir4, '2026-11-22.md'), '星期三的事\n', 'utf8');
  fs.writeFileSync(path.join(dir4, 'notes.txt'), '不是日记\n', 'utf8');
  const diary = new SelfDiary({ ctx: { on: () => () => {} }, controller: {}, store: {}, workspace: root, log: () => {}, stateFile: path.join(root, 's4.json'), dir: dir4 });
  const recent = diary.recent(2);
  ok('只取最近两篇', recent.includes('星期三的事') && recent.includes('星期二的事') && !recent.includes('星期一的事'), recent);
  ok('忽略非日记文件', !recent.includes('不是日记'));
  ok('带日期前缀', recent.includes('2026-11-22：'), recent);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
