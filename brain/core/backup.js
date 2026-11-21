// 记忆备份：把「她是谁」「她记得什么」「她跟谁聊过」打包到本地备份目录。
// 不联网、不上传，只防这台电脑出问题。
import fs from 'node:fs';
import path from 'node:path';

function dayStamp(date = new Date()) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 每天只备份一次（目录名 mem-YYYYMMDD 已存在就跳过），并只保留最近 keep 份。
 * @returns {{copied:number, dir:string, skipped:boolean}}
 */
export function backupMemory({ sources = [], dir, keep = 30, log = () => {} }) {
  const stamp = dayStamp();
  const target = path.join(dir, `mem-${stamp}`);
  const already = fs.existsSync(target);
  let copied = 0;
  const missing = [];

  if (!already) {
    fs.mkdirSync(target, { recursive: true });
    for (const source of sources) {
      try {
        if (!source || !fs.existsSync(source)) { missing.push(source); continue; }
        fs.copyFileSync(source, path.join(target, path.basename(source)));
        copied += 1;
      } catch (error) {
        missing.push(`${source} (${error?.message ?? error})`);
      }
    }
  }

  // 只留最近 keep 份：即使今天已经备份过也顺手清一次
  try {
    const existing = fs.readdirSync(dir).filter((name) => /^mem-\d{8}$/.test(name)).sort();
    const drop = existing.slice(0, Math.max(0, existing.length - keep));
    for (const name of drop) {
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch {}
    }
    if (drop.length) log(`memory backup pruned ${drop.length} old snapshot(s)`);
  } catch {}

  if (missing.length) log(`memory backup skipped ${missing.length} missing source(s)`);
  return { copied, dir: target, skipped: already };
}

/** 供脚本/测试用：列出已有备份。 */
export function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^mem-\d{8}$/.test(name)).sort();
  } catch {
    return [];
  }
}
