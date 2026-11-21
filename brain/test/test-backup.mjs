// 记忆备份的回归测试：只写临时目录，不碰真实备份。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupMemory, listBackups } from '../core/backup.js';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-backup-'));
const src = path.join(root, 'src');
const dir = path.join(root, 'backups');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, 'MEMORY-ARCHIVE.md'), '- 11-21 一条记忆\n', 'utf8');
fs.writeFileSync(path.join(src, 'messages.jsonl'), '{"a":1}\n', 'utf8');

console.log('\n[1] 首次备份');
const sources = [path.join(src, 'MEMORY-ARCHIVE.md'), path.join(src, 'messages.jsonl'), path.join(src, 'missing.json')];
const first = backupMemory({ sources, dir, keep: 2 });
ok('复制了存在的两个文件', first.copied === 2, `实际 ${first.copied}`);
ok('不是跳过', first.skipped === false);
ok('目录里有文件', fs.readdirSync(first.dir).length === 2, JSON.stringify(fs.readdirSync(first.dir)));

console.log('\n[2] 同一天再跑不重复');
const second = backupMemory({ sources, dir, keep: 2 });
ok('第二次跳过', second.skipped === true);
ok('目录还是只有一个', listBackups(dir).length === 1, JSON.stringify(listBackups(dir)));

console.log('\n[3] 保留份数');
// 手工造几个旧快照，验证只留最近 keep 份
for (const stamp of ['20260101', '20260102', '20260103']) {
  fs.mkdirSync(path.join(dir, `mem-${stamp}`), { recursive: true });
}
backupMemory({ sources: [path.join(src, 'missing.json')], dir, keep: 2 });
const list = listBackups(dir);
ok('只留最近 keep 份', list.length <= 2, JSON.stringify(list));
ok('保留的是最新的', list.every((name) => name >= 'mem-20260103'), JSON.stringify(list));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
