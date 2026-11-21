// 检查她现在的会话里装的是哪一版提示词。
// 用法：node <repo>/brain/scripts/check-preset.mjs
// 会话文件是分帧压缩的 jsonl，这里按 zstd 帧切分逐帧解压，再找旧 preset 的痕迹。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// 会话目录名 = cwd 里的 : \ / 换成 - ：C:\Users\Lenovo -> --C-Users-Lenovo--
function sessionFolderOf(dir) {
  const normalized = dir.replace(/:/g, '').replace(/[\\/]/g, '-');
  return `--${normalized}--`;
}

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.dsh', 'sessions', sessionFolderOf(HOME));

const OLD_MARKERS = [
  { key: 'qq_wait_for_messages', why: '教她调不存在的工具' },
  { key: '数组两个元素', why: '分条协议和桥接（按换行）不一致' },
  { key: 'activeTopic', why: '旧状态机字段，桥接里没有' },
];
const NEW_MARKERS = [
  { key: '不用急着追问', why: '新版的「等下文」写法' },
];

function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (!starts.length) {
    try { return zlib.zstdDecompressSync(buf).toString('utf8'); } catch { return ''; }
  }
  let out = '';
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.slice(start, end)).toString('utf8'); } catch { /* 跳过坏帧 */ }
  }
  return out;
}

function newestSession() {
  let best = null;
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith('session-')) continue;
    const file = path.join(SESSIONS_DIR, name, 'session.v4.jsonl.zstd');
    try {
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { name, file, mtimeMs: stat.mtimeMs };
    } catch { /* 没有会话文件 */ }
  }
  return best;
}

const session = newestSession();
if (!session) {
  console.log(`没找到会话文件：${SESSIONS_DIR}`);
  process.exit(0);
}

const text = decodeSession(session.file);
console.log(`会话：${session.name}`);
console.log(`最近写入：${new Date(session.mtimeMs).toLocaleString('zh-CN', { hour12: false })}`);
console.log(`解压后：${text.length} 字符\n`);

if (!text) {
  console.log('解压失败，无法判断。');
  process.exit(1);
}

const stale = OLD_MARKERS.filter((marker) => text.includes(marker.key));
const fresh = NEW_MARKERS.filter((marker) => text.includes(marker.key));

console.log('旧提示词痕迹：');
if (!stale.length) console.log('  （无）');
for (const marker of stale) console.log(`  ✗ ${marker.key} —— ${marker.why}`);
console.log('\n新提示词痕迹：');
if (!fresh.length) console.log('  （无）');
for (const marker of fresh) console.log(`  ✓ ${marker.key} —— ${marker.why}`);

console.log('');
if (stale.length) {
  console.log('结论：这个会话还是旧提示词。');
  console.log('处理：清掉 brain/state/s2-sessions.json 的映射（或直接删文件），重启 DSH，');
  console.log('      下一条消息会用新 preset 重建会话；重建时会自动补最近对话和最近 3 天记忆。');
} else {
  console.log('结论：没有发现旧提示词痕迹。');
}
process.exit(stale.length ? 2 : 0);
