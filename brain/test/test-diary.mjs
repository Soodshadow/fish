// diary.js 的回归测试：解析、可见性、写入不丢条目。
// 跑法：node D:\fish\brain\test\test-diary.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Diary } from '../bridge/diary.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`); }
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-diary-'));
  return path.join(dir, 'MEMORY-ARCHIVE.md');
}

const sample = `### 2026-11-01

- 11-01 旧格式流水，没有类型也没有来源
- 11-01 [fact] 有类型没来源的一条

### 2026-11-10

- 11-10 [promise] 答应的事（私聊318745）｜w=0.8
- 11-10 [fact] 群里的事（群623855）
`;

console.log('\n[1] 解析');
{
  const file = tmpFile();
  fs.writeFileSync(file, sample, 'utf8');
  const diary = new Diary(file);
  const entries = diary.parse();
  ok('条目数 = 4', entries.length === 4, `实际 ${entries.length}`);
  ok('无来源旧条目 source 为空', entries[0].source === '', JSON.stringify(entries[0]));
  ok('括号来源被解析', entries[2].source === '私聊318745', JSON.stringify(entries[2].source));
  ok('手动权重被读出', entries[2].weight === 0.8, JSON.stringify(entries[2].weight));
  ok('kind 默认 memory', entries[0].kind === 'memory', entries[0].kind);
}

console.log('\n[2] 追加 + 去重');
{
  const file = tmpFile();
  fs.writeFileSync(file, sample, 'utf8');
  const diary = new Diary(file);
  const added = diary.append([
    { date: '2026-11-19', time: '18:40', kind: 'fact', text: '新的一条', source: '私聊318745', weight: 0.7 },
    { date: '2026-11-19', time: '18:41', kind: 'fact', text: '有类型没来源的一条', source: '' },
  ]);
  ok('只新增 1 条（另一条重复被去重）', added === 1, `实际 ${added}`);
  const after = diary.parse();
  ok('新增条目读得回来', after.some((e) => e.text === '新的一条'), JSON.stringify(after.map((e) => e.text)));
  ok('旧条目一条没少', after.filter((e) => e.date === '2026-11-10').length === 2);
}

console.log('\n[3] 外部改动不会被覆盖（原来是整文件覆盖的 bug）');
{
  const file = tmpFile();
  fs.writeFileSync(file, sample, 'utf8');
  const diary = new Diary(file);
  // 模拟“别的进程刚写进去一条”
  const external = `${sample}- 11-10 [event] 外部进程写入的一条（群623855）\n`;
  fs.writeFileSync(file, external, 'utf8');
  const added = diary.append([
    { date: '2026-11-19', kind: 'fact', text: '我追加的一条', source: '' },
  ]);
  const after = diary.parse();
  ok('追加成功', added === 1, `实际 ${added}`);
  ok('外部那条还在', after.some((e) => e.text === '外部进程写入的一条'), JSON.stringify(after.map((e) => e.text)));
  ok('我的那条也在', after.some((e) => e.text === '我追加的一条'));
}

console.log('\n[4] reinforce 不改条目数');
{
  const file = tmpFile();
  fs.writeFileSync(file, sample, 'utf8');
  const diary = new Diary(file);
  const before = diary.parse().length;
  const targets = diary.parse().filter((e) => e.text === '答应的事');
  const n = diary.reinforce(targets);
  const after = diary.parse();
  ok('强化命中 1 条', n === 1, `实际 ${n}`);
  ok('条目数不变', after.length === before, `${before} -> ${after.length}`);
  ok('权重提升到 0.85', after.find((e) => e.text === '答应的事').weight === 0.85,
    String(after.find((e) => e.text === '答应的事').weight));
  ok('其余条目文本未变', after[0].text === '旧格式流水，没有类型也没有来源', after[0].text);
}

console.log('\n[5] prune 不删新条目');
{
  const file = tmpFile();
  fs.writeFileSync(file, sample, 'utf8');
  const diary = new Diary(file, { forgetAfterDays: 60, forgetThreshold: 0.05 });
  const added = diary.append([{ date: '2026-11-19', kind: 'fact', text: '今天刚记的', source: '' }]);
  const after = diary.parse();
  ok('今天的新条目保留', added === 1 && after.some((e) => e.text === '今天刚记的'), JSON.stringify(after.map((e) => e.text)));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
