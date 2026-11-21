// 消息链路测试：mock 掉 SnowLuma，把「收到消息 → 攒批 → 组 prompt → 收到回复 → 发出去」
// 整条路真跑一遍，确认私聊合并、群聊判断、表情协议、身份注入都没坏。
// 跑法：node D:\fish\brain\test\test-flow.mjs
import fs from 'node:fs';
import { register } from 'node:module';

const LOG = 'D:/fish/brain/state/flow-bridge.log';
const STATE = 'D:/fish/brain/state/flow-bridge-sessions.json';
const TEMP_DATA = 'D:/fish/brain/state/test-flow-data';
const TEMP_MEMORY = 'D:/fish/brain/state/test-flow-memory.md';
process.env.FISH_S2_MEMORY_SYNC = '0';
process.env.FISH_S2_LOG = LOG;
process.env.FISH_S2_STATE = STATE;
process.env.FISH_S2_PRIVATE_MERGE_MS = '120';
process.env.FISH_S2_BATCH_MS = '120';
process.env.FISH_S2_COOLDOWN_MS = '0';
process.env.FISH_S2_MIN_CALL_MS = '0';
process.env.FISH_S2_WAKE_CHANCE = '0';
// 数据目录必须指向临时目录：否则测试消息会写进她真实的聊天记录里
process.env.FISH_S2_DATA = TEMP_DATA;
process.env.FISH_S2_OWN_IDS = 'D:/fish/brain/state/test-flow-own-ids.json';
process.env.FISH_S2_MEMORY_STATE = 'D:/fish/brain/state/test-flow-memory-state.json';
process.env.FISH_S2_MEMORY = TEMP_MEMORY;
// 测试配置也用假号，避免把真实 QQ 带进公开仓库
const TEMP_CONFIG = `${TEMP_DATA}/config.json`;
process.env.FISH_S2_CONFIG = TEMP_CONFIG;

try { fs.unlinkSync(LOG); } catch {}
try { fs.unlinkSync(STATE); } catch {}
try { fs.unlinkSync(process.env.FISH_S2_OWN_IDS); } catch {}
try { fs.unlinkSync(process.env.FISH_S2_MEMORY_STATE); } catch {}
fs.rmSync(TEMP_DATA, { recursive: true, force: true });
fs.mkdirSync(TEMP_DATA, { recursive: true });
fs.writeFileSync(TEMP_MEMORY, '### 2026-11-01\n\n- 11-01 [fact] 测试用的一条旧记忆（私聊318745）\n', 'utf8');
fs.writeFileSync(TEMP_CONFIG, JSON.stringify({
  ownerQQ: '10001',
  selfQQ: '10000',
  allow: { private: ['10001', '10002'], groups: ['20001'] },
}, null, 2), 'utf8');
// 预置一条「十分钟前的旧对话」：换新会话时应该被补进开场上下文
fs.writeFileSync(`${TEMP_DATA}/messages.jsonl`, `${JSON.stringify({
  id: 'seed0000000001',
  t: Date.now() - 600000,
  key: 'private:10001',
  platform: 'qq',
  conv: 'private:10001',
  role: 'user',
  text: '上周说的那件事',
  source: 's2',
})}\n`, 'utf8');

register('./mock-loader.mjs', import.meta.url);

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 私聊合并窗口是 Math.max(500, FISH_S2_PRIVATE_MERGE_MS)，所以统一等 900ms
const MERGE_WAIT = 900;

const prompts = [];
let sessionSeq = 0;
const controller = {
  async create({ agentPreset }) {
    sessionSeq += 1;
    return { sessionId: `flow-${sessionSeq}-${agentPreset ?? 'default'}` };
  },
  async prompt(payload) {
    prompts.push(payload);
    return {};
  },
};
const listeners = [];
const effects = [];
const ctx = {
  get(name) { return name === 'sessionController' ? controller : undefined; },
  on(type, cb, opts) {
    listeners.push({ type, cb, opts });
    return () => {};
  },
  effect(fn, label) {
    const disposer = fn();
    effects.push({ label, disposer });
    return () => {};
  },
};

/** 模拟一轮模型回复：turn/start → assistant/message → turn/end */
function emitTurn(sessionId, text) {
  const callbacks = listeners.filter((entry) => entry.type === 'session/event').map((entry) => entry.cb);
  const turn = `turn-${Math.random().toString(16).slice(2)}`;
  for (const cb of callbacks) {
    cb({ id: sessionId }, { type: 'turn/start', data: { turn } });
    cb({ id: sessionId }, {
      type: 'assistant/message',
      data: { turn, message: { content: [{ type: 'text', text }] } },
    });
    cb({ id: sessionId }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
}

const privateEvent = (text, id) => ({
  self_id: '10000',
  user_id: '10001',
  message_id: id,
  message: [{ type: 'text', data: { text } }],
});

const mod = await import('file:///D:/fish/brain/bridge/index.js');
mod.apply(ctx);
await sleep(2500);

const bot = globalThis.__mockBots?.at(-1);
ok('桥接创建了 bot 实例', Boolean(bot));
ok('拿到私聊/群聊回调', Boolean(bot?.privateHandler) && Boolean(bot?.groupHandler));
if (!bot) { console.log('\n没有 bot，后面的用例无法继续'); process.exit(1); }
ok('bootstrap 没崩', !/bootstrap failed/.test((() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })()));

// ── 1. 私聊连发两条：应该只产生一次 prompt ──
console.log('\n[1] 私聊连发合并');
bot.privateHandler(privateEvent('在吗', '9001'));
bot.privateHandler(privateEvent('帮我看看这个', '9002'));
await sleep(MERGE_WAIT);

ok('两条合并成一次 prompt', prompts.length === 1, `实际 ${prompts.length}`);
const privatePrompt = prompts[0]?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('合并后两条都在', privatePrompt.includes('在吗') && privatePrompt.includes('帮我看看这个'));
ok('注入了人设蓝图', privatePrompt.includes('你是谁·核心记忆'), privatePrompt.slice(0, 100));
ok('新会话补上了上次聊到的地方',
  privatePrompt.includes('你和这里上次聊到的地方') && privatePrompt.includes('上周说的那件事'),
  privatePrompt.slice(-300));
const privateSession = prompts[0]?.sessionId;
ok('prompt 带 sessionId', Boolean(privateSession), String(privateSession));

// ── 2. 回复 → 发送 ──
console.log('\n[2] 私聊回复发送');
const sentBefore2 = bot.sent.length;
emitTurn(privateSession, '看一眼\n别急');
await sleep(1300);
const privateSent = bot.sent.slice(sentBefore2).filter((item) => item.kind === 'private');
ok('发出去了', privateSent.length >= 1, JSON.stringify(bot.sent.slice(sentBefore2)).slice(0, 200));
ok('按换行分成两条', privateSent.length === 2, `实际 ${privateSent.length}`);

// ── 3. 未知表情不能泄漏 ──
console.log('\n[3] 未知表情不泄漏');
bot.privateHandler(privateEvent('再来一次', '9003'));
await sleep(MERGE_WAIT);
const sentBefore3 = bot.sent.length;
emitTurn(prompts.at(-1)?.sessionId, '好[face:瞎编的表情]的');
await sleep(400);
const lastSend = bot.sent[bot.sent.length - 1];
const sentText = JSON.stringify(lastSend?.segments ?? []);
ok('发出去的内容不含 [face:瞎编的表情]', !sentText.includes('瞎编'), sentText.slice(0, 200));
ok('这一轮真的发了东西', bot.sent.length > sentBefore3);

// ── 3b. 写长文：提示要注入，分条上限不能只有 4 ──
console.log('\n[3b] 写长文');
bot.privateHandler(privateEvent('按你自己的想法，写一篇800字的作文', '9006'));
await sleep(MERGE_WAIT);
const writingPrompt = prompts.at(-1)?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('写长文的 prompt 带了【长文】提示', writingPrompt.includes('【长文】'), writingPrompt.slice(-220));
ok('提示里说明了不要报字数', writingPrompt.includes('数不准字数'), writingPrompt.slice(-220));

const sentBeforeLong = bot.sent.length;
emitTurn(prompts.at(-1)?.sessionId,
  Array.from({ length: 10 }, (_, i) => `第${i + 1}段内容`).join('\n'));
await sleep(8000);
const longSent = bot.sent.slice(sentBeforeLong).filter((item) => item.kind === 'private');
ok('长文不会被砍回 4 条', longSent.length > 4, `实际 ${longSent.length}`);
ok('上限是 8 条', longSent.length === 8, `实际 ${longSent.length}`);

// ── 4. 群里没叫她：不该产生 prompt ──
console.log('\n[4] 群聊没被叫不打扰');
const promptsBefore4 = prompts.length;
bot.groupHandler({
  self_id: '10000',
  user_id: '10003',
  group_id: '20001',
  message_id: '9101',
  sender: { card: '伊芙' },
  message: [{ type: 'text', data: { text: '今天好热' } }],
});
await sleep(500);
ok('普通群消息不触发模型', prompts.length === promptsBefore4, `${promptsBefore4} -> ${prompts.length}`);

// ── 5. 群里 @她：要回，而且要知道自己是谁 ──
console.log('\n[5] 群里 @她');
bot.groupHandler({
  self_id: '10000',
  user_id: '10003',
  group_id: '20001',
  message_id: '9102',
  sender: { card: '伊芙' },
  message: [
    { type: 'at', data: { qq: '10000', name: '蓝莓' } },
    { type: 'text', data: { text: ' 你觉得呢' } },
  ],
});
await sleep(500);
ok('@ 她会触发一次 prompt', prompts.length === promptsBefore4 + 1, `${promptsBefore4} -> ${prompts.length}`);
const groupPrompt = prompts.at(-1)?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('群里 prompt 带在场的人', groupPrompt.includes('在场的人'), groupPrompt.slice(-160));
ok('群里 prompt 说明了她的 QQ', groupPrompt.includes('你是 10000'));
ok('群里 prompt 有防认领提醒', groupPrompt.includes('不要认领成自己的'));

const groupSession = prompts.at(-1)?.sessionId;
const groupSentBefore = bot.sent.length;
emitTurn(groupSession, '热就少穿点');
await sleep(400);
ok('群里回了话', bot.sent.slice(groupSentBefore).some((item) => item.kind === 'group' && String(item.id) === '20001'));

// ── 5b. 回完话之后，别人接话也要能进模型 ──
console.log('\n[5b] 回完话后别人接话');
const promptsBeforeFollow = prompts.length;
bot.groupHandler({
  self_id: '10000',
  user_id: '10002',
  group_id: '20001',
  message_id: '9103',
  sender: { card: '顾言言' },
  message: [{ type: 'text', data: { text: '那你们两个聊什么呢' } }],
});
// 群消息合并窗口最低 3 秒（BATCH_WAIT_MS 的下限），这里要等够
await sleep(3600);
ok('窗口内别人说话会进模型', prompts.length === promptsBeforeFollow + 1,
  `${promptsBeforeFollow} -> ${prompts.length}`);
const followPrompt = prompts.at(-1)?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('送进模型的就是这个人的话', followPrompt.includes('那你们两个聊什么呢'), followPrompt.slice(-120));
emitTurn(prompts.at(-1)?.sessionId, '没聊什么');
await sleep(300);

// ── 5c. 爸爸在群里发文字（没 @她）也要进模型 ──
console.log('\n[5c] 爸爸群里发言');
const promptsBeforeOwnerGroup = prompts.length;
bot.groupHandler({
  self_id: '10000',
  user_id: '10001',
  group_id: '20001',
  message_id: '9104',
  sender: { card: '月虚影' },
  message: [{ type: 'text', data: { text: '群友其实就像一个ai模型一样' } }],
});
// 爸爸的消息走 4 秒合并窗口
await sleep(4600);
ok('爸爸发文字会进模型', prompts.length === promptsBeforeOwnerGroup + 1, `${promptsBeforeOwnerGroup} -> ${prompts.length}`);
const ownerGroupPrompt = prompts.at(-1)?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('prompt 里有爸爸在说话的提示', ownerGroupPrompt.includes('爸爸在群里说话'), ownerGroupPrompt.slice(-200));
ok('prompt 里带上了他说的话', ownerGroupPrompt.includes('ai模型'), ownerGroupPrompt.slice(-200));
emitTurn(prompts.at(-1)?.sessionId, '确实像');
await sleep(300);

// ── 6. 空回复不污染队列 ──
console.log('\n[6] 空回复不污染队列');
bot.privateHandler(privateEvent('先说一句', '9004'));
await sleep(MERGE_WAIT);
emitTurn(prompts.at(-1)?.sessionId, '');
await sleep(200);
bot.privateHandler(privateEvent('再说一句', '9005'));
await sleep(MERGE_WAIT);
const promptAfterEmpty = prompts.at(-1)?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('空回复之后下一条照常处理', promptAfterEmpty.includes('再说一句'), promptAfterEmpty.slice(-80));
emitTurn(prompts.at(-1)?.sessionId, '好的');
await sleep(400);
ok('空回复没有被记录成一句空话',
  !bot.sent.slice(-1).some((item) => String(JSON.stringify(item.segments)).includes('""')));

// ── 7. 敏感记忆：先问主人，1 才发 ──
console.log('\n[7] 敏感记忆审批');
fs.appendFileSync(TEMP_MEMORY, '\n### 2026-11-18\n\n- 11-18 [fact] 主人上次说要带她去医院复查，还说要早点睡\n', 'utf8');

const promptsBeforeApprove = prompts.length;
bot.groupHandler({
  self_id: '10000',
  user_id: '10003',
  group_id: '20001',
  message_id: '9201',
  sender: { card: '伊芙' },
  message: [
    { type: 'at', data: { qq: '10000', name: '蓝莓' } },
    { type: 'text', data: { text: ' 你还记得上次说要去医院吗' } },
  ],
});
await sleep(600);
ok('陌生人问旧事会触发一次 prompt', prompts.length === promptsBeforeApprove + 1,
  `${promptsBeforeApprove} -> ${prompts.length}`);
const recallPrompt = prompts.at(-1)?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('prompt 里确实注入了旧事', recallPrompt.includes('你想起来的旧事'), recallPrompt.slice(-200));

const sentBeforeApprove = bot.sent.length;
emitTurn(prompts.at(-1)?.sessionId, '他说周五要去医院复查');
await sleep(500);
const groupSends = bot.sent.slice(sentBeforeApprove).filter((item) => item.kind === 'group');
const ownerAsks = bot.sent.slice(sentBeforeApprove)
  .filter((item) => item.kind === 'private' && String(item.id) === '10001');
ok('群里没有直接发出去', groupSends.length === 0, JSON.stringify(groupSends).slice(0, 200));
ok('私聊问主人了', ownerAsks.length === 1, `实际 ${ownerAsks.length}`);
ok('询问里带上了她的草稿', JSON.stringify(ownerAsks[0]?.segments ?? '').includes('医院'));

// 主人回 1 = 发
bot.privateHandler({
  self_id: '10000',
  user_id: '10001',
  message_id: '9301',
  message: [{ type: 'text', data: { text: '1' } }],
});
await sleep(800);
const approvedGroup = bot.sent.slice(sentBeforeApprove)
  .filter((item) => item.kind === 'group' && String(item.id) === '20001');
ok('回 1 之后发到群里了', approvedGroup.length === 1, `实际 ${approvedGroup.length}`);

// 再来一次，主人回 2 = 不发
bot.groupHandler({
  self_id: '10000',
  user_id: '10003',
  group_id: '20001',
  message_id: '9202',
  sender: { card: '伊芙' },
  message: [
    { type: 'at', data: { qq: '10000', name: '蓝莓' } },
    { type: 'text', data: { text: ' 你上次是不是还说要早点睡' } },
  ],
});
await sleep(600);
const sentBeforeReject = bot.sent.length;
emitTurn(prompts.at(-1)?.sessionId, '他说了要早点睡');
await sleep(500);
const rejectedAsks = bot.sent.slice(sentBeforeReject)
  .filter((item) => item.kind === 'private' && String(item.id) === '10001');
ok('第二次又问了一次主人', rejectedAsks.length === 1, `实际 ${rejectedAsks.length}`);

bot.privateHandler({
  self_id: '10000',
  user_id: '10001',
  message_id: '9302',
  message: [{ type: 'text', data: { text: '2' } }],
});
await sleep(600);
const rejectedGroup = bot.sent.slice(sentBeforeReject).filter((item) => item.kind === 'group');
ok('回 2 之后群里没有消息', rejectedGroup.length === 0, JSON.stringify(rejectedGroup).slice(0, 200));

// 主人私聊问普通问题不该被审批命令吞掉
const promptsBeforeOwnerChat = prompts.length;
bot.privateHandler({
  self_id: '10000',
  user_id: '10001',
  message_id: '9303',
  message: [{ type: 'text', data: { text: '今天累不累' } }],
});
await sleep(MERGE_WAIT);
ok('主人正常聊天不受影响', prompts.length === promptsBeforeOwnerChat + 1,
  `${promptsBeforeOwnerChat} -> ${prompts.length}`);

// ── 7b. 私聊问「谁找过我」要能翻出群里的记录 ──
console.log('\n[7b] 私聊问「谁找过我」');
const promptsBeforeLookup = prompts.length;
bot.privateHandler(privateEvent('今天群里有人找我吗', '9007'));
await sleep(MERGE_WAIT);
ok('触发了 prompt', prompts.length === promptsBeforeLookup + 1, `${promptsBeforeLookup} -> ${prompts.length}`);
const lookupPrompt = prompts.at(-1)?.content?.find((part) => part.type === 'text')?.text ?? '';
ok('注入了群里找她的记录', lookupPrompt.includes('最近 24 小时群里有人找你'), lookupPrompt.slice(-300));
ok('记录里有那条 @ 她的消息', lookupPrompt.includes('@蓝莓'), lookupPrompt.slice(-300));
emitTurn(prompts.at(-1)?.sessionId, '顾言言在群里叫过我');
await sleep(300);

// ── 8. 记忆判断不重复排 ──
console.log('\n[8] 运行健康');
const logText = (() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })();
ok('没有 handle error', !/handle error/.test(logText), logText.split('\n').filter((l) => /handle error/.test(l)).slice(0, 2).join(' | '));
ok('合并日志出现过', /MERGED private:10001/.test(logText));
ok('审批日志出现过', /APPROVAL requested/.test(logText) && /APPROVED/.test(logText), logText.split('\n').filter((l) => /APPROVAL|APPROVED|REJECTED/.test(l)).join(' | '));
ok('拒绝也记录了', /REJECTED/.test(logText));

for (const { disposer } of effects) {
  try { if (typeof disposer === 'function') disposer(); } catch {}
}
try { fs.unlinkSync(LOG); } catch {}
try { fs.unlinkSync(STATE); } catch {}
try { fs.unlinkSync(process.env.FISH_S2_OWN_IDS); } catch {}
try { fs.unlinkSync(process.env.FISH_S2_MEMORY_STATE); } catch {}
try { fs.unlinkSync(TEMP_MEMORY); } catch {}
try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
