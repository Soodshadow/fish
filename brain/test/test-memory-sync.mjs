// 记忆同步的回归测试：用本地 bare 仓库当 remote，不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncMemoryRepo, memoryRepoStatus } from '../core/memory-sync.js';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`); }
}
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-sync-'));
const src = path.join(root, 'src');
const work = path.join(root, 'work');
const remoteDir = path.join(root, 'remote.git');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, 'MEMORY-ARCHIVE.md'), '- 11-21 第一条\n', 'utf8');
fs.writeFileSync(path.join(src, 'messages.jsonl'), '{"t":1}\n', 'utf8');
git(root, ['init', '--bare', '-b', 'main', remoteDir]);

const sources = [
  [path.join(src, 'MEMORY-ARCHIVE.md'), 'MEMORY-ARCHIVE.md'],
  [path.join(src, 'messages.jsonl'), 'messages.jsonl'],
];

console.log('\n[1] 首次同步');
const first = syncMemoryRepo({ workDir: work, sources, remote: remoteDir });
ok('推送成功', first.pushed === true, first.error);
ok('产生了提交', first.committed === true);
ok('远端有 main', git(remoteDir, ['rev-parse', '--verify', 'refs/heads/main']).trim().length > 0);

console.log('\n[2] 无变化时不产生新提交');
const before = git(remoteDir, ['rev-parse', 'refs/heads/main']).trim();
const second = syncMemoryRepo({ workDir: work, sources, remote: remoteDir });
ok('仍然推送成功', second.pushed === true);
ok('没有新提交', second.committed === false, `committed=${second.committed}`);
ok('远端 HEAD 未变', git(remoteDir, ['rev-parse', 'refs/heads/main']).trim() === before);

console.log('\n[3] 文件变化会提交');
fs.writeFileSync(path.join(src, 'messages.jsonl'), '{"t":1}\n{"t":2}\n', 'utf8');
const third = syncMemoryRepo({ workDir: work, sources, remote: remoteDir });
ok('产生新提交', third.committed === true);
ok('远端 HEAD 变了', git(remoteDir, ['rev-parse', 'refs/heads/main']).trim() !== before);

console.log('\n[4] 状态可查');
const status = memoryRepoStatus(work);
ok('能读出最近提交', status.ok === true && /记忆备份/.test(status.last || ''), JSON.stringify(status));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
