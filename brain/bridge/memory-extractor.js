// 记忆抽取：把原始对话提炼成结构化记忆条目（事实/约定/情绪/印象/事件）。
// 现在只有一条路径：一段对话结束后由 judge() 判断值不值得记。
// 旧的 extractKey()/run() 全量扫描已删除（没有任何调用点，且和 judge 重复）。
import fs from 'node:fs';

const KINDS = new Set(['fact', 'promise', 'emotion', 'impression', 'event']);

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { keys: {} }; }
}

function writeState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class MemoryExtractor {
  constructor({ ctx, controller, store, diary, workspace, log, stateFile }) {
    this.ctx = ctx;
    this.controller = controller;
    this.store = store;
    this.diary = diary;
    this.workspace = workspace;
    this.log = log;
    this.stateFile = stateFile;
    this.state = readState(stateFile);
    this.sessionId = null;
    this.running = false;
  }

  async ensureSession() {
    if (!this.sessionId && this.state.memorySession) {
      this.sessionId = this.state.memorySession;
    }
    if (this.sessionId) {
      return this.sessionId;
    }
    fs.mkdirSync(this.workspace, { recursive: true });
    const created = await this.controller.create({ cwd: this.workspace });
    this.sessionId = created.sessionId;
    this.state.memorySession = this.sessionId;
    writeState(this.stateFile, this.state);
    this.log(`memory session created ${this.sessionId}`);
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
        requestId: `mem-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
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

  lastT(key) {
    return this.state.keys?.[key] ?? 0;
  }

  /** 一段对话结束后判断：有没有值得长期记住的事，以及这段在聊什么。 */
  async judge(key, transcript, upTo) {
    if (!transcript.trim()) return 0;
    const prompt = [
      '这是一段刚发生的对话。判断有没有值得长期记住的事，像人一样只记结论。',
      '只输出 JSON 数组，不要解释、不要代码块：',
      '[{"kind":"fact|promise|emotion|impression|event","text":"一句结论：谁、发生了什么、为什么值得记","weight":0.8}]',
      'weight 是这条记忆的重要程度（0.2~1.0）：约定/关系变化/强烈情绪给 0.8~1.0；',
      '普通事实/喜好给 0.4~0.7；随口一句、过几天就忘的给 0.2~0.3。',
      '规则：记忆只记会影响以后相处的事（约定、事实、喜好、关系变化、情绪节点、重要事件）；',
      '不记日常寒暄、不记流水账、不记原话；没有值得记的就输出 []。最多 3 条。',
      '例外：如果这段里有人主动找过她（@她、拍她、私聊她、点名问她），要记成一条 event，',
      '写清楚「谁、在哪个群、什么时候找她说了什么」，哪怕内容本身很普通 —— 以后被问「谁找过我」要靠它。',
      '',
      `对话（会话 ${key}）：`,
      transcript,
    ].join('\n');

    let sessionId = await this.ensureSession();
    let reply;
    try {
      reply = await this.collect(sessionId, prompt);
    } catch (error) {
      if (!/not[- ]?found|ApiSessionNotFound/i.test(String(error?.message ?? error))) throw error;
      this.sessionId = null;
      delete this.state.memorySession;
      writeState(this.stateFile, this.state);
      sessionId = await this.ensureSession();
      reply = await this.collect(sessionId, prompt);
    }

    let items = [];
    const start = reply.indexOf('[');
    const end = reply.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(reply.slice(start, end + 1));
        if (Array.isArray(parsed)) items = parsed;
      } catch { /* ignore */ }
    }

    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const id = String(key).split(':')[1] || '';
    const source = String(key).startsWith('group:') ? `群${id.slice(-6)}` : `私聊${id.slice(-6)}`;

    const records = [];
    for (const item of items.slice(0, 3)) {
      const kind = KINDS.has(item?.kind) ? item.kind : 'fact';
      const text = String(item?.text || '').trim().slice(0, 200);
      if (!text) continue;
      const rawWeight = Number(item?.weight);
      const weight = Number.isFinite(rawWeight) ? Math.min(1, Math.max(0.2, rawWeight)) : 0.6;
      records.push({ date, time, kind, text, source, weight });
    }
    const added = this.diary.append(records);

    if (upTo) {
      this.state.keys = { ...(this.state.keys || {}), [key]: upTo };
      this.state.lastRunAt = Date.now();
      writeState(this.stateFile, this.state);
    }
    return added;
  }
}
