// S2 桥接插件（桌面端进程内）
// - 私聊（主人）+ 群聊（白名单群，@ 或叫名字才回）
// - QQ 会话 key ↔ DSH sessionId 映射（持久化）
// - 多轮、人设 preset、brain 记忆注入与写回
// - 不声明 inject：自己轮询 sessionController，避免服务晚到导致插件永远不激活

import fs from 'node:fs';
import path from 'node:path';
import WebSocketImpl from 'ws';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { Store } from '../core/store.js';
import { syncMemoryRepo, memoryRepoStatus } from '../core/memory-sync.js';
import { StickerStore } from './stickers.js';
import { Diary } from './diary.js';
import { MemoryExtractor } from './memory-extractor.js';

export const name = 'fish-bridge-s2';

const LOG_FILE = process.env.FISH_S2_LOG || 'D:\\fish\\brain\\state\\s2.log';
const STATE_FILE = process.env.FISH_S2_STATE || 'D:\\fish\\brain\\state\\s2-sessions.json';
const DATA_DIR = process.env.FISH_S2_DATA || 'D:\\fish\\brain\\data';
const MEMORY_FILE = process.env.FISH_S2_MEMORY || 'D:\\fish\\memory\\MEMORY-ARCHIVE.md';
const CONFIG_FILE = process.env.FISH_S2_CONFIG || 'D:\\fish\\brain\\config.json';
const SNOWLUMA_CONFIG_DIR = process.env.FISH_S2_SNOWLUMA_DIR || 'D:\\fish\\snow\\config';
const SNOWLUMA_ONEBOT = process.env.FISH_S2_ONEBOT || '';
const BRIDGE_CONFIG = 'D:\\fish\\qq-bridge\\config.json';
const PRESET = 'fish-chat';
const PRESET_VERSION = 'fish-chat:9';
const WORKSPACE = 'D:\\fish\\brain\\bridge-workspace';
// 聊天会话的工作目录放在用户目录，这样桌面/文档都在可写范围内
const SESSION_CWD = 'C:\\Users\\Lenovo';
// 真实值由 bootstrap 从 config.json 的 ownerQQ / selfQQ 读；代码里不留任何 QQ 号
let OWNER_QQ = String(process.env.FISH_OWNER_QQ || '');
let SELF_QQ = String(process.env.FISH_SELF_QQ || '');
const WAKE_WORDS = ['小鲸鱼', '鲸鱼', '大肥鱼', '蓝莓', '小鱼', '丫头', '鱼鱼'];
const MARK_FILE = 'D:\\fish\\brain\\state\\s2-import.log';

// 日志轮转：单个文件超过 8MB 就滚到 .1（保留一份），避免无限增长
const LOG_MAX_BYTES = 8 * 1024 * 1024;
let logSize = -1;

// 模块被 import 的痕迹：用来区分“没加载”和“加载了但没 apply”
try {
  fs.mkdirSync(path.dirname(MARK_FILE), { recursive: true });
  fs.appendFileSync(MARK_FILE, `[${new Date().toISOString()}] module imported\n`, 'utf8');
} catch {}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (logSize < 0) {
      try { logSize = fs.statSync(LOG_FILE).size; } catch { logSize = 0; }
    }
    fs.appendFileSync(LOG_FILE, `${text}\n`, 'utf8');
    logSize += Buffer.byteLength(text) + 1;
    if (logSize > LOG_MAX_BYTES) {
      // 只保留一份历史，避免磁盘被日志吃满
      try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
      logSize = 0;
    }
  } catch {}
  console.log(`[s2] ${line}`);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { sessions: {} }; }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    log(`state write failed: ${error?.message ?? error}`);
  }
}

/** 自动找 SnowLuma 的 onebot 配置（文件名带 QQ 号，所以不写死在代码里）。 */
function resolveOnebotFile() {
  if (SNOWLUMA_ONEBOT) return SNOWLUMA_ONEBOT;
  try {
    const files = fs.readdirSync(SNOWLUMA_CONFIG_DIR)
      .filter((name) => /^onebot_\d+\.json$/.test(name))
      .sort();
    if (!files.length) return '';
    // 优先用她自己 QQ 对应的那份
    const preferred = SELF_QQ ? `onebot_${SELF_QQ}.json` : '';
    if (preferred && files.includes(preferred)) return path.join(SNOWLUMA_CONFIG_DIR, preferred);
    return path.join(SNOWLUMA_CONFIG_DIR, files[0]);
  } catch {}
  return '';
}

function readSnowLumaEndpoint() {
  if (process.env.FISH_S2_WS) {
    return { url: process.env.FISH_S2_WS, accessToken: process.env.FISH_S2_TOKEN || '' };
  }
  const file = resolveOnebotFile();
  if (!file) {
    throw new Error(`没有找到 SnowLuma 的 onebot 配置（${SNOWLUMA_CONFIG_DIR}/onebot_<QQ>.json），可以设 FISH_S2_ONEBOT 指定`);
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ws = doc?.networks?.wsServers?.[0] ?? {};
  return {
    url: `ws://${ws.host || '127.0.0.1'}:${Number(ws.port) || 3001}`,
    accessToken: String(ws.accessToken ?? ''),
  };
}

function readGroups() {
  // 新位置优先；旧桥接路径只作过渡兼容（桥接目录已删除后自然失效）。
  for (const file of [CONFIG_FILE, BRIDGE_CONFIG]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const groups = (cfg.allow?.groups ?? []).map(String);
      if (groups.length) return groups;
    } catch {
      // 继续试下一个
    }
  }
  return [];
}

// config.json 曾经是「每条群消息读一次」，这里加 5 秒缓存；改了配置最多 5 秒生效。
const CONFIG_TTL_MS = 5000;
let brainConfigCache = { at: 0, value: {} };
function readBrainConfig() {
  const now = Date.now();
  if (now - brainConfigCache.at < CONFIG_TTL_MS) return brainConfigCache.value;
  let value = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') value = parsed;
  } catch {
    value = {};
  }
  brainConfigCache = { at: now, value };
  return value;
}

function createTurnCollector() {
  const turns = new Map();
  return {
    push(event) {
      if (event.type === 'turn/start') { turns.set(event.data.turn, { text: '' }); return null; }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        return t ? { turn: event.data.turn, reason: event.data.reason, text: t.text } : null;
      }
      return null;
    },
  };
}

// 她要写东西时补一条：别被 preset 的「单条尽量短」压住，也别报一个数不准的字数。
const WRITING_ASK = /作文|[0-9]{2,}\s*字|写一|写个|写篇|写段|长文|总结一下|报告|论文|稿子/;
function writingHint(text) {
  return WRITING_ASK.test(String(text || ''))
    ? '【长文】这次是要写东西：不受「单条要短」的限制，可以一条写长、也可以分几段，写够长度再收尾。你数不准字数，不要写「我数了下 X 个字」这种话。'
    : '';
}

/** 把消息行渲染成 [月-日 时:分] 谁：内容。 */
function fmtRows(rows) {
  return rows.slice().reverse().map((m) => {
    const d = new Date(m.t);
    const who = m.role === 'assistant' ? '她' : '对方';
    const stamp = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `[${stamp}] ${who}：${m.text}`;
  }).join('\n');
}

/**
 * 唤醒时回看的「刚才这段连续对话」。
 * 不按固定时长切：从最新一条往前翻，遇到超过 maxGapMs 的空档就停（那是话题断了），
 * 再受 maxItems / maxAgeMs 兜底。聊了半小时的一段能完整拿到，隔了一夜的就不要了。
 */
function takeRecentConversation(list, options = {}) {
  const { maxItems = 14, maxGapMs = 10 * 60000, maxAgeMs = 3 * 3600000 } = options;
  const now = Date.now();
  const picked = [];
  let previous = now;
  for (let i = list.length - 1; i >= 0 && picked.length < maxItems; i -= 1) {
    const item = list[i];
    if (now - item.t > maxAgeMs) break;
    if (previous - item.t > maxGapMs) break;
    picked.unshift(item);
    previous = item.t;
  }
  return picked;
}

function formatConversation(items) {
  return items.map((item) => {
    const d = new Date(item.t);
    const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const who = item.role === 'assistant' ? '你' : '对方';
    return `[${stamp}] ${who}：${String(item.text).slice(0, 140)}`;
  }).join('\n');
}

/**
 * 换新会话时补的旧上下文：这个会话最近聊过的消息。
 * 排除最近 2 分钟（那就是本次说话），避免把当前这条重复一遍。
 */
function fmtLastTalk(store, key, limit = 24) {
  const rows = store.searchMessages({ key, limit: limit + 8 })
    .filter((m) => m.t < Date.now() - 120000)
    .slice(0, limit);
  if (!rows.length) return '';
  return fmtRows(rows);
}

// 旧条目没有来源字段，但正文里写了「私聊 123456」的，本质上还是私聊内容。
const IMPLICIT_PRIVATE = /私聊\s*\d{5,}/;

/**
 * 记忆检索权限。
 * - 无来源（迁移前的老条目）视为她自己的记忆：默认所有会话都能想起，
 *   但正文里带「私聊 123456」的仍按私聊处理，避免群聊被诱导出私聊的细节；
 * - 群记忆只在同一个群可见，防止别的群的事串台；
 * - 私聊记忆只在自己这条私聊可见；
 * - 私聊里也能看到所有群记忆（她本来就知道群里的事）。
 */
export function diaryEntryAllowed(entry, key) {
  const source = String(entry.source || '').trim();
  const rawKey = String(key || '');
  const id = rawKey.split(':')[1] || '';
  const isGroup = rawKey.startsWith('group:');
  // 没有来源、但正文自曝是私聊：按私聊处理
  const implicitPrivate = !source && IMPLICIT_PRIVATE.test(String(entry.text || ''));
  if (!source && !implicitPrivate) return true;

  const fromPrivate = source ? source.startsWith('私聊') : true;
  if (isGroup) {
    if (fromPrivate) return false;
    return source === `群${id}` || source === `群${id.slice(-6)}`;
  }
  if (!fromPrivate) return true;
  // 推断为私聊但没有具体来源：分不清是哪个私聊，就允许所有私聊（群里仍然看不到）
  if (!source) return true;
  return source === `私聊${id}` || source === `私聊${id.slice(-6)}`;
}

/** 只有出现“回忆信号”时才去翻长期记忆。 */
export function needsRecall(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/还记得|记得|上次|之前|以前|那天|说过|答应|约好|很久|过去|当时|那次/.test(s)) return true;
  if (/(谁|哪次|什么时候|多久)/.test(s)) return true;
  // 「有人找过我吗」「群里有没有叫我」这类也要能翻出东西来
  if (/找过我|找过你|找我吗|找你了|有人找|谁找|联系过|叫我|提到我|群里|拍过我|拍你/.test(s)) return true;
  return false;
}

// 私聊里被问起「谁找过你」时，去群消息里捞最近 @她 / 拍她的记录。
export const LOOKUP_ASK = /找过我|找过你|找我吗|找你了|有人找|谁找|联系过|叫我|提到我|群里|拍过我|拍你/;
const WAKE_NAME_PATTERN = '@(?:蓝莓|小鲸鱼|大肥鱼|小鱼|丫头|鱼鱼)';
function mentionPattern() {
  const self = SELF_QQ ? `|@${SELF_QQ}` : '';
  return new RegExp(`${WAKE_NAME_PATTERN}${self}|（拍了拍你）`);
}

/**
 * 最近 N 小时里，群里 @过她 / 拍过她 / 叫过她名字的消息。
 * 她私聊时看不到群聊上下文，但这些都是 store 里真实存在的原始消息。
 */
export function groupMentionsOf(store, hours = 24, limit = 12) {
  const since = Date.now() - hours * 3600000;
  const messages = Array.isArray(store?.messages) ? store.messages : [];
  const hits = [];
  for (let i = messages.length - 1; i >= 0 && hits.length < limit; i -= 1) {
    const message = messages[i];
    if (Number(message.t) < since) break;
    if (!String(message.key || '').startsWith('group:')) continue;
    if (!mentionPattern().test(String(message.text || ''))) continue;
    hits.push(message);
  }
  return hits.reverse();
}

/** 把群消息渲染成她看得懂的「谁在什么时候找你」。 */
export function formatMentions(messages) {
  return messages.map((message) => {
    const d = new Date(message.t);
    const stamp = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const who = message.role === 'assistant' ? '你' : '对方';
    const group = String(message.key || '').split(':')[1] || '';
    return `[${stamp}][群 ${group}] ${who}：${String(message.text || '').slice(0, 100)}`;
  }).join('\n');
}

// 两字切词会切出一堆虚词，命中它们不算“想起”。
const RECALL_NOISE = new Set([
  '什么', '怎么', '可以', '这个', '那个', '现在', '今天', '明天', '昨天', '一下',
  '就是', '还是', '但是', '因为', '所以', '如果', '然后', '自己', '我们', '你们',
  '他们', '一个', '没有', '不是', '这样', '那样', '知道', '觉得', '应该', '可能',
]);
const REINFORCE_MIN_INTERVAL = 60000;
let lastReinforceAt = 0;

/**
 * 召回长期记忆。
 * 返回 { block, entries, sensitive }：
 *   - block      拼好的注入文本
 *   - entries    命中的条目（审批判断要用来源信息）
 *   - sensitive  这次召回里有没有「别人会话不该看到的」内容
 */
function diaryRecall(diary, query, key, limit = 5) {
  const empty = { block: '', entries: [], sensitive: false };
  const text = String(query || '');
  const entries = diary.parse();
  if (!text.trim() || !entries.length) return empty;
  const grams = new Set();
  for (const seg of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < seg.length - 1; i += 1) {
      const gram = seg.slice(i, i + 2);
      if (!RECALL_NOISE.has(gram)) grams.add(gram);
    }
  }
  for (const word of text.match(/[A-Za-z]{3,}/g) ?? []) grams.add(word.toLowerCase());
  if (!grams.size) return empty;
  const scored = [];
  for (const entry of entries) {
    if (!diaryEntryAllowed(entry, key)) continue;
    const lower = String(entry.text || '').toLowerCase();
    let score = 0;
    for (const gram of grams) if (lower.includes(gram)) score += 1;
    if (score >= 2) {
      // 匹配度 × 时间衰减/手动权重
      scored.push({ entry, score: score * diary.weightOf(entry) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limit);
  if (!picked.length) return empty;
  // 被想起一次就强化一次；写盘节流，避免召回把整个 md 反复重写
  if (Date.now() - lastReinforceAt > REINFORCE_MIN_INTERVAL) {
    lastReinforceAt = Date.now();
    try { diary.reinforce(picked.map(({ entry }) => entry)); } catch {}
  }
  const hitEntries = picked.map(({ entry }) => entry);
  return {
    block: hitEntries.map((entry) => {
      const stamp = `${entry.date.slice(5)}${entry.time ? ` ${entry.time}` : ''}`;
      return `[${stamp}·${entry.kind}] ${String(entry.text).slice(0, 160)}`;
    }).join('\n'),
    entries: hitEntries,
    sensitive: recallIsSensitive(hitEntries, key),
  };
}

/**
 * 这次召回算不算「别人会话不该看到的」。
 * - 主人私聊：她能看的都随便看；
 * - 别人会话：无来源的旧记忆（历史私聊内容）就算敏感；
 * - 群里召回到别的群 / 别人私聊的内容也算（正常情况下已经被 diaryEntryAllowed 挡掉）。
 */
function recallIsSensitive(hitEntries, key) {
  const rawKey = String(key || '');
  if (rawKey === `private:${OWNER_QQ}`) return false;
  const id = rawKey.split(':')[1] || '';
  const isGroup = rawKey.startsWith('group:');
  for (const entry of hitEntries) {
    const source = String(entry.source || '').trim();
    if (!source) return true;
    if (isGroup) {
      if (source !== `群${id}` && source !== `群${id.slice(-6)}`) return true;
    } else if (source !== `私聊${id}` && source !== `私聊${id.slice(-6)}`) {
      return true;
    }
  }
  return false;
}

/** 最近几天的记忆（新会话开场用），同样按检索权限过滤。 */
function diaryRecent(diary, key, days = 3, limit = 20) {
  const now = new Date();
  const floor = new Date(now.getTime() - days * 86400000);
  const floorKey = `${floor.getFullYear()}-${String(floor.getMonth() + 1).padStart(2, '0')}-${String(floor.getDate()).padStart(2, '0')}`;
  const entries = diary.parse()
    .filter((entry) => entry.date >= floorKey && diaryEntryAllowed(entry, key))
    .slice(-limit);
  if (!entries.length) return '';
  return entries.map((entry) => {
    const stamp = `${entry.date.slice(5)}${entry.time ? ` ${entry.time}` : ''}`;
    return `[${stamp}·${entry.kind}] ${String(entry.text).slice(0, 160)}`;
  }).join('\n');
}

function localTimeText() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function textOf(event) {
  if (!Array.isArray(event.message)) return String(event.raw_message ?? '');
  return event.message.map((part) => {
    switch (part?.type) {
      case 'text': return part.data?.text ?? '';
      case 'at': return `@${part.data?.name || part.data?.qq || ''}`;
      case 'reply': return '[引用回复]';
      case 'face': {
        // 让模型知道具体表情，而不是一律「[表情]」
        const name = FACE_NAMES[String(part.data?.id ?? '')];
        return name ? `[表情:${name}]` : '[表情]';
      }
      case 'image': return '[图片]';
      case 'mface': return '[表情包]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'forward': return '[合并转发]';
      default: return '';
    }
  }).join('');
}

function isAwake(event, selfId, wakeWords) {
  const parts = Array.isArray(event.message) ? event.message : [];
  const at = parts.some((part) => part?.type === 'at' && String(part.data?.qq ?? '') === String(selfId));
  if (at) return true;
  const text = textOf(event);
  return wakeWords.some((word) => text.includes(word));
}

function readWakeWords() {
  const cfg = readBrainConfig();
  const list = Array.isArray(cfg.wakeWords) && cfg.wakeWords.length ? cfg.wakeWords : WAKE_WORDS;
  return list.map(String);
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ── 她自己发出去的消息 id ──
// OneBot 的 reply 段只带「被引用消息的 id」，不带 QQ，所以「别人是不是在回复她」
// 只能靠这个集合判断。以前一律把 reply 当「回复她」，别人互引也会把她叫醒。
const OWN_IDS_FILE = process.env.FISH_S2_OWN_IDS || 'D:\\fish\\brain\\state\\s2-own-messages.json';
const OWN_MESSAGE_LIMIT = 500;
const ownMessageIds = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(OWN_IDS_FILE, 'utf8'));
    return new Set(Array.isArray(list) ? list.slice(-OWN_MESSAGE_LIMIT).map(String) : []);
  } catch {
    return new Set();
  }
})();
let ownIdsSaveTimer = null;

function saveOwnIds() {
  try {
    fs.mkdirSync(path.dirname(OWN_IDS_FILE), { recursive: true });
    const list = [...ownMessageIds].slice(-OWN_MESSAGE_LIMIT);
    const tmp = `${OWN_IDS_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(list)}\n`, 'utf8');
    fs.renameSync(tmp, OWN_IDS_FILE);
  } catch {}
}

function rememberOwnId(id) {
  const value = String(id ?? '').trim();
  if (!value) return;
  ownMessageIds.add(value);
  while (ownMessageIds.size > OWN_MESSAGE_LIMIT) {
    const oldest = ownMessageIds.values().next().value;
    ownMessageIds.delete(oldest);
  }
  if (ownIdsSaveTimer) return;
  ownIdsSaveTimer = setTimeout(() => {
    ownIdsSaveTimer = null;
    saveOwnIds();
  }, 1000);
  if (typeof ownIdsSaveTimer.unref === 'function') ownIdsSaveTimer.unref();
}

function sniffMediaType(buf, fallback = 'image/jpeg') {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return fallback;
}

/** 判断字节是不是真的图片（防止把 JSON/HTML 错误页当图片喂给模型）。 */
function isImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  return false;
}

function acceptImage(buf) {
  if (!buf || !buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  if (!isImageBuffer(buf)) return null;
  return { buf, mediaType: sniffMediaType(buf) };
}

async function fetchImageUrl(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://q.qq.com/' },
    });
    if (!res.ok) return null;
    return acceptImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

function imageFromBase64(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const raw = text.startsWith('base64://') ? text.slice('base64://'.length) : text;
    return acceptImage(Buffer.from(raw, 'base64'));
  } catch {
    return null;
  }
}

/** 取图片字节：先直连（base64/本地/URL），失败再走 SnowLuma 的 get_image（QQ 图片 URL 带签名，直连常失效）。 */
async function readSegmentImage(segment, bot) {
  const data = segment?.data ?? {};
  const refs = [data.file, data.url].filter((value) => typeof value === 'string' && value);

  for (const raw of refs) {
    const direct = raw.startsWith('base64://') ? imageFromBase64(raw)
      : /^https?:\/\//i.test(raw) ? await fetchImageUrl(raw)
        : fs.existsSync(raw) ? acceptImage(fs.readFileSync(raw)) : null;
    if (direct) return direct;
  }

  if (bot?.getImage) {
    for (const ref of refs) {
      try {
        const info = await bot.getImage({ file: ref });
        const candidates = [
          info?.data?.base64, info?.data, info?.base64, info?.file,
        ];
        for (const candidate of candidates) {
          const fromBase64 = imageFromBase64(candidate);
          if (fromBase64) return fromBase64;
        }
        if (typeof info?.url === 'string') {
          const fetched = await fetchImageUrl(info.url);
          if (fetched) return fetched;
        }
        if (typeof info?.file === 'string' && fs.existsSync(info.file)) {
          const local = acceptImage(fs.readFileSync(info.file));
          if (local) return local;
        }
      } catch (error) {
        log(`get_image failed (${String(ref).slice(0, 40)}): ${error?.message ?? error}`);
      }
    }
  }
  return null;
}

async function collectImageParts(event, stickers, sourceKey, bot) {
  const segments = Array.isArray(event.message) ? event.message : [];
  const parts = [];
  const ids = [];
  for (const segment of segments) {
    if (segment?.type !== 'image' && segment?.type !== 'mface') continue;
    if (parts.length >= MAX_IMAGES) break;
    const found = await readSegmentImage(segment, bot);
    if (!found || !found.buf.length || found.buf.length > MAX_IMAGE_BYTES) {
      log(`image bytes unavailable (type=${segment?.type})`);
      continue;
    }
    parts.push({
      type: 'image',
      data: found.buf.toString('base64'),
      mediaType: found.mediaType,
      name: segment.type === 'mface' ? 'sticker' : 'qq-image',
    });
    if (stickers && found.buf.length <= 2 * 1024 * 1024) {
      const saved = stickers.add({
        buf: found.buf,
        mediaType: found.mediaType,
        sourceKey,
        sender: String(event.user_id ?? ''),
        summary: segment.data?.summary ?? '',
      });
      if (saved) ids.push(saved.id);
    }
  }
  return { parts, ids };
}

// QQ 小黄脸：她说 [face:微笑] 就发成真表情
const FACE_IDS = {
  惊讶: 0, 撇嘴: 1, 色: 2, 发呆: 3, 得意: 4, 流泪: 5, 害羞: 6, 闭嘴: 7, 睡: 8, 大哭: 9,
  尴尬: 10, 发怒: 11, 调皮: 12, 呲牙: 13, 微笑: 14, 难过: 15, 酷: 16, 抓狂: 18, 吐: 19,
  偷笑: 20, 可爱: 21, 白眼: 22, 傲慢: 23, 饥饿: 24, 困: 25, 惊恐: 26, 流汗: 27, 憨笑: 28,
  奋斗: 30, 疑问: 32, 嘘: 33, 晕: 34, 折磨: 35, 衰: 36, 骷髅: 37, 敲打: 38, 再见: 39,
  发抖: 41, 爱情: 42, 跳跳: 43, 猪头: 46, 拥抱: 49, 蛋糕: 53, 咖啡: 60, 玫瑰: 63,
  凋谢: 64, 爱心: 66, 心碎: 67, 太阳: 74, 月亮: 75, 赞: 76, 踩: 77, 握手: 78, 胜利: 79,
  飞吻: 85, 怄火: 86, 西瓜: 89, 冷汗: 96, 擦汗: 97, 抠鼻: 98, 鼓掌: 99, 坏笑: 101,
  哈欠: 104, 鄙视: 105, 委屈: 106, 快哭了: 107, 阴险: 108, 亲亲: 109, 可怜: 111,
  菜刀: 112, 啤酒: 113, 篮球: 114, 乒乓: 115, 示爱: 116, 抱拳: 118, 勾引: 119,
  拳头: 120, 差劲: 121, 爱你: 122, NO: 123, OK: 124, 转圈: 125, 磕头: 126, 挥手: 129,
};

// 反查表：把对方发来的 [CQ:face,id=14] 变成「[表情:微笑]」，模型才知道是什么表情
const FACE_NAMES = Object.fromEntries(Object.entries(FACE_IDS).map(([name, id]) => [String(id), name]));

/**
 * 把 "好啊[face:微笑]" 拆成 text + face 段。
 * 未知表情名直接丢弃标记（之前会原样发给对方，对方看到 "[face:xxx]" 这种内部语法）。
 */
export function parseFaceSegments(text, onUnknown) {
  const segments = [];
  const pattern = /\[(?:face|表情)[:：]([^\]]+)\]/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = String(match[1]).trim();
    const id = FACE_IDS[name] ?? (/^\d+$/.test(name) ? Number(name) : undefined);
    if (match.index > last) segments.push({ type: 'text', data: { text: text.slice(last, match.index) } });
    if (id !== undefined && Number.isFinite(id)) {
      segments.push({ type: 'face', data: { id } });
    } else if (typeof onUnknown === 'function') {
      onUnknown(name);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } });
  // 全被剃光（比如整句只有一个未知表情）时返回空文本段，交给上层跳过
  return segments;
}

function humanGap(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function waitForService(ctx, serviceName, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let service;
      try { service = ctx.get(serviceName); } catch { service = undefined; }
      if (service) return resolve(service);
      if (Date.now() - started > timeoutMs) {
        log(`service ${serviceName} unavailable after ${timeoutMs}ms`);
        return resolve(undefined);
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

export function apply(ctx) {
  log('apply: S2 bridge starting');
  bootstrap(ctx).catch((error) => log(`bootstrap failed: ${error?.stack ?? error?.message ?? error}`));
}

async function bootstrap(ctx) {
  const controller = await waitForService(ctx, 'sessionController');
  if (!controller) { log('no sessionController, bridge inactive'); return; }

  const store = new Store(DATA_DIR);
  store.load();
  const stickers = new StickerStore(process.env.FISH_S2_STICKERS || 'D:\\fish\\brain\\stickers');
  const diary = new Diary(MEMORY_FILE, { halfLifeDays: 30, forgetThreshold: 0.05, forgetAfterDays: 60, log });
  const extractor = new MemoryExtractor({
    ctx,
    controller,
    store,
    diary,
    workspace: WORKSPACE,
    log,
    stateFile: process.env.FISH_S2_MEMORY_STATE || 'D:\\fish\\brain\\state\\memory-extract.json',
  });
  const state = readState();
  // preset 换了：旧会话仍挂在旧 preset 上，清掉映射让下次消息用新 preset 重建
  if (state.preset !== PRESET_VERSION) {
    log(`preset changed -> ${PRESET_VERSION}, resetting ${Object.keys(state.sessions || {}).length} session mapping(s)`);
    state.sessions = {};
    state.preset = PRESET_VERSION;
    writeState(state);
  }
  const groups = readGroups();
  const brainCfg = readBrainConfig();
  OWNER_QQ = String(brainCfg.ownerQQ || process.env.FISH_OWNER_QQ || OWNER_QQ || '');
  SELF_QQ = String(brainCfg.selfQQ || process.env.FISH_SELF_QQ || SELF_QQ || '');
  const wakeChance = Math.max(0, Math.min(1, Number(process.env.FISH_S2_WAKE_CHANCE ?? brainCfg.groupWakeChance ?? 0.03)));
  const engageMinutes = Math.max(0, Number(process.env.FISH_S2_ENGAGE_MINUTES ?? brainCfg.groupEngageMinutes ?? 10));
  // 她说过话之后的一段时间里，群里还有人在聊，就把消息送进模型让她自己决定接不接。
  // 以前这个窗口只有 5 分钟，且要求「说话人 == 叫她的人」，还不小于 45 秒一次，
  // 结果她回完一句就再也接不上话。
  const activeWindowMinutes = Math.max(0, Number(process.env.FISH_S2_ACTIVE_MINUTES ?? brainCfg.activeWindowMinutes ?? 10));
  const activeWindowMs = activeWindowMinutes * 60000;
  const passiveChance = Math.max(0, Math.min(1, Number(process.env.FISH_S2_PASSIVE_CHANCE ?? brainCfg.passiveChance ?? 0.3)));
  const privateAllow = new Set((brainCfg.allow?.private ?? [OWNER_QQ]).map(String));
  privateAllow.add(OWNER_QQ);
  const proactiveMin = Math.max(1, Number(process.env.FISH_S2_PROACTIVE_MIN ?? brainCfg.proactiveMinMinutes ?? 50));
  const proactiveMax = Math.max(proactiveMin, Number(process.env.FISH_S2_PROACTIVE_MAX ?? brainCfg.proactiveMaxMinutes ?? 110));
  log(`loaded mappings: ${Object.keys(state.sessions || {}).length}; groups: ${groups.join(',') || '(none)'}; wakeChance: ${wakeChance}; engage: ${engageMinutes}min; activeWindow: ${activeWindowMinutes}min; passive: ${passiveChance}; proactive: ${proactiveMin}-${proactiveMax}min`);

  // ── 记忆同步：每周一次，把记忆/人设/配置/聊天归档提交到私密 GitHub 仓库 ──
  // 「每周一上线后」：以周一为一周起点，本周还没同步过就同步；周一没开机，下次上线补上。
  // 本地只留一个 git 工作目录，不放第二份备份副本。
  const MEMORY_REPO_DIR = process.env.FISH_S2_MEMORY_REPO_DIR || 'D:\\fish-memory';
  const MEMORY_REPO_URL = process.env.FISH_S2_MEMORY_REPO
    || 'https://gh-proxy.com/https://github.com/Soodshadow/fish-memory';
  const MEMORY_REPO_SOURCES = [
    [MEMORY_FILE, 'MEMORY-ARCHIVE.md'],
    ['D:\\fish\\memory\\MEMORY-BLUEPRINT.md', 'MEMORY-BLUEPRINT.md'],
    [CONFIG_FILE, 'config.json'],
    [path.join(DATA_DIR, 'messages.jsonl'), 'messages.jsonl'],
    [path.join(DATA_DIR, 'people.json'), 'people.json'],
    [path.join(DATA_DIR, 'conversations.json'), 'conversations.json'],
    [STATE_FILE, 's2-sessions.json'],
  ];
  const memorySyncEnabled = process.env.FISH_S2_MEMORY_SYNC !== '0' && brainCfg.memorySync !== false;

  /** ISO 周的周一日期，作为「本周」的键。 */
  function weekKey(date = new Date()) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const offset = (d.getDay() + 6) % 7; // 周一 = 0
    d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 启动时从仓库最后一次提交恢复「上次同步是哪一周」，避免重启后重复推一次
  let lastMemorySyncWeek = '';
  try {
    const status = memoryRepoStatus(MEMORY_REPO_DIR);
    const found = status.ok ? /(\d{4})-(\d{2})-(\d{2})/.exec(status.last || '') : null;
    if (found) lastMemorySyncWeek = weekKey(new Date(`${found[1]}-${found[2]}-${found[3]}T12:00:00`));
  } catch {}

  function runMemorySync() {
    if (!memorySyncEnabled) return;
    const week = weekKey();
    if (lastMemorySyncWeek === week) return;
    try {
      const result = syncMemoryRepo({
        workDir: MEMORY_REPO_DIR,
        sources: MEMORY_REPO_SOURCES,
        remote: MEMORY_REPO_URL,
        log,
      });
      if (result.pushed) {
        lastMemorySyncWeek = week;
        log(`memory sync (week ${week}) ${result.committed ? 'committed' : 'unchanged'} (${result.copied} files)`);
      }
    } catch (error) {
      log(`memory sync failed: ${error?.message ?? error}`);
    }
  }
  runMemorySync();

  const personaText = (() => {
    try { return fs.readFileSync('D:\\fish\\memory\\MEMORY-BLUEPRINT.md', 'utf8'); } catch { return ''; }
  })();

  /**
   * 身份注入：人设蓝图 + 最近几天她记得的事 +（换新会话时）上次聊到哪。
   * 以前 diaryRecent() 写了却从没被调用，等于新会话开场只有人设、没有近期记忆。
   */
  function identityParts(key, { persona = false, recent = true, recentTalk = false } = {}) {
    const parts = [];
    // 人设只在「新会话 / 被叫醒」时重灌一次：同一会话的后续轮次，历史里已经有了，
    // 每次都塞会让 prompt 白涨 5000 字符（人设文件 15KB）。
    if (persona && personaText) parts.push(`【你是谁·核心记忆】\n${personaText}`);
    if (recent) {
      const memRecent = diaryRecent(diary, key, 3, 20);
      if (memRecent) parts.push(`【最近几天你记得的事】\n${memRecent}`);
    }
    if (recentTalk) {
      // preset 升级会重建会话；补一段旧上下文，免得像刚认识
      const talk = fmtLastTalk(store, key, 24);
      if (talk) parts.push(`【你和这里上次聊到的地方】\n${talk}`);
    }
    // 日记不注入：那是她自己的本子，不挂嘴边。
    return parts;
  }

  let bot;
  let disposed = false;
  const contexts = new Map();
  // 注意力：每个群她是不是醒着、上次看到哪、下次主动看群的时间
  const attention = new Map();
  const proactiveAt = new Map();
  const groupBuffers = new Map();
  const memoryTimers = new Map();

  function att(key) {
    if (!attention.has(key)) attention.set(key, { awakeUntil: 0, lastSeenAt: 0, cooldownUntil: 0, lastCallAt: 0, needsPersona: false, engagedWith: '', conversationUntil: 0, pendingMedia: [] });
    return attention.get(key);
  }

  // ── 休眠时的群聊：只看不存 ──
  // 路人聊天不落库（她不在场，存了也没用还占空间）；
  // 只在内存里留一小段，等她被叫醒时用来接上下文。
  const recentTalk = new Map();
  const RECENT_TALK_LIMIT = 80;
  function rememberTalk(key, role, text, when) {
    const value = String(text || '').trim();
    if (!value) return;
    let list = recentTalk.get(key);
    if (!list) { list = []; recentTalk.set(key, list); }
    list.push({ t: Number(when) || Date.now(), role: role === 'assistant' ? 'assistant' : 'user', text: value });
    if (list.length > RECENT_TALK_LIMIT) list.splice(0, list.length - RECENT_TALK_LIMIT);
  }

  /**
   * 跨会话看群聊：私聊时也要知道她刚在群里说了什么。
   * 群和私聊是两个 DSH 会话，上下文互不相通；这里把最近的群聊捞出来补上。
   */
  function groupContextAll(maxItems = 12, maxAgeMs = 4 * 3600000) {
    const now = Date.now();
    const items = [];
    for (const [key, list] of recentTalk) {
      if (!String(key).startsWith('group:')) continue;
      for (const item of list) {
        if (now - item.t <= maxAgeMs) items.push(item);
      }
    }
    if (items.length) {
      items.sort((a, b) => a.t - b.t);
      return formatConversation(items.slice(-maxItems));
    }
    // 内存空（刚重启）就退回库里她参与的群消息
    const rows = (Array.isArray(store?.messages) ? store.messages : [])
      .filter((m) => String(m.key || '').startsWith('group:'));
    if (!rows.length) return '';
    return fmtRows(rows.slice(-maxItems));
  }

  /**
   * 从 QQ 现场往上翻群聊天记录（不落库，只在叫醒她时拉一次）。
   * OneBot 的 get_group_msg_history 直接问 SnowLuma 要最近的 N 条，
   * 这样她醒来能看到「叫醒她之前」发生了什么，而不是从零开始。
   */
  async function fetchGroupHistory(key, groupId, count = 20) {
    if (!bot || typeof bot.getGroupMessageHistory !== 'function') return '';
    try {
      const res = await bot.getGroupMessageHistory({ group_id: Number(groupId), count });
      const messages = Array.isArray(res?.messages) ? res.messages : [];
      if (!messages.length) return '';
      const items = [];
      for (const message of messages) {
        const senderId = String(message?.sender?.user_id ?? message?.user_id ?? '');
        if (senderId && senderId === SELF_QQ) continue; // 她自己说过的不再念一遍
        const body = textOf(message).trim();
        if (!body) continue;
        const t = Number(message?.time) * 1000 || Date.now();
        items.push({ t, role: 'user', text: body });
        rememberTalk(key, 'user', body, t); // 塞进内存，后面几轮也看得到
      }
      if (!items.length) return '';
      items.sort((a, b) => a.t - b.t);
      return formatConversation(items.slice(-count));
    } catch (error) {
      log(`history fetch failed ${groupId}: ${error?.message ?? error}`);
      return '';
    }
  }
  function recentContext(key, options) {
    const list = recentTalk.get(key) || [];
    if (!list.length) return '';
    return formatConversation(takeRecentConversation(list, options));
  }

  /**
   * 这一批消息「之前」的最近一段对话。
   * 之前只在唤醒时注入一次，导致她后面被问「我刚才说了什么」时只能翻自己的旧会话。
   * 现在每轮都给：从内存取（含她不在场的聊天），排除最近 2 分钟（那是当前这批）；
   * 内存还没热（刚重启）就回落到库里她参与过的对话。
   */
  function historyContext(key, maxItems = 12, beforeT = Date.now()) {
    const list = (recentTalk.get(key) || []).filter((item) => item.t < beforeT);
    const fromMemory = formatConversation(takeRecentConversation(list, {
      maxItems,
      maxGapMs: 30 * 60000,
      maxAgeMs: 6 * 3600000,
    }));
    if (fromMemory) return fromMemory;
    return fmtLastTalk(store, key, maxItems);
  }

  // ── 敏感记忆审批 ──
  // 别人（非主人）问到不属于当前会话的记忆时，这一轮回话不直接发出去，
  // 而是先私聊问主人：1 = 发，2 = 不发。主人私聊不受影响。
  const approvalEnabled = process.env.FISH_S2_APPROVE !== '0' && brainCfg.approveSensitiveRecall !== false;
  const APPROVAL_TIMEOUT_MS = Math.max(60000, Number(process.env.FISH_S2_APPROVAL_TIMEOUT_MS ?? brainCfg.approvalTimeoutMs ?? 5 * 60000));
  const APPROVAL_MAX_PENDING = Math.max(1, Number(process.env.FISH_S2_APPROVAL_MAX ?? brainCfg.approvalMaxPending ?? 5));
  const pendingApprovals = new Map();
  let approvalSeq = 0;

  function approvalCommandOf(text) {
    const cmd = String(text || '').trim();
    if (/^(1|发|发吧|可以|同意|行|yes|y)$/i.test(cmd)) return 'send';
    if (/^(2|不发|别发|不要|算了|no|n)$/i.test(cmd)) return 'drop';
    return '';
  }

  function latestApproval() {
    let latest = null;
    for (const approval of pendingApprovals.values()) {
      if (!latest || approval.at > latest.at) latest = approval;
    }
    return latest;
  }

  async function notifyOwner(text) {
    if (!bot) return false;
    try {
      await bot.sendPrivateMessage(Number(OWNER_QQ), [{ type: 'text', data: { text } }]);
      return true;
    } catch (error) {
      log(`approval notify failed: ${error?.message ?? error}`);
      return false;
    }
  }

  async function requestApproval(context, replyText) {
    // 已经堆了太多待确认：这条直接不发，别把主人私聊刷爆
    if (pendingApprovals.size >= APPROVAL_MAX_PENDING) {
      log(`APPROVAL queue full (${pendingApprovals.size}), dropped ${context.key}`);
      return '';
    }
    approvalSeq += 1;
    const id = `ap-${Date.now()}-${approvalSeq}`;
    const where = context.reply.kind === 'group' ? `群 ${context.reply.id}` : `别人的私聊 ${context.reply.id}`;
    const approval = {
      id,
      key: context.key,
      reply: { ...context.reply },
      text: replyText,
      messageId: context.approvalMessageId || '',
      at: Date.now(),
      timer: null,
    };
    approval.timer = setTimeout(() => {
      pendingApprovals.delete(id);
      log(`APPROVAL timeout ${id}`);
      notifyOwner(`刚才那条（${where}）超过 ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟没回，已经没发了。`).catch(() => {});
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, approval);

    const question = String(context.approvalQuestion || '').trim().slice(0, 160);
    const lines = [
      `【有人问到不该说的，先问你】${where}`,
      question ? `对方说：${question}` : '',
      '她准备回：',
      String(replyText).slice(0, 600),
      '',
      '1 = 发出去',
      '2 = 不发',
      `（${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟没回就当不发）`,
    ].filter(Boolean).join('\n');
    const delivered = await notifyOwner(lines);
    if (!delivered) log(`APPROVAL could not reach owner, holding ${id}`);
    log(`APPROVAL requested ${id} for ${context.key} (${replyText.length} chars)`);
    return id;
  }

  /** 主人回 1/2 时消费掉一条待审批；返回 true 表示这条消息不该再进对话。 */
  function tryHandleApproval(text) {
    if (!pendingApprovals.size) return false;
    const command = approvalCommandOf(text);
    if (!command) return false;
    const approval = latestApproval();
    if (!approval) return false;
    clearTimeout(approval.timer);
    pendingApprovals.delete(approval.id);
    if (command === 'send') {
      sendReply(approval.reply, approval.text, approval.messageId)
        .then((ok) => {
          log(`APPROVED ${approval.key} sent=${ok}`);
          if (ok) {
            try {
              store.appendMessages([{ t: Date.now(), key: approval.key, platform: 'qq', conv: approval.key, role: 'assistant', text: approval.text, source: 's2' }]);
            } catch {}
          }
        })
        .catch((error) => log(`approved send failed: ${error?.message ?? error}`));
    } else {
      log(`REJECTED ${approval.key}`);
    }
    return true;
  }

  // 一件事说完后（3 分钟不再有新动静）判断一次值不值得记，不做定时全量扫描
  const MEMORY_JUDGE_DELAY = 180000;
  function scheduleMemoryJudge(key) {
    // 开关每次都读（带 5 秒缓存），改 config.json 不用重启
    if (readBrainConfig().memoryExtract === false) return;
    // 已经在排队就不重排：以前活跃会话会被自己的下一条消息不断推迟，永远轮不到
    if (memoryTimers.has(key)) return;
    const timer = setTimeout(async () => {
      memoryTimers.delete(key);
      try {
        const lastT = extractor.lastT(key);
        const rows = store.searchMessages({ key, limit: 60 })
          .filter((message) => message.t > lastT && String(message.text || '').trim())
          .slice(0, 20)
          .sort((a, b) => a.t - b.t);
        if (rows.length < 2) return;
        const transcript = rows.map((message) => `${message.role === 'assistant' ? '她' : '对方'}：${message.text}`).join('\n');
        const added = await extractor.judge(key, transcript, rows[rows.length - 1].t);
        log(`memory judge ${key}: +${added}`);
      } catch (error) {
        log(`memory judge error: ${error?.message ?? error}`);
      }
    }, MEMORY_JUDGE_DELAY);
    memoryTimers.set(key, timer);
  }

  // ── 群消息合并：普通消息攒 15 秒合成一次判断，@/名字/被回复例外 ──
  const BATCH_WAIT_MS = Math.max(3000, Number(process.env.FISH_S2_BATCH_MS ?? brainCfg.batchWaitMs ?? 15000));
  const REPLY_COOLDOWN_MS = Math.max(0, Number(process.env.FISH_S2_COOLDOWN_MS ?? brainCfg.replyCooldownMs ?? 20000));

  // ── 私聊连发合并：几秒内的几条合成一次，避免「一句一回」 ──
  // 群里有 15 秒合并窗口，私聊以前是每条消息一个 prompt，连发三条就被回三次。
  const PRIVATE_MERGE_MS = Math.max(500, Number(process.env.FISH_S2_PRIVATE_MERGE_MS ?? brainCfg.privateMergeMs ?? 2500));
  const privateBuffers = new Map();

  function enqueuePrivate(key, item) {
    let buf = privateBuffers.get(key);
    if (!buf) {
      buf = { items: [], timer: null };
      privateBuffers.set(key, buf);
    }
    buf.items.push(item);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      const current = privateBuffers.get(key);
      if (current) current.timer = null;
      flushPrivate(key).catch((error) => log(`private flush error: ${error?.message ?? error}`));
    }, PRIVATE_MERGE_MS);
  }

  async function flushPrivate(key) {
    const buf = privateBuffers.get(key);
    if (!buf || !buf.items.length) return;
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    privateBuffers.delete(key);
    const items = buf.items;
    const last = items[items.length - 1];
    const merged = items
      .map((item) => String(item.text ?? ''))
      .filter((value) => value.trim())
      .join('\n');
    log(`MERGED ${key} (${items.length} msgs, ${merged.length} chars)`);
    await dispatchMessage({
      key,
      kind: 'private',
      replyId: String(last.event.user_id),
      userId: String(last.event.user_id),
      sender: last.sender,
      text: merged || '（对方发了一条没有文字的消息）',
      imageEvents: items.map((item) => item.event),
      messageId: String(last.event.message_id ?? ''),
      groupId: '',
    });
  }

  function enqueueGroup(key, item) {
    let buf = groupBuffers.get(key);
    if (!buf) {
      buf = { items: [], timer: null, firstAt: 0 };
      groupBuffers.set(key, buf);
    }
    buf.items.push(item);
    if (!buf.firstAt) buf.firstAt = Date.now();
    if (!buf.timer) {
      // 图片/爸爸发的：4 秒内合并；普通对话：15 秒合并
      const base = item.owner || item.hasMedia ? 4000 : BATCH_WAIT_MS;
      const wait = Math.max(0, Math.min(base, base - (Date.now() - buf.firstAt)));
      buf.timer = setTimeout(() => { flushGroup(key).catch((error) => log(`flush error: ${error?.message ?? error}`)); }, wait);
    }
  }

  async function flushGroup(key) {
    const buf = groupBuffers.get(key);
    if (!buf) return;
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    buf.firstAt = 0;
    const items = buf.items.splice(0);
    if (!items.length) return;

    const a = att(key);
    if (a.cooldownUntil > Date.now()) {
      for (const item of items) buf.items.push(item);
      buf.firstAt = Date.now();
      buf.timer = setTimeout(() => { flushGroup(key).catch(() => {}); }, a.cooldownUntil - Date.now() + 200);
      return;
    }
    await processGroupBatch(key, items);
  }

  async function processGroupBatch(key, items) {
    const groupId = key.slice('group:'.length);
    const last = items[items.length - 1];
    const transcript = items.map((item) => `${item.sender}（${item.userId}）：${item.text}`).join('\n');
    const imageParts = [];
    const stickerIds = [];
    // 合并这一批里所有图片（最多 4 张），不再一张一次调用
    for (const item of items.slice(-4)) {
      if (!item.hasMedia || !item.event) continue;
      const collected = await collectImageParts(item.event, stickers, key, bot).catch(() => ({ parts: [], ids: [] }));
      for (const part of collected.parts) { if (imageParts.length < 4) imageParts.push(part); }
      stickerIds.push(...collected.ids);
    }
    const fromOwner = items.some((item) => item.owner);

    try {
      const sessionId = await ensureSession(key);
      let context = contexts.get(sessionId);
      if (!context) {
        context = { key, collector: createTurnCollector(), pendingUsers: [], reply: { kind: 'group', id: groupId } };
        contexts.set(sessionId, context);
      }
      context.reply = { kind: 'group', id: groupId };

      const personLine = personLineOf(last.userId);
      const parts = [`【现在】${localTimeText()}`];
      if (personLine) parts.push(`【最后说话的人】${last.sender}：${personLine}`);
      const catalog = stickers.labeled(15).map((entry) => `${entry.label}#${entry.id}`).join('、');
      parts.push(`【表情包】想发收藏的表情就写 [sticker:名字或编号]；想收藏刚收到的表情就写 [save-sticker:名字]。${catalog ? `\n你收藏的表情：${catalog}` : ''}`);
      const attState = att(key);
      const firstMeet = !state.sessions[key]?.greeted;
      if (firstMeet || attState.needsPersona) {
        parts.push(...identityParts(key, { persona: true, recentTalk: firstMeet }));
        if (firstMeet) {
          state.sessions[key] = { ...(state.sessions[key] || { sessionId }), greeted: true, updatedAt: Date.now() };
          writeState(state);
        }
        attState.needsPersona = false;
      }
      if (attState.pendingSnapshot) {
        // 优先用从 QQ 现场拉到的历史；拉不到才退回内存缓冲
        const snapText = attState.wakeHistory || recentContext(key, { maxItems: 14 });
        if (snapText) parts.push(`【你醒来前群里在聊】\n${snapText}`);
        attState.pendingSnapshot = false;
        attState.wakeHistory = '';
      }
      // 每轮都补一段「这之前聊了什么」，否则她被问「我刚才说了什么」只能翻旧会话
      {
        const history = historyContext(key, 8, items[0]?.t ?? Date.now());
        if (history) parts.push(`【这之前群里在聊】\n${history}`);
      }
      if (needsRecall(transcript)) {
        const recall = diaryRecall(diary, transcript, key);
        if (recall.block) parts.push(`【你想起来的旧事】\n${recall.block}`);
        if (recall.sensitive) {
          context.approvalRequired = true;
          context.approvalQuestion = transcript.slice(0, 200);
          context.approvalMessageId = String(last.messageId ?? '');
        }
      }
      const roster = [...new Map(items.map((item) => [item.userId, item.sender])).entries()]
        .map(([id, name]) => `${name}（${id}）`).join('、');
      const hint = writingHint(transcript);
      if (hint) parts.push(hint);
      // 爸爸说的话单独拎出来：夹在群里刷屏中间时，她容易只回最后一张图
      if (fromOwner) {
        const ownerLines = items.filter((item) => item.owner)
          .map((item) => item.text)
          .filter(Boolean)
          .join('\n');
        if (ownerLines.trim()) parts.push(`【爸爸刚说的】\n${ownerLines.slice(0, 600)}`);
      }
      parts.push(`【群里刚才聊了】\n${transcript}`);
      if (roster) parts.push(`【在场的人】${roster}；你是 ${SELF_QQ}。`);
      parts.push(`【先看清楚】你的 QQ 是 ${SELF_QQ}。@${SELF_QQ} 才是叫你；@别人是在叫别人。别人说的话、别人的事，不要认领成自己的。`);
      if (fromOwner) {
        // 爸爸在群里说话：默认当他在跟她讲，别再装没看见
        parts.push('【爸爸在群里说话】他在跟你讲话，接一句；没想接也说点短的，别当没看见。');
      }
      parts.push('【要不要接】没人明确叫你，接不接看你：有话就自然接一句，不想接就只回复 [SILENT]。别为了刷存在感硬插。');

      const promptText = parts.join('\n\n');
      context.pendingUsers.push({
        text: transcript,
        messageId: String(last.messageId ?? ''),
        stickerIds,
      });
      try {
        await sendPrompt(sessionId, promptText, imageParts);
      } catch (error) {
        context.pendingUsers.pop();
        throw error;
      }
      att(key).lastSeenAt = Date.now();
      att(key).lastCallAt = Date.now();
      log(`BATCH ${key} (${items.length} msgs, ${transcript.length} chars, images ${imageParts.length})`);
    } catch (error) {
      log(`batch error ${key}: ${error?.message ?? error}`);
    }
  }

  function personLineOf(userId) {
    try {
      const person = store.getPerson(`qq:${userId}`);
      return [
        person?.display ? `称呼：${person.display}` : '',
        person?.relation ? `关系：${person.relation}` : '',
        person?.attitude ? `你的态度：${person.attitude}` : '',
        person?.tone ? `语气：${person.tone}` : '',
        person?.taboos ? `禁忌：${person.taboos}` : '',
      ].filter(Boolean).join('；');
    } catch {
      return '';
    }
  }
  function nextProactive() {
    return Date.now() + (proactiveMin + Math.random() * (proactiveMax - proactiveMin)) * 60000;
  }

  const off = ctx.on('session/event', async (session, event) => {
    const context = contexts.get(session.id);
    if (!context) return;
    const done = context.collector.push(event);
    if (!done) return;
    const text = String(done.text ?? '').trim();
    // 带上字符数：以后她再自称「写了几百字」，日志里能直接对账
    log(`TURN END ${context.key} reason=${JSON.stringify(done.reason)} chars=${text.length} text=${text.slice(0, 120)}`);
    // 先出队再判断：空回复也要把这一条移走，否则后面的回复会引用错消息、收藏错表情
    const pending = context.pendingUsers.shift() ?? { text: '', messageId: '' };
    if (!text) {
      // 这一轮没说话，审批标记也要清掉，别留到下一轮误伤
      context.approvalRequired = false;
      log(`empty reply in ${context.key}, pending cleared`);
      return;
    }

    // 她可以选择回拍（[POKE]），再说别的
    let replyText = text;

    // 收藏刚收到的表情：[save-sticker:名字]（用这一轮对应的图片，避免被后续消息覆盖）
    const pendingStickerIds = Array.isArray(pending.stickerIds) ? pending.stickerIds.slice() : [];
    if (pendingStickerIds.length) {
      for (const match of text.matchAll(/\[save-sticker[:：]([^\]]+)\]/g)) {
        const label = String(match[1]).trim();
        const id = pendingStickerIds.shift();
        if (id) {
          stickers.label(id, label);
          log(`sticker saved "${label}" #${id}`);
        }
      }
    }
    replyText = replyText.replace(/\[save-sticker[:：][^\]]+\]/g, '').trim();

    // ── 敏感记忆审批闸门 ──
    // 别人问到了不属于当前会话的记忆：这一轮的回复先不发，私聊问主人要不要发。
    if (context.approvalRequired) {
      context.approvalRequired = false;
      const approvable = String(replyText)
        .replace(/\[POKE\]/gi, '')
        .replace(/\[回拍\]/g, '')
        .trim();
      if (!approvable) {
        // 只有拍一拍 / 纯沉默：没有说出任何记忆，照常走
        log(`sensitive recall but no text to approve in ${context.key}`);
      } else if (!approvalEnabled) {
        log(`sensitive recall, approval disabled -> send directly (${context.key})`);
      } else {
        context.approvalQuestion = context.approvalQuestion || (pending.text ? String(pending.text).slice(0, 200) : '');
        context.approvalMessageId = context.approvalMessageId || pending.messageId || '';
        await requestApproval(context, approvable);
        return;
      }
    }

    if (pending.poke) {
      const wantsPoke = /\[POKE\]/i.test(replyText) || /\[回拍\]/.test(replyText);
      replyText = replyText.replace(/\[POKE\]/gi, '').replace(/\[回拍\]/g, '').trim();
      if (wantsPoke && bot) {
        try {
          // SDK 的拍一拍是异步的，不 await 的话失败只会变成未处理的 rejection
          if (context.reply.kind === 'group') await bot.groupPoke(Number(context.reply.id), Number(pending.pokeFrom));
          else await bot.friendPoke(Number(pending.pokeFrom));
          log(`POKE back -> ${pending.pokeFrom}`);
        } catch (error) {
          log(`poke back failed: ${error?.message ?? error}`);
        }
      }
    }

    const sent = await sendReply(context.reply, replyText, pending.messageId).catch((error) => {
      log(`send failed: ${error?.message ?? error}`);
      return false;
    });

    const now = Date.now();
    if (context.reply.kind === 'group' && sent) {
      const a = att(context.key);
      a.awakeUntil = now + activeWindowMs;
      a.lastSeenAt = now;
      a.cooldownUntil = now + REPLY_COOLDOWN_MS;
      // 回完话后 5 分钟，跟同一个人继续对话（对齐旧版 preSleepWait）
      a.conversationUntil = now + activeWindowMs;
      if (context.lastUserId) a.engagedWith = context.lastUserId;
    }
    // 只有真的发出去才写进记忆；沉默和发送失败都不写“空回话”
    const choseSilence = !sent && (!replyText || /\[SILENT\]|\[潜水\]/i.test(replyText));
    if (sent) {
      const records = [{ t: now, key: context.key, platform: 'qq', conv: context.key, role: 'assistant', text: replyText, source: 's2' }];
      const result = store.appendMessages(records);
      rememberTalk(context.key, 'assistant', replyText);
      log(`remember ${context.key}: +${result.added} skipped=${result.skipped}`);
    } else if (choseSilence) {
      log(`she stayed silent in ${context.key}`);
      if (context.reply.kind === 'group') {
        // 沉默也退避一会儿，别让下一条普通消息马上又触发
        att(context.key).cooldownUntil = now + 30000;
      }
    } else {
      log(`reply not delivered in ${context.key}, not memorised`);
    }
    // 只有她真的说了话，才在安静 3 分钟后判断值不值得记；纯沉默不花这次钱
    if (sent) scheduleMemoryJudge(context.key);
  }, { global: true });

  /** 群聊引用第一条；多段话拆成多条发，模拟真人的分条节奏。[SILENT] = 她选择不说话。 */
  async function sendReply(reply, text, messageId) {
    const cleaned = String(text)
      .replace(/\[SILENT\]/gi, '')
      .replace(/\[潜水\]/g, '')
      .trim();
    if (!cleaned) {
      log('she chose silence');
      return false;
    }
    // 与旧 web 端一致：只按模型自己写的换行分条，桥接不做任何切句
    // 上限从 4 提到 8：让她写 800 字作文时，不会被拦腰砍掉一半。
    const MAX_BUBBLES = 8;
    const MAX_TOTAL_CHARS = 4000;
    const bubbles = [];
    let totalChars = 0;
    for (const raw of cleaned.split(/\n+/)) {
      const part = raw.trim();
      if (!part) continue;
      if (bubbles.length >= MAX_BUBBLES) break;
      if (bubbles.length && totalChars + part.length > MAX_TOTAL_CHARS) break;
      bubbles.push(part);
      totalChars += part.length;
    }
    if (!bubbles.length) return false;

    let delivered = 0;
    for (let index = 0; index < bubbles.length; index += 1) {
      const bubble = bubbles[index];
      const stickerSegments = [];
      const bubbleText = bubble
        .replace(/\[sticker[:：]([^\]]+)\]/g, (_, name) => {
          const entry = stickers.find(name);
          const buf = entry ? stickers.read(entry) : null;
          if (!buf) return '';
          stickerSegments.push({ type: 'image', data: { file: `base64://${buf.toString('base64')}` } });
          return '';
        })
        .trim();
      const faceSegments = bubbleText
        ? parseFaceSegments(bubbleText, (name) => log(`unknown face "${name}" dropped`))
        : [];
      const hasBody = faceSegments.some((segment) => (segment.type === 'face'
        ? true
        : String(segment.data?.text ?? '').trim().length > 0)) || stickerSegments.length > 0;
      if (!hasBody) continue;

      const segments = [];
      const hasQuote = index === 0 && reply.kind === 'group' && Boolean(messageId);
      if (hasQuote) {
        segments.push({ type: 'reply', data: { id: String(messageId) } });
      }
      segments.push(...faceSegments);
      segments.push(...stickerSegments);
      try {
        await sendSegments(reply, segments);
        delivered += 1;
        // 日志打「真正发出去的文本」，而不是带 [face:xxx] 标记的原文，否则排查时会误判
        const shown = segments
          .filter((segment) => segment.type === 'text' || segment.type === 'face')
          .map((segment) => (segment.type === 'face' ? `[face:${segment.data.id}]` : segment.data.text))
          .join('')
          .slice(0, 80) || '(非文本)';
        log(`SEND ${reply.kind}:${reply.id} #${index + 1}/${bubbles.length} quote=${hasQuote ? 'yes' : 'no'} stickers=${stickerSegments.length} -> ${shown}`);
      } catch (error) {
        log(`send failed, fallback text-only: ${error?.message ?? error}`);
        if (bubbleText) {
          try {
            await sendSegments(reply, [{ type: 'text', data: { text: bubbleText } }]);
            delivered += 1;
            log(`SEND ${reply.kind}:${reply.id} #${index + 1} text-only -> ${bubbleText.slice(0, 80)}`);
          } catch (fallbackError) {
            log(`text-only fallback failed: ${fallbackError?.message ?? fallbackError}`);
          }
        }
      }
      if (index < bubbles.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 350 + Math.floor(Math.random() * 450)));
      }
    }
    return delivered > 0;
  }

  async function sendSegments(reply, segments) {
    const result = reply.kind === 'group'
      ? await bot.sendGroupMessage(Number(reply.id), segments)
      : await bot.sendPrivateMessage(Number(reply.id), segments);
    // 记住自己这条消息的 id：以后别人「引用回复」她时才能认得出来
    const sentId = result?.message_id ?? result?.messageId
      ?? result?.data?.message_id ?? result?.data?.messageId;
    if (sentId) rememberOwnId(sentId);
    return result;
  }

  async function createSession(key) {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.mkdirSync(SESSION_CWD, { recursive: true });
    let created;
    try {
      created = await controller.create({ cwd: SESSION_CWD, agentPreset: PRESET });
    } catch (error) {
      log(`preset ${PRESET} failed (${error?.message ?? error}), fallback qq-chat-v2`);
      created = await controller.create({ cwd: SESSION_CWD, agentPreset: 'qq-chat-v2' });
    }
    state.sessions = { ...(state.sessions || {}), [key]: { sessionId: created.sessionId, updatedAt: Date.now(), greeted: false } };
    writeState(state);
    log(`created session ${created.sessionId} (key=${key})`);
    return created.sessionId;
  }

  async function ensureSession(key) {
    const mapped = state.sessions?.[key];
    if (mapped?.sessionId) return mapped.sessionId;
    return createSession(key);
  }

  async function sendPrompt(sid, text, images = []) {
    return controller.prompt({
      sessionId: sid,
      mode: 'queue',
      requestId: `s2-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      content: [{ type: 'text', text }, ...images],
    }, new AbortController().signal);
  }

  async function handleMessage(event, kind) {
    const selfId = String(event.self_id ?? '');
    const key = kind === 'private' ? `private:${event.user_id}` : `group:${event.group_id}`;
    if (kind === 'private') {
      if (!privateAllow.has(String(event.user_id))) { log(`skip non-whitelist private ${event.user_id}`); return; }
    } else {
      const groupId = String(event.group_id ?? '');
      if (!groups.includes(groupId)) { log(`skip group not whitelisted ${groupId}`); return; }
    }

    let text = textOf(event);
    if (!text.trim()) text = '（对方发了一条没有文字的消息）';

    // 主人回 1/2 处理待审批：这条命令不进对话，也不进记忆
    if (kind === 'private' && String(event.user_id) === OWNER_QQ && tryHandleApproval(text)) {
      log(`approval command "${text.trim().slice(0, 12)}" consumed`);
      return;
    }

    // 只有「跟她有关的」消息才写进库；休眠时路人聊天只在内存里留一段（见 rememberTalk）
    if (kind === 'group') {
      const groupId = String(event.group_id ?? '');
      log(`group event group=${groupId} from=${event.user_id} self=${selfId} msg=${JSON.stringify(event.message ?? event.raw_message ?? '').slice(0, 260)}`);
      const a = att(key);
      const wasAwake = a.awakeUntil > Date.now();
      const hasMedia = Array.isArray(event.message)
        && event.message.some((part) => part?.type === 'image' || part?.type === 'mface');
      const ownerMedia = hasMedia && String(event.user_id) === OWNER_QQ;
      // 爸爸在群里发文字也算「在跟她说话」。以前只把「发图」当信号，
      // 结果他在群里连说四五句，她一句都不接，非得 @ 才醒。
      // 「好吧」「嗯」「哦」这类应答不值得叫醒她（一次调用就为回它一个 [SILENT]）
      const OWNER_TRIVIAL = /^(?:好|好吧|嗯|嗯嗯|哦|噢|喔|行|行吧|可以|对|是的|真的|哈哈|草|6|1|2|ok)[。！!?～~]*$/i;
      const ownerText = !hasMedia
        && String(event.user_id) === OWNER_QQ
        && String(text).trim().length > 0
        && !OWNER_TRIVIAL.test(String(text).trim());
      const mentioned = isAwake(event, selfId, readWakeWords());
      // 只认「引用的是她自己发过的消息」。以前任何 reply 段都算「回复她」，
      // 别人互相引用也会把她叫醒，这是群里乱插话的主要来源之一。
      const repliedToHer = Array.isArray(event.message)
        && event.message.some((part) => part?.type === 'reply' && ownMessageIds.has(String(part.data?.id ?? '')));
      const picked = !mentioned && !wasAwake && Math.random() < wakeChance;
      if (!mentioned && !repliedToHer && !picked && !wasAwake && !ownerMedia && !ownerText) {
        // 她不在场：不落库，只在内存留一段给她醒来接上下文
        rememberTalk(key, 'user', text);
        log(`group ${groupId} 休眠中，不打扰（不入库）`);
        return;
      }
      // 跟她有关：落库 + 记入内存上下文
      store.appendMessages([{ t: Date.now(), key, platform: 'qq', conv: key, role: 'user', text, source: 's2' }]);
      rememberTalk(key, 'user', text);
      // 爸爸发的图片：直接入队合并，不再「攒着等她醒」。
      // 以前攒着，结果她醒来只看到图，看不到图前后那几段话 —— 那几段会被当成过场忽略。
      if (ownerMedia) {
        enqueueGroup(key, {
          text: textOf(event).trim() || '[图片]',
          sender: event.sender?.card || event.sender?.nickname || String(event.user_id),
          userId: String(event.user_id),
          messageId: String(event.message_id ?? ''),
          hasMedia: true,
          owner: true,
          t: Date.now(),
          event,
        });
        log(`group ${groupId} 爸爸发图：入队合并`);
        return;
      }
      if (mentioned || repliedToHer || picked) {
        if (!wasAwake) {
          a.pendingSnapshot = true;
          a.needsPersona = true; // 每次从睡着被叫醒，进 prompt 时重灌一次人设
          log(`wake ${groupId}（${mentioned ? '点名' : repliedToHer ? '回复她' : ownerMedia ? '爸爸发图' : '随机'}）`);
          // 醒来第一件事：从 QQ 往上翻最近的聊天记录（不落库，只在需要时拉）
          a.wakeHistory = await fetchGroupHistory(key, groupId, 12);
          if (a.wakeHistory) log(`wake history ${groupId}: ${a.wakeHistory.split('\n').length} 行`);
        }
        a.awakeUntil = Date.now() + activeWindowMs;
        a.engagedWith = String(event.user_id);
        a.conversationUntil = Date.now() + activeWindowMs;
        // 把攒着的普通群消息先处理掉，避免重复回
        await flushGroup(key);
      } else {
        // 没被点名，但她刚说过话、群里还在聊，或者爸爸在说话：消息送进模型，让她自己判断接不接。
        // 节流交给合并队列（15 秒）和回复冷却（20 秒），不再用「45 秒一次」把话砍掉。
        const nowMs = Date.now();
        const inConversation = nowMs < (a.conversationUntil || 0);
        if (!inConversation && !ownerText) {
          log(`group ${groupId} 不在对话窗口，跳过（不进模型）`);
          return;
        }
        enqueueGroup(key, {
          text: textOf(event).trim() || '（图片/表情）',
          sender: event.sender?.card || event.sender?.nickname || String(event.user_id),
          userId: String(event.user_id),
          messageId: String(event.message_id ?? ''),
          hasMedia,
          owner: ownerText,
          t: nowMs,
          event,
        });
        // 爸爸发文字：4 秒就合并（他在等你回话），其他人用默认窗口
        log(`group ${groupId} ${ownerText ? '爸爸说话' : '对话窗口内'}入队（${textOf(event).trim().slice(0, 40) || '图片'}）`);
        return;
      }
    }

    // 私聊：先攒 2.5 秒，连发的几条合成一次再交给模型
    if (kind === 'private') {
      const privateSender = String(event.user_id) === OWNER_QQ
        ? '主人'
        : (event.sender?.card || event.sender?.nickname || String(event.user_id));
      log(`RECV ${key} (${privateSender}): ${text.slice(0, 140)}`);
      // 私聊全是冲她来的，直接落库
      store.appendMessages([{ t: Date.now(), key, platform: 'qq', conv: key, role: 'user', text, source: 's2' }]);
      rememberTalk(key, 'user', text);
      enqueuePrivate(key, { event, text, sender: privateSender });
      return;
    }

    const sender = event.sender?.card || event.sender?.nickname || String(event.user_id);
    const replyId = String(event.group_id);
    log(`RECV ${key} (${sender}): ${text.slice(0, 140)}`);

    await dispatchMessage({
      key,
      kind,
      replyId,
      userId: String(event.user_id),
      sender,
      text,
      imageEvents: [event],
      messageId: String(event.message_id ?? ''),
      groupId: kind === 'group' ? String(event.group_id ?? '') : '',
    });
  }

  /** 把一条（或合并后的几条）消息交给模型。群里单条消息、私聊连发合并都走这里。 */
  async function dispatchMessage({ key, kind, replyId, userId, sender, text, imageEvents, messageId, groupId }) {
    try {
      // 第一次见到这个人就建档，面板里能看到、能编辑
      try {
        const personId = `qq:${userId}`;
        if (!store.getPerson(personId)) {
          store.upsertPerson(personId, {
            platform: 'qq',
            kind: kind === 'group' ? 'group' : 'private',
            display: String(sender),
          });
        }
      } catch (error) {
        log(`person upsert failed: ${error?.message ?? error}`);
      }

      const sessionId = await ensureSession(key);
      let context = contexts.get(sessionId);
      if (!context) {
        context = { key, collector: createTurnCollector(), pendingUsers: [], reply: { kind, id: replyId } };
        contexts.set(sessionId, context);
      } else {
        context.reply = { kind, id: replyId };
      }
      context.lastUserId = String(userId);

      let personLine = '';
      try {
        const person = store.getPerson(`qq:${userId}`);
        const bits = [
          person?.display ? `称呼：${person.display}` : '',
          person?.relation ? `关系：${person.relation}` : '',
          person?.attitude ? `你的态度：${person.attitude}` : '',
          person?.tone ? `说话语气：${person.tone}` : '',
          person?.taboos ? `禁忌：${person.taboos}` : '',
          person?.notes ? `备注：${person.notes}` : '',
        ].filter(Boolean);
        if (bits.length) personLine = bits.join('；');
      } catch {}
      const lastRows = store.searchMessages({ key, limit: 1 });
      const gapText = lastRows.length ? humanGap(Date.now() - lastRows[0].t) : '第一次说话';
      const wasGreeted = Boolean(state.sessions[key]?.greeted);

      const parts = [`【现在】${localTimeText()}（距上次对话：${gapText}）`];
      if (personLine) parts.push(`【你对 Ta 的印象】${personLine}`);
      const attState = kind === 'group' ? att(key) : null;
      const firstMeet = !wasGreeted;
      if (kind === 'private' || firstMeet || attState?.needsPersona) {
        // 私聊每条消息都重灌人设（旧 web 端行为）；「最近记得的事」只在新会话开场带一次，避免每轮重复
        parts.push(...identityParts(key, { persona: firstMeet || Boolean(attState?.needsPersona), recent: firstMeet || Boolean(attState?.needsPersona), recentTalk: firstMeet }));
        if (firstMeet) {
          state.sessions[key] = { ...(state.sessions[key] || { sessionId }), greeted: true, updatedAt: Date.now() };
          writeState(state);
        }
        if (attState) attState.needsPersona = false;
      }
      if (attState?.pendingSnapshot) {
        // 同上：优先用现场拉到的历史
        const snapText = attState.wakeHistory || recentContext(key, { maxItems: 14 });
        if (snapText) parts.push(`【你醒来前群里在聊】\n${snapText}`);
        attState.pendingSnapshot = false;
        attState.wakeHistory = '';
      }
      if (kind === 'group') {
        // 每轮都补一段「这之前聊了什么」（排除当前这条）
        const history = historyContext(key, 8, Date.now() - 1000);
        if (history) parts.push(`【这之前群里在聊】\n${history}`);
      }
      // 只有出现回忆信号时才翻长期记忆
      if (needsRecall(text)) {
        const recall = diaryRecall(diary, text, key);
        if (recall.block) parts.push(`【你想起来的旧事】\n${recall.block}`);
        // 别人问到了不属于当前会话的记忆：这一轮回话先压住，等主人点头
        if (recall.sensitive) {
          context.approvalRequired = true;
          context.approvalQuestion = `${sender}：${text}`.slice(0, 200);
          context.approvalMessageId = String(messageId ?? '');
        }
      }
      if (kind === 'group') {
        // 群里的单条消息（@她/被引用/随机唤醒）走的也是这里，
        // 以前只有合并批次那条路径会写「你是 <自己的 QQ>」，所以 @ 她时她反而认不清谁是谁。
        parts.push(`【在场的人】${sender}（${userId}）；你是 ${SELF_QQ}。`);
        parts.push(`【先看清楚】你的 QQ 是 ${SELF_QQ}。@${SELF_QQ} 才是叫你；@别人是在叫别人。别人说的话、别人的事，不要认领成自己的。`);
        if (String(userId) === OWNER_QQ) {
          parts.push('【爸爸在群里说话】他在跟你讲，接一句；没想接也说点短的，别当没看见。');
        }
      }
      // 私聊接不上群里刚说的话：把最近的群聊也给她看（群和私聊是两个会话，互不串台）
      if (kind === 'private') {
        const groupTalk = groupContextAll(8);
        if (groupTalk) parts.push(`【你刚才在群里聊的】\n${groupTalk}`);
      }
      const hint = writingHint(text);
      if (hint) parts.push(hint);
      // 私聊里问「谁找过我」：「私聊没人找」是事实，但群里可能有人找过她。
      // 她看不到群聊上下文，这里把 store 里的原始消息捞出来给她。
      if (kind === 'private' && LOOKUP_ASK.test(text)) {
        const mentions = groupMentionsOf(store, 24, 12);
        if (mentions.length) parts.push(`【最近 24 小时群里有人找你】\n${formatMentions(mentions)}`);
      }
      const header = kind === 'group'
        ? `【谁在说】${sender}（QQ ${userId}，群 ${groupId}）`
        : `【谁在说】${sender}（QQ ${userId}，私聊）`;
      // 把休眠期间攒下的爸爸图片一起带上
      const pendingMedia = kind === 'group' ? (att(key).pendingMedia || []) : [];
      if (pendingMedia.length) att(key).pendingMedia = [];
      const imageParts = [];
      const collectedIds = [];
      for (const mediaEvent of [...pendingMedia, ...imageEvents]) {
        if (imageParts.length >= 4) break;
        const collected = await collectImageParts(mediaEvent, stickers, key, bot).catch(() => ({ parts: [], ids: [] }));
        for (const part of collected.parts) { if (imageParts.length < 4) imageParts.push(part); }
        collectedIds.push(...collected.ids);
      }
      const catalog = stickers.labeled(15).map((entry) => `${entry.label}#${entry.id}`).join('、');
      parts.push(`【表情包】想发收藏的表情就写 [sticker:名字或编号]；想收藏刚收到的表情就写 [save-sticker:名字]。${catalog ? `\n你收藏的表情：${catalog}` : '\n（你还没收藏过表情）'}`);
      const imageNote = imageParts.length ? `【对方发了 ${imageParts.length} 张图片/表情，图片已附上】\n` : '';
      const promptText = `${parts.join('\n\n')}\n\n${header}\n【现在对方说】\n${imageNote}${text}`;

      context.pendingUsers.push({ text, messageId: String(messageId ?? ''), stickerIds: collectedIds });
      try {
        await sendPrompt(sessionId, promptText, imageParts);
      } catch (error) {
        // 没送出去就别留一条待处理，否则下一次回复会引用错消息
        context.pendingUsers.pop();
        const message = String(error?.message ?? error);
        if (!/not[- ]?found|ApiSessionNotFound/i.test(message)) throw error;
        log(`mapped session gone, recreate ${key}`);
        delete state.sessions[key];
        writeState(state);
        const fresh = await createSession(key);
        contexts.delete(sessionId);
        contexts.set(fresh, { key, collector: createTurnCollector(), pendingUsers: [{ text, messageId: String(messageId ?? '') }], reply: { kind, id: replyId } });
        await sendPrompt(fresh, promptText, imageParts);
      }
      if (kind === 'group') {
        att(key).lastSeenAt = Date.now();
        att(key).lastCallAt = Date.now();
      }
      log(`prompt accepted ${key} (${promptText.length} chars)`);
    } catch (error) {
      log(`handle error: ${error?.message ?? error} code=${error?.code ?? error?.details?.code ?? ''} reason=${error?.reason ?? error?.details?.reason ?? ''} raw=${JSON.stringify(error).slice(0, 400)}`);
    }
  }

  /** 被拍不是自动回拍，而是当成一条消息交给她：回拍、说话、或无视，由她决定。 */
  async function handlePoke(event) {
    const from = String(event.user_id ?? '');
    const kind = event.group_id ? 'group' : 'private';
    const key = kind === 'group' ? `group:${event.group_id}` : `private:${from}`;
    const replyId = kind === 'group' ? String(event.group_id) : from;
    const sender = event.sender?.card || event.sender?.nickname || from;
    const where = kind === 'group' ? `群 ${event.group_id}` : '私聊';
    store.appendMessages([{ t: Date.now(), key, platform: 'qq', conv: key, role: 'user', text: '（拍了拍你）', source: 's2' }]);
    if (kind === 'group') {
      // 被拍 = 群里有人找她，进入清醒窗口；先把攒着的消息处理掉
      att(key).awakeUntil = Date.now() + activeWindowMs;
      await flushGroup(key);
    } else {
      // 私聊：先把攒着的连发消息放出去，别让拍一拍插到它们前面
      await flushPrivate(key);
    }
    const sessionId = await ensureSession(key);
    let context = contexts.get(sessionId);
    if (!context) {
      context = { key, collector: createTurnCollector(), pendingUsers: [], reply: { kind, id: replyId } };
      contexts.set(sessionId, context);
    }
    context.reply = { kind, id: replyId };
    context.pendingUsers.push({ text: '（拍了拍你）', messageId: '', poke: true, pokeFrom: from });
    const pokeParts = [`【现在】${localTimeText()}`];
    if (!state.sessions[key]?.greeted) {
      // 新会话第一次就被拍：先把身份和近期记忆给她，否则她不知道自己是谁
      pokeParts.push(...identityParts(key, { recentTalk: true }));
      state.sessions[key] = { ...(state.sessions[key] || { sessionId }), greeted: true, updatedAt: Date.now() };
      writeState(state);
    }
    pokeParts.push(
      '【发送方式】直接写要发的话；只想拍回去就只输出 [POKE]；不想理就只输出 [SILENT]。想发表情可以写 [face:名字]。',
      `【事件】${sender} 在${where}拍了拍你。`,
      '【要不要回应】拍回去、说句话、或者不理，你自己决定。',
    );
    const promptText = pokeParts.join('\n\n');
    await sendPrompt(sessionId, promptText);
    log(`POKE event ${key} from ${from} -> prompt`);
  }

  async function proactiveCheck() {
    if (disposed || !bot) return;
    const now = Date.now();
    for (const groupId of groups) {
      const key = `group:${groupId}`;
      const a = att(key);
      if (a.awakeUntil > now) continue;
      if (now < (proactiveAt.get(key) ?? 0)) continue;
      proactiveAt.set(key, nextProactive());
      const last = store.searchMessages({ key, limit: 1 })[0];
      if (!last || now - last.t > 20 * 60000) continue;
      if (last.t <= (a.lastSeenAt ?? 0)) continue;
      // 主动看群也只看「刚才这段连续对话」
      const snap = recentContext(key, { maxItems: 20, maxAgeMs: 2 * 3600000 });
      if (!snap) continue;
      try {
        const sessionId = await ensureSession(key);
        let context = contexts.get(sessionId);
        if (!context) {
          context = { key, collector: createTurnCollector(), pendingUsers: [], reply: { kind: 'group', id: groupId } };
          contexts.set(sessionId, context);
        }
        context.reply = { kind: 'group', id: groupId };
        context.pendingUsers.push({ text: '', messageId: '', proactive: true });
        const parts = [`【现在】${localTimeText()}`];
        if (!state.sessions[key]?.greeted) {
          // 新会话第一次就被动看群：先给身份，否则她只是在念一段群聊
          parts.push(...identityParts(key, { recentTalk: true }));
          state.sessions[key] = { ...(state.sessions[key] || { sessionId }), greeted: true, updatedAt: Date.now() };
          writeState(state);
        }
        parts.push(
          '【发送方式】直接写要发的话；不想说、没什么可接的，就只回复 [SILENT]。想发表情可以写 [face:名字]。',
          `【你正在群里潜水】群里刚才聊了：\n${snap}`,
          '【要不要说话】想接就自然接一句；不想接只回复 [SILENT]。不要为了说话而说话。',
        );
        const promptText = parts.join('\n\n');
        try {
          await sendPrompt(sessionId, promptText);
        } catch (error) {
          context.pendingUsers.pop();
          throw error;
        }
        log(`PROACTIVE ${key} (${snap.length} chars)`);
      } catch (error) {
        log(`proactive failed ${key}: ${error?.message ?? error}`);
      }
    }

  }

  let connectFailures = 0;
  let reconnectTimer = null;
  let botOpened = false;

  /**
   * 初始连接失败时的兜底重连。
   * SDK 自己也带 reconnect:true 会重试，所以这里只在「确实没连上」时动手：
   * 已经 open 就什么都不做，避免把 SDK 刚建好的连接又关掉。
   */
  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    const delay = Math.min(5 * 60000, 30000 * 2 ** Math.min(connectFailures, 3));
    connectFailures += 1;
    log(`reconnect scheduled in ${Math.round(delay / 1000)}s (failure #${connectFailures})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (disposed || botOpened) return;
      try { bot?.close?.(); } catch {}
      bot = null;
      connect();
    }, delay);
  }

  function connect() {
    if (disposed) return;
    let endpoint;
    try {
      endpoint = readSnowLumaEndpoint();
    } catch (error) {
      // 早先这里会一路抛到 bootstrap，桥接直接死掉且永不重试
      log(`read SnowLuma endpoint failed: ${error?.message ?? error}`);
      scheduleReconnect();
      return;
    }
    log(`connecting ${endpoint.url}（token ${endpoint.accessToken.slice(0, 4)}…）`);
    try {
      bot = new SnowLumaWebSocketClient({ url: endpoint.url, accessToken: endpoint.accessToken, reconnect: true, webSocket: WebSocketImpl });
      bot.on('open', () => { botOpened = true; connectFailures = 0; log('SnowLuma WS open'); });
      bot.on('close', (info) => { botOpened = false; log(`SnowLuma WS close ${JSON.stringify(info ?? {})}`.slice(0, 160)); });
      bot.on('error', (error) => log(`SnowLuma WS error: ${error?.message ?? error}`));
      bot.onPrivateMessage((event) => {
        if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
        handleMessage(event, 'private').catch((error) => log(`private error: ${error?.message ?? error}`));
      });
      bot.onGroupMessage((event) => {
        if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
        handleMessage(event, 'group').catch((error) => log(`group error: ${error?.message ?? error}`));
      });
      bot.onNotice((event) => {
        try {
          const isPoke = event?.notice_type === 'poke'
            || (event?.notice_type === 'notify' && event?.sub_type === 'poke');
          if (!isPoke) return;
          const selfId = String(event.self_id ?? '');
          const target = String(event.target_id ?? '');
          if (target && target !== selfId) return;
          const from = String(event.user_id ?? '');
          if (!from || from === selfId) return;
          handlePoke(event).catch((error) => log(`poke error: ${error?.message ?? error}`));
        } catch (error) {
          log(`poke error: ${error?.message ?? error}`);
        }
      });
      bot.connect().catch((error) => {
        log(`connect failed: ${error?.message ?? error}`);
        // SDK 的 reconnect:true 通常已经自己重试；这里只是记录，兜底定时器在 scheduleReconnect 里判断
        scheduleReconnect();
      });
    } catch (error) {
      log(`connect threw: ${error?.message ?? error}`);
      scheduleReconnect();
    }
  }

  connect();
  for (const groupId of groups) proactiveAt.set(`group:${groupId}`, nextProactive());
  const proactiveTimer = setInterval(() => {
    proactiveCheck().catch((error) => log(`proactive error: ${error?.message ?? error}`));
  }, 60000);
  // 每小时检查一次「今天备份过没有」，当天已有就跳过
  const backupTimer = setInterval(runMemorySync, 3600000);
  // 记忆不再定时全量扫描：每轮结束后由 scheduleMemoryJudge 按事件判断
  ctx.effect(() => () => {
    disposed = true;
    try { clearInterval(proactiveTimer); } catch {}
    try { clearInterval(backupTimer); } catch {}
    try { if (reconnectTimer) clearTimeout(reconnectTimer); } catch {}
    try {
      for (const timer of memoryTimers.values()) clearTimeout(timer);
      memoryTimers.clear();
    } catch {}
    try {
      for (const buf of privateBuffers.values()) { if (buf.timer) clearTimeout(buf.timer); }
      privateBuffers.clear();
    } catch {}
    try {
      for (const approval of pendingApprovals.values()) { if (approval.timer) clearTimeout(approval.timer); }
      pendingApprovals.clear();
    } catch {}
    try { off(); } catch {}
    try { bot?.close?.(); } catch {}
    log('disposed');
  }, 'fish-bridge-s2: cleanup');
}
