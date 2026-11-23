// 把桥接正在用的会话登记进「小鱼」工作区。
// 桥接是用 controller.create({ cwd }) 建的会话，不经过工作区注册，
// 所以桌面左侧的工作区列表里看不到它们 —— 会话文件其实一直在。
//
// 用法：node <repo>/brain/scripts/register-workspace-sessions.mjs
// 建议先关掉 DSH 再运行（DSH 退出时可能把自己内存里的工作区状态写回）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const WORKSPACE_FILE = path.join(HOME, '.dsh', 'storages', 'workspace.json');
const BRIDGE_STATE = path.join('D:/fish/brain/state/s2-sessions.json');
const WORKSPACE_NAME = '小鱼';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

if (!fs.existsSync(WORKSPACE_FILE)) {
  console.log(`找不到工作区文件：${WORKSPACE_FILE}`);
  process.exit(1);
}
if (!fs.existsSync(BRIDGE_STATE)) {
  console.log(`找不到桥接状态：${BRIDGE_STATE}（她还没说过话？）`);
  process.exit(1);
}

const bridge = readJson(BRIDGE_STATE);
const sessionIds = [...new Set(
  Object.values(bridge.sessions || {})
    .map((entry) => String(entry?.sessionId || ''))
    .filter(Boolean),
)];
if (!sessionIds.length) {
  console.log('桥接还没有登记任何会话');
  process.exit(0);
}

const doc = readJson(WORKSPACE_FILE);
const table = doc?.tables?.workspaces ?? doc?.workspaces ?? {};
const entry = Object.entries(table).find(([, ws]) => (ws?.title ?? ws?.name) === WORKSPACE_NAME);
if (!entry) {
  console.log(`工作区里没有叫「${WORKSPACE_NAME}」的，先建一个再跑`);
  process.exit(1);
}
const [workspaceId, workspace] = entry;
const before = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
const merged = [...new Set([...before, ...sessionIds])];
const added = merged.filter((id) => !before.includes(id));

if (!added.length) {
  console.log(`「${WORKSPACE_NAME}」已经包含这些会话（共 ${before.length} 个），不用改`);
  process.exit(0);
}

const backup = `${WORKSPACE_FILE}.bak-${Date.now()}`;
fs.copyFileSync(WORKSPACE_FILE, backup);
workspace.sessionIds = merged;
fs.writeFileSync(WORKSPACE_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

console.log(`「${WORKSPACE_NAME}」(${workspaceId}) 会话 ${before.length} -> ${merged.length}`);
for (const id of added) console.log('  +', id);
console.log(`备份：${backup}`);
