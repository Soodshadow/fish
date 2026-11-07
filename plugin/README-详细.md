# fish 插件 · 全面介绍

**包名**：`dsh-fish`　**版本**：0.1.0　**位置**：`D:\fish\plugin`
**定位**：小鲸鱼（QQ 小鱼）的 DSH 插件 —— 把她的能力（QQ 通道/记忆/角色/工具）模块化托管，让 DSH 桌面端可以直接加载。

---

## 一、它是什么

小鱼的整套系统原本是「桥接脚本 + 散落文件」。fish 插件把这些能力**收进一个标准的 DSH 插件包**：

- **对 DSH**：是一个可加载的插件（`cordis.patch.yml` 注册，`apply(ctx)` 注入角色+记忆）
- **对桥接**：是一个组件库（桥接 import 它，拿 memory / qq-channel 等组件用）
- **对使用者**：是一套可配置、可启停、可复用的能力模块

**设计原则**：
1. **组件只通过事件总线通信**（core/event-bus.js），不互相 require 内部实现
2. **数据路径不变**（记忆/角色仍在 `D:\fish\memory`、`D:\fish\roles`）—— 插件化不影响已有数据
3. **分步接管**：先读后写、先简后繁，每步可回退

---

## 二、架构

```
dsh-fish
├── index.js            ← 插件入口：DSH apply(ctx) 注入角色+记忆；也导出 createFish() 供桥接用
├── cordis.patch.yml    ← DSH 加载声明（id: fish）
├── package.json        ← 包定义（dsh.bundle.patch）
├── core/
│   ├── event-bus.js    ← 组件间唯一通信通道（发事件/收事件）
│   └── registry.js     ← 组件注册表（依赖先启动、反向停止）
├── hosts/
│   └── host-dsh/
│       └── index.js    ← 宿主适配：复用 DSH agent 循环（当前只注入 bridge 实例）
├── components/         ← 8 个能力组件（如下）
└── config/
    └── fish.config.json ← 组件开关与路径配置
```

---

## 三、8 个组件

| 组件 | 能力 | 权限 | 状态 |
|---|---|---|---|
| **memory** | BLUEPRINT + ARCHIVE + 共享池读取/注入 | — | ✅ **已接管**（桥接优先用它） |
| **persona** | 角色卡读取 + 人设注入 | — | ✅ 已生效（DSH apply 里注入） |
| **qq-channel** | QQ 收发 + 发送工具 + 唤醒/已读 | — | ✅ **发送已接管**（文本/图片/表情/引用） |
| **admin-tools** | 改资料/头像/昵称/状态/说说/撤回/点赞/好友管理 | 管理员私聊 | ✅ 能力声明（由 MCP 实际执行） |
| **device-control** | 安卓模拟器 ADB：截图/点击/输入/shell | 管理员私聊 | ✅ 能力声明 |
| **search** | web_search / web_fetch | — | ✅ 能力声明 |
| **console** | 桥接 HTTP 控制台（3100）状态/日志/指令 | 管理端 | ✅ 能力声明 |
| **preset-provider** | 三个 agent preset（qq-chat / qq-chat-v2 / qq-chat-v2-group）+ 工具守卫 | — | ✅ 已注册 |

### 组件细节

**memory**
- 读 `D:\fish\memory\MEMORY-BLUEPRINT.md`（核心记忆，每轮注入）
- 读 `MEMORY-ARCHIVE.md`（归档，按需回忆）
- 读 `shared-chat.jsonl`（群聊共享池）
- 桥接的 `memoryBlueprintText()` / `archiveLines()` / `sharedMemoryText()` 优先调它

**persona**
- 读 `D:\fish\roles\小鲸鱼.md`（角色卡）
- DSH apply 时注册为 system prompt 段（order -100，优先于人设说明）

**qq-channel**
- `sendTextViaOneBot`：纯文本直连 OneBot HTTP
- `sendSegments`：消息段（文本/图片/表情/引用/@）直连 OneBot
- 桥接 `sendToQQ` 和 `onebotSend` 优先调它，失败回退 bot SDK

**preset-provider**
- qq-chat（一代）/ qq-chat-v2（二代）/ qq-chat-v2-group（群聊）
- `qq-tool-restrict.mjs`：工具守卫（仿真会话禁止本地工具，白名单兜底）

---

## 四、两种运行方式

### 方式 A：DSH 插件（界面加载）

```
DSH 读 cordis.patch.yml → id: fish
  → import index.js → apply(ctx)
  → 注册系统提示词段（角色卡 + 核心记忆）
```

**效果**：加载 fish 的 DSH 会话（web / 桌面 profile）会注入小鲸鱼人设 + 记忆。

### 方式 B：组件库（桥接引入）

```js
const { createFish } = await import('D:/fish/plugin/index.js')
const fish = await createFish({ bridge })
await fish.start()   // 启动所有组件
```

**效果**：桥接可以调用 fish 的组件（memory/qq-channel 等）。

---

## 五、配置（config/fish.config.json）

```json
{
  "host": "dsh",
  "components": {
    "qq-channel": { "enabled": true },
    "memory": { "enabled": true, "dir": "D:\\fish\\memory" },
    "persona": { "enabled": true, "dir": "D:\\fish\\roles" },
    "admin-tools": { "enabled": true },
    "device-control": { "enabled": true },
    "search": { "enabled": true },
    "console": { "enabled": true }
  }
}
```

**每个组件可单独启停**（`enabled: false` 跳过）。

---

## 六、当前完成度

| 部分 | 状态 | 说明 |
|---|---|---|
| DSH 加载（角色/记忆注入） | ✅ | 日志 `[fish] 插件已激活` |
| memory 组件接管 | ✅ | 桥接 3 个记忆函数优先用组件 |
| qq-channel 发送接管 | ✅ | 文本/图片/表情/引用 全走组件 |
| preset 归属 | ✅ | 指向 fish |
| **bridge 组件（收消息投递）** | ❌ **已回退** | 投递闭环未突破（详见任务清单） |
| 工具（MCP） | ⏳ | 仍是独立 MCP 进程（架构限制） |

**约 60% 完成**，覆盖最高频路径（记忆读取 + 消息发送）。

---

## 七、文件结构

```
D:\fish\plugin\
├── index.js                  # 插件入口
├── index.js.bak-probe        # 探针备份（可删）
├── cordis.patch.yml          # DSH 加载声明
├── package.json
├── README.md                 # 原 README
├── core/
│   ├── event-bus.js
│   └── registry.js
├── hosts/host-dsh/index.js
├── components/
│   ├── memory/index.js
│   ├── persona/index.js
│   ├── qq-channel/index.js
│   ├── admin-tools/index.js
│   ├── device-control/index.js
│   ├── search/index.js
│   ├── console/index.js
│   ├── bridge/index.js       # 阶段1实验（已回退，未挂载）
│   └── preset-provider/
│       ├── package.json
│       ├── preset 文件 ×3
│       └── qq-tool-restrict.mjs
├── config/fish.config.json
└── state/tool-restrict.log   # 工具守卫诊断
```

---

## 八、已知问题 / 待办

1. **bridge 组件（收消息投递）未突破** —— DSH 的 agent/session/投影机制复杂，已回退
2. **工具仍是独立 MCP** —— fish 无法替代 MCP 进程
3. **桌面 profile 未装 fish** —— 只在 web（避免桌面也变小鲸鱼）
4. **`index.js.bak-probe`** —— 探针备份，可删

---

*介绍生成：2026-11-03*
