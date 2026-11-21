// 记忆文件（MEMORY-ARCHIVE.md）：按天分节，每节若干条记忆。
// 新增条目格式：- 11-18 [fact] 一句结论（来源）
// 旧条目兼容：  - 10-23 以前流水……
// 权重：默认按时间衰减（半衰期 30 天）；也可在行尾写 ｜w=0.8 手动指定。
//
// 写入保护（2026-11-19）：
//   历史上出现过「整文件被外部覆盖，39 条产出只剩 2 条」。这里用乐观锁 +
//   防缩水校验：读-改-写之间若文件被别的进程/手工改过，就重读重做；合并结果
//   条目数比原文件少（非 prune 场景）则拒绝写入并留日志。
import fs from 'node:fs';
import path from 'node:path';

const SECTION = /^###\s*(\d{4}-\d{2}-\d{2})\s*$/;
const BULLET = /^-\s*(?:(\d{2}-\d{2}|\d{2}:\d{2})\s*)?(?:\[([^\]]+)\]\s*)?(.+)$/;
const WEIGHT_TAG = /[｜|]\s*w\s*=\s*([0-9.]+)/i;
const REFRESH_TAG = /[｜|]\s*r\s*=\s*(\d{4}-\d{2}-\d{2})/i;

const MAX_ATTEMPTS = 3;

/** 只数“条目行”，用来判断写回是否缩水。 */
function countBullets(content) {
  let date = '';
  let count = 0;
  for (const line of String(content ?? '').split(/\r?\n/)) {
    if (SECTION.test(line)) { date = line; continue; }
    if (date && BULLET.test(line)) count += 1;
  }
  return count;
}

export class Diary {
  constructor(file, options = {}) {
    this.file = file;
    this.halfLifeDays = Number(options.halfLifeDays ?? 30);
    this.forgetThreshold = Number(options.forgetThreshold ?? 0.05);
    this.forgetAfterDays = Number(options.forgetAfterDays ?? 60);
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this._warned = new Set();
  }

  read() {
    try { return fs.readFileSync(this.file, 'utf8'); } catch { return ''; }
  }

  /** 文件指纹：用于「读完之后有没有被别的进程改过」的判断。 */
  stamp() {
    try {
      const st = fs.statSync(this.file);
      return `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return 'missing';
    }
  }

  writeAtomic(content) {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch {}
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 解析成 [{date, time, kind, text, source, weight}]。 */
  parse() {
    const lines = this.read().split(/\r?\n/);
    const entries = [];
    let date = '';
    for (const line of lines) {
      const section = line.match(SECTION);
      if (section) { date = section[1]; continue; }
      const entry = line.match(BULLET);
      if (!entry || !date) continue;
      let text = entry[3].trim();
      let source = '';
      let manualWeight = null;
      let refreshed = '';
      const weightTag = text.match(WEIGHT_TAG);
      if (weightTag) {
        manualWeight = Number(weightTag[1]);
        text = text.replace(WEIGHT_TAG, '').trim();
      }
      const refreshTag = text.match(REFRESH_TAG);
      if (refreshTag) {
        refreshed = refreshTag[1];
        text = text.replace(REFRESH_TAG, '').trim();
      }
      const tagged = text.match(/^(.*)（([^（）]+)）$/);
      if (tagged) { text = tagged[1].trim(); source = tagged[2].trim(); }
      entries.push({
        date,
        time: entry[1] && entry[1].includes(':') ? entry[1] : '',
        kind: entry[2] || 'memory',
        text,
        source,
        refreshed,
        weight: manualWeight,
      });
    }
    return entries;
  }

  /** 时间衰减权重：e^(-天数/半衰期)；手动 w 优先；被回忆过则从回忆日重新计时。 */
  weightOf(entry, now = Date.now()) {
    const base = typeof entry.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 1;
    const baseDate = entry.refreshed && entry.refreshed > entry.date ? entry.refreshed : entry.date;
    const t = Date.parse(`${baseDate}T${entry.time || '12:00'}:00+08:00`);
    if (!Number.isFinite(t)) return base * 0.5;
    const days = Math.max(0, (now - t) / 86400000);
    return base * Math.exp(-days / this.halfLifeDays);
  }

  /** 被检索到 = 想起一次：权重 +0.05（最高 1.0），并记录回忆日期。 */
  reinforce(entries) {
    if (!entries.length) return 0;
    const today = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const targets = new Map(entries.map((entry) => [entry.text, entry]));

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const before = this.stamp();
      const content = this.read();
      if (!content) return 0;
      let changed = 0;
      const out = content.split(/\r?\n/).map((line) => {
        const bullet = line.match(BULLET);
        if (!bullet) return line;
        let body = bullet[3].trim();
        let weight = null;
        let refreshed = '';
        const weightTag = body.match(WEIGHT_TAG);
        if (weightTag) { weight = Number(weightTag[1]); body = body.replace(WEIGHT_TAG, '').trim(); }
        const refreshTag = body.match(REFRESH_TAG);
        if (refreshTag) { refreshed = refreshTag[1]; body = body.replace(REFRESH_TAG, '').trim(); }
        let text = body;
        let source = '';
        const tagged = text.match(/^(.*)（([^（）]+)）$/);
        if (tagged) { text = tagged[1].trim(); source = tagged[2].trim(); }
        const hit = targets.get(text);
        if (!hit) return line;
        const base = weight ?? this.weightOf({ date: hit.date, refreshed, text });
        const next = Math.min(1, Math.round((base + 0.05) * 100) / 100);
        const kind = bullet[2] ? `[${bullet[2]}] ` : '';
        const datePart = bullet[1] ? `${bullet[1]} ` : '';
        const sourcePart = source ? `（${source}）` : '';
        changed += 1;
        return `- ${datePart}${kind}${text}${sourcePart}｜w=${next}｜r=${today}`;
      });
      if (!changed) return 0;
      // 读完到写之间被改过：重读重做，避免覆盖别人的新条目
      if (this.stamp() !== before) {
        this.log(`diary reinforce retry ${attempt + 1} (file changed underneath)`);
        continue;
      }
      if (countBullets(out.join('\n')) !== countBullets(content)) {
        this.log('diary reinforce aborted: bullet count would change');
        return 0;
      }
      this.writeAtomic(out.join('\n'));
      return changed;
    }
    this.log('diary reinforce gave up after retries');
    return 0;
  }

  /** 追加条目，按日期插入；同文本去重；随后清理淡忘条目。 */
  append(records) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const before = this.stamp();
      const content0 = this.read();
      const existing = new Set(this.parse().map((entry) => entry.text));
      const byDate = new Map();
      for (const record of records) {
        const text = String(record.text || '').trim();
        if (!text || existing.has(text)) continue;
        existing.add(text);
        const list = byDate.get(record.date) || [];
        list.push({ ...record, text });
        byDate.set(record.date, list);
      }
      if (!byDate.size) return 0;

      let content = content0;
      let added = 0;
      for (const [date, list] of byDate) {
        const header = `### ${date}`;
        let at = content.indexOf(header);
        if (at < 0) {
          content += `${content.endsWith('\n') ? '' : '\n'}\n${header}\n\n`;
          at = content.indexOf(header);
        }
        const nextSection = content.indexOf('\n### ', at + header.length);
        const insertAt = nextSection < 0 ? content.length : nextSection;
        const block = `${list.map((record) => {
          const shortDate = date.slice(5);
          const kind = record.kind ? `[${record.kind}] ` : '';
          const source = record.source ? `（${record.source}）` : '';
          const weight = Number.isFinite(record.weight) ? `｜w=${record.weight}` : '';
          return `- ${shortDate} ${kind}${record.text}${source}${weight}`;
        }).join('\n')}\n`;
        const prefix = insertAt === content.length && !content.endsWith('\n') ? '\n' : '';
        content = `${content.slice(0, insertAt)}${prefix}${block}${content.slice(insertAt)}`;
        added += list.length;
      }

      // 防缩水：合并阶段不允许条目变少（prune 是之后单独一步）
      if (countBullets(content) < countBullets(content0)) {
        this.log(`diary append aborted: bullets would shrink (${countBullets(content0)} -> ${countBullets(content)})`);
        return 0;
      }
      if (this.stamp() !== before) {
        this.log(`diary append retry ${attempt + 1} (file changed underneath)`);
        continue;
      }

      const pruned = this.pruneFrom(content);
      // prune 之后也不该把这一轮新增的条目丢掉
      if (countBullets(pruned) < countBullets(content0)) {
        this.log('diary append: prune result smaller than original, keeping pre-prune content');
        this.writeAtomic(content);
        return added;
      }
      this.writeAtomic(pruned);
      return added;
    }
    this.log('diary append gave up after retries');
    return 0;
  }

  /** 删掉“时间很久且权重低于阈值”的条目；返回清理后的全文。 */
  pruneFrom(content) {
    const now = Date.now();
    const entries = [];
    let date = '';
    for (const line of content.split(/\r?\n/)) {
      const section = line.match(SECTION);
      if (section) { date = section[1]; continue; }
      const entry = line.match(BULLET);
      if (!entry || !date) continue;
      let text = entry[3].trim().replace(WEIGHT_TAG, '').replace(REFRESH_TAG, '').trim();
      const tagged = text.match(/^(.*)（([^（）]+)）$/);
      if (tagged) text = tagged[1].trim();
      const weight = this.weightOf({
        date,
        time: entry[1] && entry[1].includes(':') ? entry[1] : '',
        text,
        weight: (() => {
          const m = entry[3].match(WEIGHT_TAG);
          return m ? Number(m[1]) : null;
        })(),
        refreshed: (() => {
          const m = entry[3].match(REFRESH_TAG);
          return m ? m[1] : '';
        })(),
      }, now);
      const refreshMatch = entry[3].match(REFRESH_TAG);
      const baseDate = refreshMatch && refreshMatch[1] > date ? refreshMatch[1] : date;
      const ageDays = (now - Date.parse(`${baseDate}T12:00:00+08:00`)) / 86400000;
      if (ageDays > this.forgetAfterDays && weight < this.forgetThreshold) {
        entries.push(text);
      }
    }
    if (!entries.length) return content;
    const drop = new Set(entries);
    const kept = [];
    date = '';
    for (const line of content.split(/\r?\n/)) {
      const section = line.match(SECTION);
      if (section) { date = section[1]; kept.push(line); continue; }
      const entry = line.match(BULLET);
      if (entry && date) {
        let text = entry[3].trim().replace(WEIGHT_TAG, '').replace(REFRESH_TAG, '').trim();
        const tagged = text.match(/^(.*)（([^（）]+)）$/);
        if (tagged) text = tagged[1].trim();
        if (drop.has(text)) continue;
      }
      kept.push(line);
    }
    return `${kept.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  }
}
