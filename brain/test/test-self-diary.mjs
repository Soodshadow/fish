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
const file = path.join(root, 'DIARY.md');
const stateFile = path.join(root, 'state.json');

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
      // 模拟模型回复：先发 message，再发 turn/end
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

console.log('\n[1] 会写的时候');
{
  const { ctx, controller, store } = makeFixture('今天有点累，但还行。');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile, file });
  await diary.maybeWrite(new Date('2026-11-23T23:00:00'));
  const text = fs.readFileSync(file, 'utf8');
  ok('写进了日记文件', text.includes('## 2026-11-23'), text.slice(0, 120));
  ok('内容是她写的', text.includes('今天有点累'), text.slice(0, 200));
  ok('同一天不再重复', diary.state.lastDay === '2026-11-23');
}

console.log('\n[2] 选择不写');
{
  const stateFile2 = path.join(root, 'state2.json');
  const file2 = path.join(root, 'DIARY2.md');
  const { ctx, controller, store } = makeFixture('[SKIP]');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: stateFile2, file: file2 });
  await diary.maybeWrite(new Date('2026-11-23T23:10:00'));
  ok('没有创建文件', !fs.existsSync(file2));
  ok('记下今天已经处理过', diary.state.lastDay === '2026-11-23');
}

console.log('\n[3] 不到点不写');
{
  const stateFile3 = path.join(root, 'state3.json');
  const { ctx, controller, store } = makeFixture('不该被写进去');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: stateFile3, file: path.join(root, 'DIARY3.md') });
  await diary.maybeWrite(new Date('2026-11-23T15:00:00'));
  ok('白天不触发', !diary.state.lastDay);
}

console.log('\n[4] 最近几篇能读出来');
{
  const diarist = new SelfDiary({ ctx: { on: () => () => {} }, controller: {}, store: {}, workspace: root, log: () => {}, stateFile: path.join(root, 's4.json'), file: path.join(root, 'DIARY-LONG.md') });
  fs.writeFileSync(diarist.file, [
    '## 2026-11-20', '', '星期一的事', '',
    '## 2026-11-21', '', '星期二的事', '',
    '## 2026-11-22', '', '星期三的事', '',
  ].join('\n'), 'utf8');
  const recent = diarist.recent(2);
  ok('只取最近两篇', recent.includes('星期三的事') && recent.includes('星期二的事') && !recent.includes('星期一的事'), recent);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
