// 每日记忆整理：晚上回看一整天的对话，像人一样把一天压成几件「事情」。
// 取代以前「说完话 3 分钟提炼 20 条」的碎片化做法。
import fs from 'node:fs';

const KINDS = new Set(['event', 'fact', 'promise', 'emotion', 'impression', 'lesson']);

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

/** 从模型输出里抠出 JSON 数组（可能裹在代码块里）。 */
function parseItems(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => ({
      kind: KINDS.has(String(item?.kind)) ? String(item.kind) : 'event',
      text: String(item?.text || '').trim(),
      weight: Math.min(1, Math.max(0.1, Number(item?.weight) || 0.5)),
    }))
    .filter((item) => item.text.length >= 6);
}

export class MemoryDigest {
  constructor({ ctx, controller, store, diary, workspace, log, stateFile, hour = 23, maxItems = 6 }) {
    this.ctx = ctx;
    this.controller = controller;
    this.store = store;
    this.diary = diary;
    this.workspace = workspace;
    this.log = log;
    this.stateFile = stateFile;
    this.hour = hour;
    this.maxItems = maxItems;
    this.state = readState(stateFile);
    this.sessionId = this.state.digestSession || null;
    this.running = false;
  }

  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    fs.mkdirSync(this.workspace, { recursive: true });
    const created = await this.controller.create({ cwd: this.workspace });
    this.sessionId = created.sessionId;
    this.state.digestSession = this.sessionId;
    writeState(this.stateFile, this.state);
    this.log(`memory digest session created ${this.sessionId}`);
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
      }, 240000);
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
        requestId: `digest-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
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

  /** 当天她参与的全部对话；时间早的在前。 */
  collectDayMaterial(day) {
    const start = new Date(`${day}T00:00:00`).getTime();
    const messages = Array.isArray(this.store?.messages) ? this.store.messages : [];
    return messages
      .filter((m) => Number(m.t) >= start && String(m.text || '').trim())
      .sort((a, b) => a.t - b.t)
      .map((m) => {
        const d = new Date(m.t);
        const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const who = m.role === 'assistant' ? '你' : '对方';
        const place = String(m.key || '').startsWith('group:')
          ? `群${String(m.key).split(':')[1]}`
          : '私聊';
        return `[${stamp}][${place}] ${who}：${String(m.text).slice(0, 200)}`;
      })
      .join('\n');
  }

  buildPrompt(material) {
    return [
      '这是你今天经历的全部对话：',
      '',
      material.slice(-9000),
      '',
      '晚上回想一下：今天发生了什么值得记住的事？',
      '像人一样把一天压成几件「事情」—— 不是逐条记录，也不是复述原话。',
      '每条写清楚：谁、什么时候、发生了什么、为什么值得记；有前因后果就一带说上。',
      '值得记的是：约定、关系变化、重要的情绪节点、正在发生的事、学到的教训、对某人的新认识。',
      '不值得记的是：寒暄、天气、一次性的小问答、已经说过的常识。',
      '',
      '只输出 JSON 数组，不要解释、不要代码块：',
      '[{"kind":"event|fact|promise|emotion|impression|lesson","text":"一句话把事情说清楚","weight":0.6}]',
      `最多 ${this.maxItems} 条；weight 0.2~1.0（约定/关系变化/强烈情绪 0.8+，普通事情 0.5，小事 0.2~0.3）。`,
      '今天没什么可记的就输出 []。',
    ].join('\n');
  }

  /** 到点整理一次；失败不标记，明天/下一小时会重试。 */
  async maybeDigest(now = new Date()) {
    if (this.running) return;
    if (now.getHours() < this.hour) return;
    const day = todayStamp(now);
    if (this.state.lastDay === day) return;
    const material = this.collectDayMaterial(day);
    if (!material.trim()) {
      this.state.lastDay = day;
      writeState(this.stateFile, this.state);
      return;
    }

    this.running = true;
    try {
      const sessionId = await this.ensureSession();
      const text = await this.collect(sessionId, this.buildPrompt(material));
      const items = parseItems(text);
      if (!items.length) {
        this.state.lastDay = day;
        this.state.lastCount = 0;
        writeState(this.stateFile, this.state);
        this.log(`memory digest ${day}: nothing worth keeping`);
        return;
      }
      const added = this.diary.append(items.map((item) => ({
        date: day,
        kind: item.kind,
        text: item.text,
        weight: item.weight,
        source: '',
      })));
      this.state.lastDay = day;
      this.state.lastCount = added;
      writeState(this.stateFile, this.state);
      this.log(`memory digest ${day}: ${added} item(s) from ${material.split('\n').length} msgs`);
    } catch (error) {
      this.log(`memory digest failed: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
  }
}
