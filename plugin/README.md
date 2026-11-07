# fish —— 小鱼插件

把小鱼的各个部分收进一个插件里，按「大组件」划分（一套连续功能不拆碎），
宿主目前只支持 **host-dsh**（复用 DSH 的 agent 循环）。

## 目录

```
fish/
├── index.js                 入口：读配置 → 注册组件 → 启动
├── core/
│   ├── event-bus.js         组件间唯一通信方式（事件）
│   └── registry.js          组件注册 + 生命周期顺序（依赖先启、反向停）
├── hosts/
│   └── host-dsh/index.js    宿主适配（复用 DSH，把 bridge 注入组件）
├── components/
│   ├── qq-channel/          ★ QQ 通道：收发 + 发送工具 + 唤醒/已读（一套）
│   ├── memory/              ★ 记忆：BLUEPRINT + ARCHIVE + 共享池 + 注入（一套）
│   ├── persona/             ★ 角色卡
│   ├── admin-tools/         ★ 管理工具：资料/头像/昵称/状态/说说/撤回/点赞
│   ├── device-control/      ★ 设备控制：安卓截图/点击/输入/shell
│   ├── search/              ★ 联网搜索
│   └── console/             ★ 控制台（3100 运维界面）
└── config/fish.config.json  总开关
```

## 组件契约

```js
export default {
  name: 'xxx',
  version: '0.1.0',
  dependencies: [],           // 依赖其他组件先启动
  async init(ctx) {},         // 读配置
  async start(ctx) {},        // 启动、订阅事件
  async stop() {},            // 清理
  async health() {},          // 健康检查
  tools: [],                  // 声明的工具（host 负责注册）
  events: { 'event.name': async (payload, ctx) => {} },  // 订阅
  emits: ['xxx'],             // 发出的事件
}
```

**规则**：组件之间不直接 require，只通过 `ctx.bus` 发事件 / `registry.get()` 取接口。

## 加一个组件

1. 建 `components/新组件/index.js`，按契约导出
2. 在 `index.js` 的 `BUILTIN_COMPONENTS` 里 import 并加入数组
3. 在 `config/fish.config.json` 的 `components` 里加 `{ "enabled": true }`
4. 重启，`--health` 验证

## 用法

```bash
# 健康检查（不启动桥接）
node D:\qq-bridge\fish\index.js --health

# 启动组件（调试用，不接管 QQ）
node D:\qq-bridge\fish\index.js --start
```

桥接内接入：

```js
import { createFish } from './fish/index.js';
const fish = await createFish({ bridge });
await fish.start();
fish.attachBridge(bridge);   // 桥接就绪后调用，qq-channel 即可主动发消息
```

## 当前阶段（0.1.0）

- 骨架 + 大组件接口已就位
- **QQ 收发仍由 bridge.js 负责**（qq-channel 是适配壳）
- 记忆/角色/管理/设备/搜索/控制台目前是「能力声明 + 路径读取」，
  实际工具仍走现有 MCP（`mcp-qq-admin.js` / `mcp-android.js` / `mcp-snowluma-safe.js`）

## 数据路径（刻意保持不变，避免影响记忆）

| 数据 | 路径 |
|---|---|
| 核心记忆 | `D:\her-memory\MEMORY-BLUEPRINT.md` |
| 归档 | `D:\her-memory\MEMORY-ARCHIVE.md` |
| 共享池 | `D:\her-memory\shared-chat.jsonl` |
| 角色卡 | `D:\qq-bridge\roles\小鲸鱼.md` |
| 会话 | `C:\Users\<用户>\.dsh\sessions\...` |
