// 代办任务 MCP server（stdio）。
// 给 QQ 桥接的 agent 用：当任务需要本地工具（文件/命令/代码）而自己没有时，
// 通过 delegate_task 派给桥接，由完整 DSH agent 执行并返回结果。
//
// 调用链：小鱼 → delegate_task(task) → 桥接 /api/delegate → DSH worker 会话 → 结果
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readConsoleToken() {
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function bridgeBase() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const port = Number(cfg.consolePort || cfg.port || 3100);
    return `http://127.0.0.1:${port}`;
  } catch {
    return 'http://127.0.0.1:3100';
  }
}

async function delegate(task, agentToken) {
  const token = readConsoleToken();
  if (!token) throw new Error('缺少控制台令牌（state/console-token）');
  const res = await fetch(`${bridgeBase()}/api/delegate?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(agentToken ? { 'x-agent-token': agentToken } : {})
    },
    body: JSON.stringify({ task })
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 403) {
    throw new Error(json.error || '仅管理员私聊可用');
  }
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `桥接返回 ${res.status}`);
  }
  return String(json.output ?? '');
}

const server = new McpServer({ name: 'delegate', version: '0.1.0' });

server.tool(
  'delegate_task',
  '把需要本地能力的任务（读写文件、执行命令、查看系统、写代码等）派给完整 DSH agent 执行，等结果返回。只有管理员本人的私聊会话可用；其它会话调用会被拒绝。任务描述要具体（目标、路径、期望输出）。必须传 token（当前会话令牌）。',
  {
    task: z.string().min(1).max(4000),
    token: z.string().min(1).describe('当前会话令牌（提示里的【会话令牌】）')
  },
  async ({ task, token }) => {
    try {
      const output = await delegate(task, token);
      return { content: [{ type: 'text', text: output || '（代办完成，但没有返回内容）' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `代办失败：${error?.message ?? String(error)}` }], isError: true };
    }
  }
);

server.tool(
  'delegate_status',
  '检查代办通道是否可用（桥接在线 + DSH 就绪）。',
  {},
  async () => {
    try {
      const token = readConsoleToken();
      const res = await fetch(`${bridgeBase()}/api/status?token=${encodeURIComponent(token)}`);
      const json = await res.json().catch(() => ({}));
      return { content: [{ type: 'text', text: `桥接 ${res.ok ? '在线' : '异常'}；dshReady=${json.dshReady}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `检查失败：${error?.message ?? String(error)}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
