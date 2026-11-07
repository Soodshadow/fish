// fish/components/bridge/index.js
// ★ 桥接组件（阶段 1：最小版本）
// 目标：在 DSH 进程内直连 OneBot WebSocket，收 QQ 消息，为后续投递会话做准备。
//
// 当前能力：
//   - 连接 OneBot WS（Node 24 内置 WebSocket）
//   - 收到消息事件 → 解析（群/私聊/发送者/内容）→ 打印日志
//   - 发送文本（HTTP）
// 未做：投递到 DSH 会话（阶段 1 下一步）、群/媒体/唤醒（阶段 2）

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = 'D:\\fish\\qq-bridge\\config.json';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 读取 OneBot WS 的 accessToken（在 SnowLuma 的 onebot 配置里，和 HTTP token 不同）。 */
function loadWsToken() {
  try {
    const snowDir = loadConfig()?.snowluma?.homeDir ?? 'D:\\fish\\snow';
    const onebotDir = path.join(snowDir, 'config');
    const files = fs.readdirSync(onebotDir).filter((n) => n.startsWith('onebot_') && n.endsWith('.json'));
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(onebotDir, f), 'utf8'));
        const ws = j?.networks?.wsServers?.[0];
        if (ws?.accessToken) return String(ws.accessToken);
      } catch {}
    }
  } catch {}
  return '';
}

export default {
  name: 'bridge',
  version: '0.1.0',
  dependencies: ['qq-channel'],

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = loadConfig();
    this.ws = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.messageCount = 0;
  },

  async start(ctx) {
    this.ctx = ctx;
    this.stopped = false;
    this.connect().catch((error) => {
      console.log(`[bridge] 首次连接失败: ${error?.message ?? error}`);
    });
    // 阶段 1 核心验证：延迟 20 秒投递一条测试消息，验证「投递→kick→处理」闭环
    // 临时硬编码（测试期），验证通过后改为真实消息触发
    if (this.ctx) {
      setTimeout(() => {
        this.testDeliver('你好，这是一条测试消息').catch((error) => {
          console.log(`[bridge-test] 异常: ${error?.message ?? error}`);
        });
      }, 20000);
    }
  },

  onebot() {
    const c = this.cfg?.snowluma ?? {};
    return {
      httpUrl: String(c.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      wsUrl: String(c.wsUrl || 'ws://127.0.0.1:3001').replace(/\/+$/, ''),
      accessToken: String(c.accessToken || '')
    };
  },

  async connect() {
    if (this.stopped) return;
    const { wsUrl } = this.onebot();
    const wsToken = loadWsToken();
    const url = wsToken
      ? `${wsUrl}/?access_token=${encodeURIComponent(wsToken)}`
      : wsUrl;
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        console.log(`[bridge] OneBot WS 已连接: ${wsUrl}`);
      };
      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data ?? ''));
          this.onEvent(payload);
        } catch {
          // 非 JSON 帧忽略
        }
      };
      ws.onclose = () => {
        console.log('[bridge] OneBot WS 断开，3 秒后重连');
        this.ws = null;
        if (!this.stopped) {
          this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), 3000);
        }
      };
      ws.onerror = () => {
        // onclose 会跟进重连
      };
    } catch (error) {
      console.log(`[bridge] WS 连接异常: ${error?.message ?? error}`);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), 3000);
      }
    }
  },

  onEvent(payload) {
    const postType = payload?.post_type;
    if (postType !== 'message') return;
    this.messageCount += 1;
    const type = payload.message_type;
    const groupId = payload.group_id;
    const userId = payload.sender?.user_id ?? payload.user_id;
    const raw = payload.raw_message ?? payload.message ?? '';
    const key = type === 'group' ? `group:${groupId}` : `private:${userId}`;
    console.log(`[bridge] 收到消息 #${this.messageCount} [${key}] ${String(raw).slice(0, 60)}`);
    // 阶段 1 下一步：投递到 DSH 会话（session.append inbox）
  },

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
    this.ws = null;
  },

  // ── 阶段 1 核心验证：投递消息到 DSH 会话并触发处理 ──────────────────
  async testDeliver(text = '你好，这是一条测试消息') {
    const ctx = this.ctx;
    try {
      const sessions = ctx.get('sessions');
      const agents = ctx.get('agents');
      if (!sessions || !agents) throw new Error('sessions/agents 服务不可用');

      const id = `probe-${Date.now()}`;
      console.log(`[bridge-test] 创建会话 ${id} ...`);
      const agent = await sessions.create(id, { cwd: 'D:\\fish\\qq-bridge\\state\\agents' });
      console.log(`[bridge-test] 会话已创建，agent=${typeof agent}`);

      const session = sessions.get(id);
      if (!session) throw new Error('sessions.get 返回空');
      console.log(`[bridge-test] session.append=${typeof session.append}`);

      // 构造 user message（DSH 消息格式）
      const message = {
        id: (globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}`),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' }
      };
      // 投递到 inbox（next-turn）
      console.log('[bridge-test] 已投递 inbox，开始 kick ...');

      // 排查：agent 和 session 是否关联
      const agentSession = agent?.session;
      console.log(`[bridge-test] agent.session 存在=${!!agentSession} 同一对象=${agentSession === session}`);
      console.log(`[bridge-test] agent.id=${agent?.id ?? '?'} sessionId=${session?.header?.id ?? session?.id ?? '?'}`);
      const inboxState = (() => {
        try {
          const proj = session.projections?.get?.('inbox') ?? session.projections?.inbox;
          return JSON.stringify(proj ?? null).slice(0, 200);
        } catch { return 'n/a'; }
      })();
      console.log(`[bridge-test] inbox 投影=${inboxState}`);
      // 投递到 agent.session（如果和 get 的不一样）
      const deliverSession = agentSession ?? session;
      deliverSession.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
      console.log('[bridge-test] 已投递到 agent.session，开始 kick ...');

      // 捕获回复：kick 完成后直接读会话消息（deriveMessages）
      try {
        await agent.kick?.();
      } catch (error) {
        console.log(`[bridge-test] kick 异常: ${error?.message ?? error}`);
      }
      let msgs = [];
      try {
        msgs = deliverSession.deriveMessages?.() ?? [];
      } catch (e) {
        console.log(`[bridge-test] deriveMessages 失败: ${e?.message ?? e}`);
      }
      const texts = [];
      for (const m of msgs) {
        const parts = Array.isArray(m?.content) ? m.content : [];
        const text = parts.filter((p) => p?.type === 'text').map((p) => String(p.text ?? '')).join(' ');
        if (text) texts.push(`[${m.role}] ${text.slice(0, 120)}`);
      }
      console.log(`[bridge-test] kick 完成，会话消息=${msgs.length} 条`);
      console.log(`[bridge-test] 最近消息: ${texts.slice(-3).join(' || ') || '(空)'}`);
      return { ok: true, messages: msgs.length, texts: texts.slice(-3) };
    } catch (error) {
      console.log(`[bridge-test] 失败: ${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  async health() {
    return {
      connected: this.ws?.readyState === 1,
      messages: this.messageCount
    };
  }
};
