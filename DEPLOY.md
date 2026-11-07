# 部署指南

从零搭一套「fish 小鲣鱼 QQ 机器人」。全程约 30 分钟，需要三样东西配合工作：

```
SnowLuma（QQ 网关）  ←→  qq-bridge（消息桥）  ←→  DSH（会话大脑）
     :3000/:3001                :3100               :3080
```

---

## 一、前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| **Windows** | 10 / 11 | 启动脚本是 `.bat` / `.vbs`，Linux 需自行改写 |
| **Node.js** | ≥ 20 LTS | [下载](https://nodejs.org/zh-cn/download) |
| **SnowLuma** | ≥ 2.3.0 | [GitHub Releases](https://github.com/SnowLuma/SnowLuma/releases) |
| **DSH**（DeepSeek Harness） | 任意近期版本 | 会话与模型服务，需本机可用 |
| **一个 QQ 小号** | — | 建议用小号，机器人会以该账号身份说话 |

> SnowLuma 与 DSH 都需要各自登录。**机器人用的 QQ 号和你的主号最好分开**。

---

## 二、第一步：装并启动 SnowLuma

1. 到 [Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载 **Windows x64** 包，解压到项目下的 `snow/` 目录

   解压后应该有：

   ```
   snow/
   ├─ node.exe
   ├─ index.mjs
   ├─ client/
   ├─ native/
   └─ config/
   ```

2. 启动一次，扫码登录 QQ：

   ```bat
   snow\launcher.bat
   ```

   - 日志里会打印 **WebUI 临时密码**（只在全新数据目录首次启动时出现，**务必记下**）
   - 打开 `http://127.0.0.1:3000`，用临时密码登录，扫码绑定 QQ

3. 记下 **访问令牌（accessToken）**：WebUI → 设置 → 网络/HTTP 服务，端口保持 `3000`（HTTP）与 `3001`（WebSocket）

   详细步骤见 [SnowLuma 快速开始](https://snowluma.github.io/zh/docs/guide/quickstart)。

---

## 三、第二步：准备 qq-bridge 配置

```bat
cd qq-bridge
npm install
copy config.example.json config.json
```

用编辑器打开 `config.json`，**必须改这 4 处**：

| 字段 | 填什么 | 示例 |
|---|---|---|
| `snowluma.accessToken` | 上一步拿到的令牌 | `"你的令牌"` |
| `ownerQQ` | 你自己的 QQ 号（主人，可下指令） | `123456789` |
| `allow.private` | 允许私聊的 QQ 号数组 | `[123456789]` |
| `allow.groups` | 允许响应的群号数组 | `[987654321]` |

其余保持默认即可。关键默认值：

```jsonc
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",   // DSH 服务地址
    "provider": "deepseek-account"         // 用账号登录，不用 API key
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000"
  },
  "allowAllWhenEmpty": false               // 白名单为空时不响应任何人
}
```

> ⚠️ `config.json` 已在 `.gitignore` 中，**不要提交**。里面有你的令牌和账号。

---

## 四、第三步：让 DSH 起来

DSH 需在本机跑起来并监听 `3080`。项目根目录的 `acp-provider.yml` 是它的 provider 覆盖配置：

```yaml
- id: acp
  config:
    provider: deepseek-account   # 用账号登录（不是 API key）
    model: deepseek-flash
```

如果你用的不是 DSH 或端口不同，改 `config.json` 里的 `dsh.baseUrl`。

---

## 五、第四步：启动

回到项目根目录：

```bat
start.bat
```

启动顺序会自动处理：**SnowLuma → DSH → qq-bridge**。

| 命令 | 作用 |
|---|---|
| `start.bat` | 一键启动 |
| `start.bat --check` | 只做环境预检，不启动 |
| `start.bat --manual` | 分步启动（排查问题用） |
| `stop.bat` | 按端口结束所有进程 |
| `stop.bat --dry-run` | 演练：只显示会结束哪些进程 |

> 启动窗口关掉**不会**停止服务（进程已独立运行）。要停请用 `stop.bat`。

---

## 六、验证是否成功

1. 用你**白名单里的 QQ** 给机器人发一条私聊消息
2. 观察 `qq-bridge/bridge-run.log` 是否出现收到的消息
3. 机器人应该会回复

如果没反应，按顺序检查：

| 现象 | 检查点 |
|---|---|
| 完全没有回复 | `allow.private` 里有没有你的 QQ 号 |
| 收到但不回 | `snowluma.accessToken` 对不对；SnowLuma 是否在线 |
| 回「模型错误」 | DSH 是否在 `3080` 运行；`dsh.provider` 是否登录 |
| `start.bat` 报端口占用 | 旧进程没停干净，先跑 `stop.bat` |

---

## 七、端口一览

| 端口 | 服务 | 能不能改 |
|---|---|---|
| 3000 | SnowLuma HTTP | 改了要同步 `config.json` |
| 3001 | SnowLuma WebSocket | 同上 |
| 3080 | DSH Web | 改了要同步 `dsh.baseUrl` |
| 3100 | qq-bridge 控制台 | `config.json → consolePort` |
| 5099 | DSH 内部辅助 | 一般不用管 |

---

## 八、常见问题

**Q：能不能不用 Windows？**
可以，但 `start.bat`、`start-fish-guard.vbs` 是 Windows 专用。核心逻辑在 `qq-bridge/src/`，Node.js 跨平台，自己写个 `start.sh` 即可。

**Q：机器人说的话太频繁 / 太冷淡？**
调 `config.json → socialV2` 里的参数：`triggerProbability`（触发概率）、`maxSendPerHour`（每小时上限）、`burstEnabled`（连发）。

**Q：能不能加人设？**
把角色文件放进 `roles/`，在 QQ 里用指令切换。

**Q：聊天记录存在哪？**
`qq-bridge/state/` 与 `snow/data/`，都是本地文件，不上传。

**Q：会不会被 QQ 封号？**
会。用小号、控制频率、别群发。频率上限在 `socialV2.send` 里。

---

## 九、目录对照

| 路径 | 是否需要自己准备 |
|---|---|
| `snow/node.exe`、`index.mjs`、`client/`、`native/` | ✅ 自己下载 SnowLuma 放进去 |
| `qq-bridge/node_modules/` | ✅ `npm install` 生成 |
| `qq-bridge/config.json` | ✅ 从 `config.example.json` 复制并填写 |
| `qq-bridge/src`、`scripts`、`docs` | ❌ 仓库已包含 |
| `plugin/`、`roles/` | ❌ 仓库已包含 |
| `memory/` | ⚠️ 仓库不包含（个人记忆数据），首次运行会自动创建 |
