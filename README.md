# fish · 小鲣鱼 QQ 机器人部署集

把 **SnowLuma（QQ 网关）**、**qq-bridge（消息路由桥）**、**DSH Web（会话大脑）** 三件套组装成一个可独立启动的 QQ 机器人项目。

> 本仓库只包含**代码与文档**。运行时数据（聊天记录数据库、日志、状态）、第三方二进制（node.exe、SnowLuma 的 index.mjs 与前端资源）、以及真实配置中的 token 与账号信息均已排除或替换为占位符。

## 目录结构

`
fish/
├─ start.bat / stop.bat          # 一键启动 / 停止（Windows）
├─ start-fish-guard.vbs          # 守护：崩溃自动拉起
├─ acp-provider.yml              # DSH 的 provider 覆盖（账号登录而非 API key）
│
├─ qq-bridge/                    # ★ 核心：QQ 消息桥
│  ├─ src/                       #   桥接主逻辑（QQ ⇄ DSH）
│  ├─ scripts/                   #   运维与测试脚本（90+ 个）
│  ├─ plugins/                   #   可插拔扩展
│  ├─ docs/                      #   设计与协议文档
│  ├─ public/ 、assets/          #   控制台页面与素材
│  ├─ config.example.json        #   配置模板（复制为 config.json 再填）
│  └─ README.md                  #   详细说明
│
├─ snow/                         # SnowLuma 启动适配（第三方，本体需自行安装）
│  ├─ start-fish.bat
│  ├─ launcher.bat
│  └─ start-snow-hidden.vbs
│
├─ plugin/                       # DSH 插件（侧栏面板）
├─ roles/                        # 人设（角色扮演提示词）
└─ 交接/                         # 开发记录与任务清单
`

## 快速开始

1. 安装 [Git for Windows](https://git-scm.com/download/win) 与 Node.js
2. 自行安装 **SnowLuma**（QQ 网关），把本体放进 snow/
3. 进入 qq-bridge/，执行：

`at
npm install
copy config.example.json config.json
`

4. 编辑 config.json，填入：
   - snowluma.accessToken：SnowLuma 的访问令牌
   - ownerQQ：你自己的 QQ 号
   - llow.private / llow.groups：允许的会话白名单
5. 回到项目根目录，运行 start.bat

启动顺序：**SnowLuma（QQ 网关）→ DSH Web（会话服务）→ QQ 桥接（消息路由）**

> 关闭启动窗口不会停止服务；停止请运行 stop.bat。

## 配置说明

| 字段 | 作用 |
|---|---|
| dsh.baseUrl | DSH Web 服务地址，默认 http://127.0.0.1:3080 |
| dsh.provider | 模型 provider（本仓库用账号登录 deepseek-account） |
| snowluma.wsUrl / httpUrl | SnowLuma 的 WebSocket 与 HTTP 端口 |
| ownerQQ | 机器人主人（可下达指令） |
| llow.private / llow.groups | 白名单，不在名单内的消息一律忽略 |
| socialV2.* | 拟人化行为（潜水、唤醒、表情、语气）参数 |
| pricing.models | 自定义计费单价，用于控制台统计 |

## 设计要点

- **白名单优先**：llowAllWhenEmpty = false，未配置白名单时默认不响应任何人
- **拟人化节流**：发送频率、连发间隔、长停顿都有独立参数，避免刷屏
- **人机验证交给人类**：遇到验证码只标记受阻，不尝试绕过
- **零硬编码凭据**：所有 token 走环境变量或本地 config.json（已在 .gitignore 中）

## 许可

代码部分见 qq-bridge/LICENSE。SnowLuma 为第三方软件，请遵守其自身许可。