// 每日记忆整理的回归测试：不连模型，用假 controller / ctx。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryDigest } from '../bridge/memory-digest.js';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-digest-'));
const stateFile = path.join(root, 'digest.json');

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
    async create() { return { sessionId: 'session-digest' }; },
    async prompt() {
      setTimeout(() => {
        for (const handler of [...events]) {
          handler({ id: 'session-digest' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } });
          handler({ id: 'session-digest' }, { type: 'turn/end', data: {} });
        }
      }, 0);
      return {};
    },
  };
  const now = Date.now();
  const store = {
    messages: [
      { t: now - 3 * 3600000, key: 'group:20001', role: 'user', text: '今天心累' },
      { t: now - 3 * 3600000 + 5000, key: 'group:20001', role: 'assistant', text: '那跟身累不一样' },
      { t: now - 2 * 3600000, key: 'private:10001', role: 'user', text: '帮我查个链接' },
    ],
  };
  const written = [];
  const diary = {
    append(records) { written.push(...records); return records.length; },
  };
  return { ctx, controller, store, diary, written };
}

console.log('\n[1] 晚上整理一次');
{
  const { ctx, controller, store, diary, written } = makeFixture(JSON.stringify([
    { kind: 'event', text: '早上他说心累，她没追问，怕他为了回答硬编一个', weight: 0.6 },
    { kind: 'fact', text: '他在看一个 AI 技能商店，她判断不像骗钱但提醒风险在脚本', weight: 0.5 },
  ]));
  const digest = new MemoryDigest({ ctx, controller, store, diary, workspace: root, log: () => {}, stateFile, hour: 23 });
  await digest.maybeDigest(new Date(`${new Date().toISOString().slice(0, 10)}T23:30:00`));
  ok('写入了两条事情', written.length === 2, JSON.stringify(written.map((w) => w.text)));
  ok('保留了 kind', written[0].kind === 'event' && written[1].kind === 'fact');
  ok('带上日期', written.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.date)));
  ok('同一天不重复整理', digest.state.lastDay === new Date().toISOString().slice(0, 10));
}

console.log('\n[2] 说不值得记');
{
  const stateFile2 = path.join(root, 'digest2.json');
  const { ctx, controller, store, diary, written } = makeFixture('[]');
  const digest = new MemoryDigest({ ctx, controller, store, diary, workspace: root, log: () => {}, stateFile: stateFile2, hour: 23 });
  await digest.maybeDigest(new Date(`${new Date().toISOString().slice(0, 10)}T23:40:00`));
  ok('没有写入', written.length === 0);
  ok('标记今天已处理', digest.state.lastDay === new Date().toISOString().slice(0, 10));
}

console.log('\n[3] 不到点不整理');
{
  const { ctx, controller, store, diary, written } = makeFixture('[]');
  const digest = new MemoryDigest({ ctx, controller, store, diary, workspace: root, log: () => {}, stateFile: path.join(root, 'digest3.json'), hour: 23 });
  await digest.maybeDigest(new Date(`${new Date().toISOString().slice(0, 10)}T15:00:00`));
  ok('白天不触发', !digest.state.lastDay && written.length === 0);
}

console.log('\n[4] 能抠出代码块里的 JSON');
{
  const stateFile4 = path.join(root, 'digest4.json');
  const reply = '```json\n[{"kind":"promise","text":"他说想让她主动找他聊天，她答应了","weight":0.8}]\n```';
  const { ctx, controller, store, diary, written } = makeFixture(reply);
  const digest = new MemoryDigest({ ctx, controller, store, diary, workspace: root, log: () => {}, stateFile: stateFile4, hour: 23 });
  await digest.maybeDigest(new Date(`${new Date().toISOString().slice(0, 10)}T23:50:00`));
  ok('解析出 1 条', written.length === 1, JSON.stringify(written));
  ok('类型正确', written[0]?.kind === 'promise');
}

console.log('\n[5] 当天没有对话就跳过');
{
  const stateFile5 = path.join(root, 'digest5.json');
  const { ctx, controller, diary, written } = makeFixture('[]');
  const digest = new MemoryDigest({ ctx, controller, store: { messages: [] }, diary, workspace: root, log: () => {}, stateFile: stateFile5, hour: 23 });
  const day = new Date().toISOString().slice(0, 10);
  await digest.maybeDigest(new Date(`${day}T23:00:00`));
  ok('不触发模型', written.length === 0 && digest.state.lastDay === day);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
