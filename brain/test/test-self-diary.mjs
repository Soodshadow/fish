// 她自己写日记的回归测试：不连模型，用假 controller / ctx。
// 日记本 = memory/diary/日记.md，按日期分节往下写（不是一天一个文件）。
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

console.log('\n[1] 写进同一个日记本');
{
  const { ctx, controller, store } = makeFixture('今天有点累，但还行。');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: path.join(root, 's1.json'), dir });
  await diary.maybeWrite(new Date('2026-11-23T23:00:00'));
  ok('目录里只有一本', fs.readdirSync(dir).join(',') === '日记.md', fs.readdirSync(dir).join(','));
  const text = fs.readFileSync(path.join(dir, '日记.md'), 'utf8');
  ok('按日期分节', text.includes('## 2026-11-23'), text.slice(0, 80));
  ok('内容是她的原文', text.includes('今天有点累'));
  ok('记下当天已处理', diary.state.lastDay === '2026-11-23');
}

console.log('\n[2] 第二天接着写，不覆盖第一篇');
{
  const diary = new SelfDiary({ ctx: { on: () => () => {} }, controller: {}, store: {}, workspace: root, log: () => {}, stateFile: path.join(root, 's2.json'), dir });
  diary.append('2026-11-24', '第二天写的内容');
  const text = fs.readFileSync(path.join(dir, '日记.md'), 'utf8');
  ok('两节都在', text.includes('## 2026-11-23') && text.includes('## 2026-11-24'), text);
  ok('第一篇没被吃掉', text.includes('今天有点累'));
  ok('还是只有一本', fs.readdirSync(dir).length === 1);
}

console.log('\n[3] 同一天重写会替换');
{
  const diary = new SelfDiary({ ctx: { on: () => () => {} }, controller: {}, store: {}, workspace: root, log: () => {}, stateFile: path.join(root, 's3.json'), dir });
  diary.append('2026-11-24', '改了一句话');
  const text = fs.readFileSync(path.join(dir, '日记.md'), 'utf8');
  ok('旧内容被替换', !text.includes('第二天写的内容') && text.includes('改了一句话'), text);
  ok('别的日子还在', text.includes('## 2026-11-23'));
  ok('没有重复的 11-24', text.split('## 2026-11-24').length - 1 === 1);
}

console.log('\n[4] 选择不写');
{
  const dir2 = path.join(root, 'diary2');
  const { ctx, controller, store } = makeFixture('[SKIP]');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: path.join(root, 's4.json'), dir: dir2 });
  await diary.maybeWrite(new Date('2026-11-23T23:10:00'));
  ok('没有创建日记本', !fs.existsSync(path.join(dir2, '日记.md')));
  ok('记下今天已处理', diary.state.lastDay === '2026-11-23');
}

console.log('\n[5] 不到点不写');
{
  const { ctx, controller, store } = makeFixture('不该被写进去');
  const diary = new SelfDiary({ ctx, controller, store, workspace: root, log: () => {}, stateFile: path.join(root, 's5.json'), dir: path.join(root, 'diary3') });
  await diary.maybeWrite(new Date('2026-11-23T15:00:00'));
  ok('白天不触发', !diary.state.lastDay);
}

console.log('\n[6] recent 取最近几篇');
{
  const diary = new SelfDiary({ ctx: { on: () => () => {} }, controller: {}, store: {}, workspace: root, log: () => {}, stateFile: path.join(root, 's6.json'), dir });
  const recent = diary.recent(2);
  ok('取到最近两篇', recent.includes('2026-11-23') && recent.includes('2026-11-24'), recent);
  ok('带日期前缀', recent.includes('：'), recent);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
