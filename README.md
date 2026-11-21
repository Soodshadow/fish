# fish · 小鲸鱼QQ 机器人部署集

> **2026-11 结构调整**：桥接已经从独立的 `qq-bridge/` 迁进 `brain/`，
> 作为 DSH 桌面端的**进程内插件**运行（不再需要 DSH Web 和独立桥接进程）。
> 新的核心在 [`brain/`](brain/)，`qq-bridge/` 已移除。

把 **SnowLuma（QQ 网关）**、**qq-bridge（消息路由桥）**、**DSH Web（会话大脑）** 三件套组装成一个可独立启动的 QQ 机器人项目。

> 本仓库只包含**代码与文档**。运行时数据（聊天记录数据库、日志、状态）、第三方二进制（`node.exe`、SnowLuma 的 `index.mjs` 与前端资源）、以及真实配置中的 token 与账号信息均已排除或替换为占位符。

**想直接跑起来 → 看 [DEPLOY.md](DEPLOY.md)**（含 SnowLuma 安装、配置填写、排错表）。

## 目录结构

```
fish/
├─ brain/                        # ★ 核心：桌面端桥接（DSH 进程内插件）
│  ├─ bridge/                    #   QQ ⇄ DSH 会话：收消息、组 prompt、发回复
│  ├─ core/                      #   共享消息库（append-only JSONL）
│  ├─ plugin/                    #   DSH 左侧栏「记忆」面板（宿主 + 客户端）
│  ├─ scripts/                   #   运维脚本（预设自检、旧记忆导入）
│  ├─ test/                      #   回归测试（91 项，假 QQ，不连真实网关）
│  └─ config.example.json        #   配置模板（复制为 config.json）
│
├─ snow/                         # SnowLuma 启动适配（第三方，本体需自行安装）
├─ roles/                        # 通用角色卡
├─ legacy/                       # 旧版启动脚本（依赖已移除的 qq-bridge，仅留档）
├─ acp-provider.yml              # DSH 的 provider 覆盖
├─ DEPLOY.md                     # 部署指南
└─ README.md
```

## 快速开始

### 1. 装依赖

| 依赖 | 版本 | 地址 |
|---|---|---|
| Node.js | ≥ 20 LTS | https://nodejs.org/zh-cn/download |
| SnowLuma | ≥ 2.3.0 | https://github.com/SnowLuma/SnowLuma/releases |
| DSH（DeepSeek Harness） | 近期版本 | 需本机可用，监听 `3080` |

### 2. 放 SnowLuma 本体

从 Releases 下载 **Windows x64** 包，解压到 `snow/`，确保有：

```
snow/
├─ node.exe
├─ index.mjs
├─ client/
├─ native/
└─ config/
```

首次启动 `snow\launcher.bat`，日志里会打印 **WebUI 临时密码**（只出现一次，记下），
浏览器打开 `http://127.0.0.1:3000` 扫码登录 QQ，再到设置里复制 **accessToken**。

> SnowLuma 只支持扫码登录，没有 CLI 登录。详细步骤见
> [SnowLuma 快速开始](https://snowluma.github.io/zh/docs/guide/quickstart)。

### 3. 配置 qq-bridge

```bat
cd qq-bridge
npm install
copy config.example.json config.json
```

编辑 `config.json`，必须改这 4 处：

| 字段 | 填什么 |
|---|---|
| `snowluma.accessToken` | 上一步复制的令牌 |
| `ownerQQ` | 你自己的 QQ 号（主人） |
| `allow.private` | 允许私聊的 QQ 号数组 |
| `allow.groups` | 允许响应的群号数组 |

### 4. 启动

```bat
start.bat
```

启动顺序：**SnowLuma（QQ 网关）→ DSH Web（会话服务）→ QQ 桥接（消息路由）**

> 关闭启动窗口不会停止服务；停止请运行 `stop.bat`。

## 配置说明

| 字段 | 作用 |
|---|---|
| `dsh.baseUrl` | DSH Web 服务地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` | 模型 provider（本仓库用账号登录 `deepseek-account`） |
| `snowluma.wsUrl` / `httpUrl` | SnowLuma 的 WebSocket 与 HTTP 端口 |
| `ownerQQ` | 机器人主人（可下达指令） |
| `allow.private` / `allow.groups` | 白名单，不在名单内的消息一律忽略 |
| `socialV2.*` | 拟人化行为（潜水、唤醒、表情、语气）参数 |
| `pricing.models` | 自定义计费单价，用于控制台统计 |

## 端口

| 端口 | 服务 |
|---|---|
| 3000 | SnowLuma HTTP |
| 3001 | SnowLuma WebSocket |
| 3080 | DSH Web |
| 3100 | qq-bridge 控制台 |
| 5099 | DSH 内部辅助 |

## 设计要点

- **白名单优先**：`allowAllWhenEmpty = false`，未配置白名单时默认不响应任何人
- **拟人化节流**：发送频率、连发间隔、长停顿都有独立参数，避免刷屏
- **人机验证交给人类**：遇到验证码只标记受阻，不尝试绕过
- **零硬编码凭据**：所有 token 走环境变量或本地 `config.json`（已在 `.gitignore` 中）
- **数据与代码分离**：`state/`、`data/`、`logs/`、`node_modules/` 均不入库

## 许可

代码部分见 `qq-bridge/LICENSE`。SnowLuma 为第三方软件，请遵守其自身许可。
