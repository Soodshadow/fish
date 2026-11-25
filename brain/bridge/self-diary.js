// 她的日记：每天由她自己决定写不写、写什么。
// 桥接只负责：到点问一句、把当天素材给她、把写下来的记到「日记本」里。
// 日记本是一个固定文件（memory/diary/日记.md），按日期分节往下写。
import fs from 'node:fs';
import path from 'node:path';

const SKIP_MARK = /^\[(?:\s*(?:SKIP|不写|不写了|算了|今天不写)\s*)\]/i;
const SECTION_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;

function todayStamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeState(file, state) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {}
}

/** 把日记本拆成 日期 -> 正文。 */
function splitSections(text) {
  const marks = [];
  SECTION_RE.lastIndex = 0;
  let hit;
  while ((hit = SECTION_RE.exec(text)) !== null) {
    marks.push({ day: hit[1], start: SECTION_RE.lastIndex, headerStart: hit.index });
  }
  const out = new Map();
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].headerStart : text.length;
    out.set(marks[i].day, text.slice(marks[i].start, end).trim());
  }
  return out;
}

export class SelfDiary {
  constructor({ ctx, controller, store, workspace, log, stateFile, dir, bookName = '日记.md', hour = 22 }) {
    this.ctx = ctx;
    this.controller = controller;
    this.store = store;
    this.workspace = workspace;
    this.log = log;
    this.stateFile = stateFile;
    this.dir = dir;
    this.file = path.join(dir, bookName);
    this.hour = hour;
    this.state = readState(stateFile);
    this.sessionId = this.state.diarySession || null;
    this.running = false;
  }

  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    fs.mkdirSync(this.workspace, { recursive: true });
    const created = await this.controller.create({ cwd: this.workspace });
    this.sessionId = created.sessionId;
    this.state.diarySession = this.sessionId;
    writeState(this.stateFile, this.state);
    this.log(`self diary session created ${this.sessionId}`);
    return this.sessionId;
  }

  collect(sessionId, promptText) {
    return new Promise((resolve, reject) => {
      let text = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        resolve(text);
      }, 180000);
      const off = this.ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return;
        if (event.type === 'assistant/message') {
          for (const block of event.data?.message?.content ?? []) {
            if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
          }
        }
        if (event.type === 'turn/end') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off();
          resolve(text);
        }
      }, { global: true });

      this.controller.prompt({
        sessionId,
        mode: 'queue',
        requestId: `diary-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        content: [{ type: 'text', text: promptText }],
      }, new AbortController().signal).catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        reject(error);
      });
    });
  }

  /** 当天她参与的对话（她不在场的群聊本来就没入库）。 */
  collectDayMaterial(day) {
    const start = new Date(`${day}T00:00:00`).getTime();
    const messages = Array.isArray(this.store?.messages) ? this.store.messages : [];
    const rows = messages.filter((m) => Number(m.t) >= start).slice(-100);
    return rows.map((m) => {
      const d = new Date(m.t);
      const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const who = m.role === 'assistant' ? '你' : '对方';
      const place = String(m.key || '').startsWith('group:') ? '群' : '私聊';
      return `[${stamp}][${place}] ${who}：${String(m.text || '').slice(0, 160)}`;
    }).join('\n');
  }

  /** 往日记本里写：同一天重写会替换当天那节，不重复。 */
  append(day, body) {
    fs.mkdirSync(this.dir, { recursive: true });
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch {}
    const sections = splitSections(text);
    sections.set(day, String(body || '').trim());
    const ordered = [...sections.entries()]
      .filter(([, value]) => value)
      .sort((a, b) => a[0].localeCompare(b[0]));
    fs.writeFileSync(this.file, `${ordered.map(([d, value]) => `## ${d}\n\n${value}\n`).join('\n')}\n`, 'utf8');
  }

  /** 最近 n 篇（给提示词注入）。 */
  recent(n = 3) {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return ''; }
    const sections = splitSections(text);
    return [...sections.entries()]
      .filter(([, value]) => value)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-n)
      .map(([day, value]) => `${day}：${value}`)
      .join('\n\n');
  }

  /** 到点就问一句；她自己决定写不写。 */
  async maybeWrite(now = new Date()) {
    if (this.running) return;
    if (now.getHours() < this.hour) return;
    const day = todayStamp(now);
    if (this.state.lastDay === day) return;
    this.running = true;
    try {
      const material = this.collectDayMaterial(day);
      if (!material.trim()) {
        this.state.lastDay = day;
        writeState(this.stateFile, this.state);
        return;
      }
      const prompt = [
        '这是你今天经历的事（你和别人的对话节选）：',
        '',
        material.slice(-3500),
        '',
        '现在是晚上。你想写点什么吗？日记、想法、想对谁说的话都行。',
        '写不写、写多少、写什么，都由你决定。',
        '想写就直接写正文（不要标题、不要日期，系统会补）；不想写就只回复 [SKIP]。',
      ].join('\n');
      const sessionId = await this.ensureSession();
      const text = String(await this.collect(sessionId, prompt)).trim();
      if (!text || SKIP_MARK.test(text)) {
        this.state.lastDay = day;
        writeState(this.stateFile, this.state);
        this.log(`self diary ${day}: skipped by her`);
        return;
      }
      this.append(day, text);
      this.state.lastDay = day;
      writeState(this.stateFile, this.state);
      this.log(`self diary ${day}: wrote ${text.length} chars`);
    } catch (error) {
      this.log(`self diary failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
  }
}
