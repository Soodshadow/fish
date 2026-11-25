# 小鱼的「人格」

这个文件是 `fish-chat` agent preset —— 她说话的方式、脾气、分条节奏、什么时候闭嘴，全在这里。

**注意**：它不在插件代码里，而在 **DSH 的 profile 配置**里：

```
C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml
```

## 为什么要单独放在这

preset 的内容会被**冻结进会话的系统提示词**（会话创建那一刻）。改了 preset 不会影响已经存在的会话，必须让桥接重建会话才生效（看 `brain/scripts/check-preset.mjs` 和 `PRESET_VERSION`）。

所以它不是"运行时代码"，而是"部署时贴进去的配置"。

## 部署时怎么装

把本文件的内容**追加**到你的 profile 的 `cordis.patch.yml` 末尾（保持缩进）：

```bash
# Windows PowerShell
Get-Content brain\preset\fish-chat.patch.yml | Add-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
```

然后重启 DSH。桥接启动时会发现 preset 版本变化，自动清掉旧会话映射，下一条消息用新人设重建。

## 改了 preset 之后

1. 修改本文件（或在 profile 里直接改）
2. 同步到 profile
3. 把 `brain/bridge/index.js` 里的 `PRESET_VERSION` 加一（例如 `fish-chat:9` → `fish-chat:10`）
4. 重启 DSH

第 3 步是必须的：不涨版本号，旧会话会一直挂着旧提示词。

## 它和记忆的分工

| | 在哪 | 管什么 |
|---|---|---|
| 这个 preset | profile 配置 | 怎么说话（语气、分条、社交规则） |
| `MEMORY-BLUEPRINT.md` | 私密记忆仓库 | 她是谁（身份、关系、锚点、核心记忆） |
| `MEMORY-ARCHIVE.md` | 私密记忆仓库 | 她记得什么（按天积累的事） |

前两个是她"像人"的基础，缺一个都会变成普通助手。
