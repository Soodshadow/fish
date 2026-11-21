// 协议与权限的回归测试（不需要 DSH 运行时）。
// 跑法：node D:\fish\brain\test\test-protocol.mjs
// 用假号：桥接从 env 读 owner/self QQ，测试里不能带真实号码。
process.env.FISH_OWNER_QQ = '10001';
process.env.FISH_SELF_QQ = '10000';
const {
  parseFaceSegments,
  diaryEntryAllowed,
  needsRecall,
  groupMentionsOf,
  formatMentions,
  name: pluginName,
} = await import('../bridge/index.js');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}

console.log('\n[1] 表情协议：未知表情不能泄漏成文本');
{
  const known = parseFaceSegments('好啊[face:微笑]');
  ok('已知表情拆成 text + face', known.length === 2 && known[1].type === 'face' && known[1].data.id === 14,
    JSON.stringify(known));

  const unknown = [];
  const dropped = [];
  const mixed = parseFaceSegments('好[face:不存在的表情]啊', (n) => unknown.push(n));
  ok('未知表情被丢掉', !JSON.stringify(mixed).includes('不存在的表情'), JSON.stringify(mixed));
  ok('未知表情回调一次', unknown.length === 1, JSON.stringify(unknown));
  ok('前后文本保留', mixed.filter((s) => s.type === 'text').map((s) => s.data.text).join('') === '好啊',
    JSON.stringify(mixed));

  const only = parseFaceSegments('[face:瞎编]', (n) => dropped.push(n));
  ok('整句只有未知表情时返回空', only.length === 0, JSON.stringify(only));

  const numeric = parseFaceSegments('[face:14]');
  ok('数字表情名可用', numeric.length === 1 && numeric[0].type === 'face' && numeric[0].data.id === 14,
    JSON.stringify(numeric));

  const colon = parseFaceSegments('[表情：微笑]');
  ok('全角冒号也认', colon.length === 1 && colon[0].type === 'face', JSON.stringify(colon));
}

console.log('\n[2] 记忆可见性：群里也要能想起老条目');
{
  const old = { date: '2026-10-23', text: '迁移前的旧记忆', source: '' };
  const groupMem = { date: '2026-10-23', text: '这个群里的事', source: '群623855' };
  const otherGroup = { date: '2026-10-23', text: '别的群的事', source: '群828338' };
  const privateMem = { date: '2026-11-18', text: '私聊里的事', source: '私聊10001' };

  ok('无来源记忆：群里可见', diaryEntryAllowed(old, 'group:1030623855'));
  ok('无来源记忆：私聊可见', diaryEntryAllowed(old, 'private:10001'));
  ok('本群记忆：群里可见', diaryEntryAllowed(groupMem, 'group:1030623855'));
  ok('别的群记忆：群里不可见', !diaryEntryAllowed(otherGroup, 'group:1030623855'));
  ok('私聊记忆：群里不可见', !diaryEntryAllowed(privateMem, 'group:1030623855'));
  ok('私聊记忆：本人私聊可见', diaryEntryAllowed(privateMem, 'private:10001'));
  ok('私聊记忆：别人私聊不可见', !diaryEntryAllowed(privateMem, 'private:10002'));
  ok('群记忆：私聊可见（她本来就知道）', diaryEntryAllowed(otherGroup, 'private:10001'));
  ok('全 ID 来源也认', diaryEntryAllowed({ date: '2026-11-18', text: 'x', source: '群1030623855' }, 'group:1030623855'));

  // 旧条目没有来源字段，但正文自曝「私聊 xxx」：不能让群里被诱导出来
  const implicit = { date: '2026-10-29', text: '私聊 10002：他开玩笑说家里猫要吃鱼要抓走我', source: '' };
  ok('无来源但正文写了私聊号：群里不可见', !diaryEntryAllowed(implicit, 'group:1030623855'));
  ok('无来源但正文写了私聊号：私聊仍可见', diaryEntryAllowed(implicit, 'private:10001'));
}

console.log('\n[3] 回忆信号');
{
  ok('“还记得上次吗”触发', needsRecall('你还记得上次说的吗'));
  ok('普通寒暄不触发', !needsRecall('今天吃什么'));
  ok('空串不触发', !needsRecall(''));
  ok('“有人找过我吗”触发', needsRecall('今天群里有人找我吗'));
  ok('“找过你”触发', needsRecall('顾言言是不是下午私聊找你了'));
  ok('“谁找过我”触发', needsRecall('今天谁找过我'));
}

console.log('\n[4] 群提及检索');
{
  const now = Date.now();
  const store = {
    messages: [
      { t: now - 3 * 3600000, key: 'group:1030623855', role: 'user', text: '@10000 感冒了好难受' },
      { t: now - 3 * 3600000 + 1000, key: 'group:1030623855', role: 'assistant', text: '感冒就挑好欺负的' },
      { t: now - 2 * 3600000, key: 'group:1030623855', role: 'user', text: '今天真好' },
      { t: now - 3600000, key: 'group:874828338', role: 'user', text: '（拍了拍你）' },
      { t: now - 600000, key: 'private:10001', role: 'user', text: '@10000 在吗' },
    ],
  };
  const hits = groupMentionsOf(store, 24, 12);
  ok('只捞群里的 @ / 拍一拍', hits.length === 2, `实际 ${hits.length}: ${hits.map((h) => h.text).join(' | ')}`);
  ok('私聊里的 @ 不算', !hits.some((h) => h.key.startsWith('private:')));
  const text = formatMentions(hits);
  ok('格式带群号和对方', text.includes('[群 1030623855]') && text.includes('对方：'), text);
}

console.log(`\n插件名：${pluginName}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
