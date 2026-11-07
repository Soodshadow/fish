// QQ 管理工具 MCP server（stdio）。
// 给桥接的 agent 用：改资料/状态/说说/撤回/点赞 + 好友申请处理。
// 所有调用走 OneBot HTTP API（config.json 的 snowluma.httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function oneBotConfig() {
  const c = loadConfig();
  return {
    httpUrl: String(c.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    accessToken: String(c.snowluma?.accessToken || '')
  };
}

async function onebot(action, params = {}) {
  const { httpUrl, accessToken } = oneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(params)
  });
  const json = await res.json().catch(() => ({}));
  if (json.status === 'failed' || json.retcode !== 0) {
    throw new Error(`${action} 失败: ${json.wording || JSON.stringify(json)}`);
  }
  return json.data;
}

const server = new McpServer({ name: 'qq-admin', version: '0.1.0' });

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

server.tool(
  'qq_set_online_status',
  '设置机器人 QQ 的在线状态。只有在用户明确要求时调用。status 可选：online(在线) away(离开) busy(忙碌) invisible(隐身)。',
  { status: z.enum(['online', 'away', 'busy', 'invisible']) },
  async ({ status }) => {
    const map = { online: 10, away: 30, busy: 50, invisible: 40 };
    await onebot('set_online_status', { status: map[status] });
    return ok(`已切换在线状态为 ${status}`);
  }
);

server.tool(
  'qq_post_qzone',
  '发一条 QQ 空间说说。只有在用户明确要求、并确认内容后才调用。',
  { content: z.string().min(1).max(2000) },
  async ({ content }) => {
    await onebot('send_qzone_msg', { content });
    return ok('说说已发布');
  }
);

server.tool(
  'qq_set_nickname',
  '修改机器人 QQ 的昵称。只有在用户明确要求时调用。',
  { nickname: z.string().min(1).max(32) },
  async ({ nickname }) => {
    await onebot('set_qq_profile', { nickname });
    return ok(`昵称已改为 ${nickname}`);
  }
);

server.tool(
  'qq_set_avatar',
  '修改机器人 QQ 的头像。只有管理员明确要求时调用。file 传本地图片路径、http(s) 链接或 base64://。',
  { file: z.string().min(1) },
  async ({ file }) => {
    await onebot('set_qq_avatar', { file });
    return ok('头像已更新');
  }
);

server.tool(
  'qq_set_profile',
  '修改机器人 QQ 的资料（昵称/签名等）。只在管理员明确要求时调用；未提供的字段不改。',
  {
    nickname: z.string().min(1).max(32).optional(),
    signature: z.string().max(200).optional(),
    sex: z.enum(['male', 'female', 'unknown']).optional()
  },
  async ({ nickname, signature, sex }) => {
    const params = {};
    if (nickname) params.nickname = nickname;
    if (signature) params.signature = signature;
    if (sex) params.sex = sex === 'unknown' ? 0 : sex === 'male' ? 1 : 2;
    if (!Object.keys(params).length) throw new Error('至少要提供一个字段');
    await onebot('set_qq_profile', params);
    return ok(`资料已更新：${JSON.stringify(params)}`);
  }
);

server.tool(
  'qq_delete_msg',
  '撤回一条消息（自己发的或对方发的，视权限而定）。',
  { messageId: z.union([z.string(), z.number()]) },
  async ({ messageId }) => {
    await onebot('delete_msg', { message_id: messageId });
    return ok(`已撤回消息 ${messageId}`);
  }
);

server.tool(
  'qq_send_like',
  '给好友的 QQ 名片点赞。',
  { userId: z.union([z.string(), z.number()]), times: z.number().int().min(1).max(20).default(1) },
  async ({ userId, times }) => {
    await onebot('send_like', { user_id: userId, times });
    return ok(`已给 ${userId} 点赞 ${times} 次`);
  }
);

server.tool(
  'qq_set_msg_emoji_like',
  '给某条消息加表情回应（QQ 的“表情点赞”）。',
  { messageId: z.union([z.string(), z.number()]), emojiId: z.string().min(1) },
  async ({ messageId, emojiId }) => {
    await onebot('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId });
    return ok(`已给消息 ${messageId} 加表情回应 ${emojiId}`);
  }
);

// ── 好友申请处理 ─────────────────────────────────────────────────────

server.tool(
  'qq_get_friend_requests',
  '查看待处理的好友申请（普通申请 + 可疑/陌生人申请）。返回列表，每项含 flag、申请人、验证消息。',
  {},
  async () => {
    const lines = [];
    // 1) 桥接监听到的普通好友申请（onRequest 落盘）
    try {
      const file = path.join(ROOT, 'state', 'friend-requests.json');
      if (fs.existsSync(file)) {
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(arr)) {
          for (const r of arr) {
            lines.push(`[普通] ${r.userId ?? r.user_id ?? '未知'} | flag=${r.flag ?? ''} | ${r.comment ?? ''} | ${new Date(r.time).toLocaleString('zh-CN')}`);
          }
        }
      }
    } catch {}
    // 2) SnowLuma 的可疑/陌生人申请接口
    try {
      const data = await onebot('get_doubt_friends_add_request', {});
      const list = Array.isArray(data) ? data : (data?.requests ?? data?.list ?? []);
      for (const r of list) {
        const who = r.nickname || r.uin || r.user_id || r.uid || '未知';
        const msg = r.message || r.comment || r.verify || '';
        lines.push(`[可疑] ${who} | flag=${r.flag ?? ''} | ${msg}`);
      }
    } catch {}
    if (!lines.length) return ok('当前没有待处理的好友申请');
    return ok(`待处理好友申请 ${lines.length} 条：\n${lines.join('\n')}`);
  }
);

server.tool(
  'qq_handle_friend_request',
  '处理一条好友申请：同意(approve=true)或拒绝(false)。flag 从 qq_get_friend_requests 取。只在管理员明确要求时调用。',
  {
    flag: z.string().min(1),
    approve: z.boolean(),
    remark: z.string().max(32).optional()
  },
  async ({ flag, approve, remark }) => {
    const params = { flag, approve };
    if (remark) params.remark = remark;
    await onebot('set_friend_add_request', params);
    return ok(`已${approve ? '同意' : '拒绝'}好友申请（flag=${flag}）`);
  }
);

server.tool(
  'qq_delete_friend',
  '删除一个好友。只在管理员明确要求时调用。',
  { userId: z.union([z.string(), z.number()]) },
  async ({ userId }) => {
    await onebot('delete_friend', { user_id: userId });
    return ok(`已删除好友 ${userId}`);
  }
);

server.tool(
  'qq_set_friend_remark',
  '修改好友备注。',
  { userId: z.union([z.string(), z.number()]), remark: z.string().min(1).max(32) },
  async ({ userId, remark }) => {
    await onebot('set_friend_remark', { user_id: userId, remark });
    return ok(`已把 ${userId} 的备注改为 ${remark}`);
  }
);

await server.connect(new StdioServerTransport());
