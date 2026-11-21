// 阶段 1：把旧记忆导入小鱼大脑（幂等，可重复运行）。
// 输入：
//   D:\fish\memory\shared-chat.jsonl   对话流水
//   D:\fish\memory\MEMORY-BLUEPRINT.md 人设 + 日记（会被拆成两份）
//   D:\fish\memory\MEMORY-ARCHIVE.md   归档
//   D:\fish\qq-bridge\config.json      白名单（只读 allow / ownerQQ）
// 输出：
//   D:\fish\brain\data\...             大脑数据
//   D:\fish\brain\data\import-report.txt

import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../core/store.js';

const SRC = 'D:\\fish\\memory';
const BRIDGE_CONFIG = 'D:\\fish\\qq-bridge\\config.json';
const DATA = 'D:\\fish\\brain\\data';

const report = [];
const log = (line) => { report.push(line); console.log(line); };

const store = new Store(DATA);
store.ensureDirs();
store.load();

// ── 1. 对话流水 ──────────────────────────────────────────────
const chatFile = path.join(SRC, 'shared-chat.jsonl');
const lines = fs.readFileSync(chatFile, 'utf8').split(/\r?\n/).filter(Boolean);
const records = [];
let malformed = 0;
let empty = 0;
for (const line of lines) {
  let raw;
  try { raw = JSON.parse(line); } catch { malformed += 1; continue; }
  const text = String(raw.text ?? '').trim();
  if (!text || !raw.key || !raw.t) { empty += 1; continue; }
  records.push({
    t: Number(raw.t),
    key: String(raw.key),
    platform: 'qq',
    conv: String(raw.key),
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    text,
    source: 'shared-chat',
  });
}
const { added, skipped } = store.appendMessages(records);
log(`[对话] 读入 ${lines.length} 行；有效 ${records.length}；新增 ${added}；重复/已存 ${skipped}；坏行 ${malformed}；空内容 ${empty}`);

// ── 2. 蓝图拆分：人设 / 日记 ─────────────────────────────────
const blueprint = fs.readFileSync(path.join(SRC, 'MEMORY-BLUEPRINT.md'), 'utf8');
const diaryMark = blueprint.search(/^##\s*📔\s*记忆流水/m);
const persona = diaryMark > 0 ? blueprint.slice(0, diaryMark).trimEnd() : blueprint.trimEnd();
const diary = diaryMark > 0 ? blueprint.slice(diaryMark).trimEnd() : '';
fs.writeFileSync(path.join(DATA, 'core', 'persona.md'), `${persona}\n`, 'utf8');
fs.writeFileSync(path.join(DATA, 'core', 'diary.md'), diary ? `${diary}\n` : '', 'utf8');
log(`[蓝图] 总 ${blueprint.length} 字 → 人设 ${persona.length} 字 / 日记 ${diary.length} 字`);
if (diaryMark < 0) log('[蓝图] 警告：没有找到「## 📔 记忆流水」标题，整份当作人设');

// ── 3. 归档 ─────────────────────────────────────────────────
const archive = fs.readFileSync(path.join(SRC, 'MEMORY-ARCHIVE.md'), 'utf8');
fs.writeFileSync(path.join(DATA, 'archive', 'legacy-archive.md'), archive, 'utf8');
const archiveLines = archive.split(/\r?\n/).filter((l) => l.trim().startsWith('- '));
log(`[归档] ${archive.length} 字；条目行 ${archiveLines.length} 条`);

// ── 4. 白名单 → 人物 / 会话 ─────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf8'));
const privateIds = (cfg.allow?.private ?? []).map(String);
const groupIds = (cfg.allow?.groups ?? []).map(String);
for (const id of privateIds) {
  store.upsertPerson(`qq:${id}`, { platform: 'qq', kind: 'private', display: id === String(cfg.ownerQQ) ? '主人' : '' });
  store.upsertConversation(`private:${id}`, { title: id === String(cfg.ownerQQ) ? '主人私聊' : '' });
}
for (const id of groupIds) {
  store.upsertConversation(`group:${id}`, { title: '' });
}
// 消息里出现过、但不在白名单的会话也建目录（只建目录，不授权）
let extra = 0;
for (const m of store.messages) {
  if (!store.conversations[m.key]) {
    store.upsertConversation(m.key, {});
    extra += 1;
  }
}
log(`[人物/会话] 私聊 ${privateIds.length} 个、群 ${groupIds.length} 个；流水里额外发现 ${extra} 个会话`);

// ── 5. 统计 ─────────────────────────────────────────────────
const stats = store.stats();
const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
log('');
log(`[总计] 消息 ${stats.messages} 条；记忆条目 ${stats.memories} 条；人物 ${stats.people}；会话 ${stats.conversations}`);
log('[分布]');
for (const row of stats.byConversation) {
  log(`  ${row.key}  ${String(row.count).padStart(4)} 条  ${fmt(row.first)} → ${fmt(row.last)}`);
}
log('');
log('[说明] 旧流水在写入时就已按 500 字截断、并去掉了 emoji；导入无法恢复这两部分。');
log(`[说明] 重复运行本脚本不会产生重复数据。`);

fs.writeFileSync(path.join(DATA, 'import-report.txt'), `${report.join('\n')}\n`, 'utf8');
console.log(`\n报告已写入 ${path.join(DATA, 'import-report.txt')}`);
