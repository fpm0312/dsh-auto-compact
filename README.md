# dsh-auto-compact

DeepSeek Harness 插件：**上下文占用超过 30%、且对话 3 分钟没有动静时，自动压缩会话历史。**

阈值、静默时长、巡检间隔、冷却时间都可配置。

> **EN** — A DSH host plugin that compacts a session automatically once its context
> usage passes a threshold (30% by default) **and** the conversation has been idle
> for a while (3 minutes by default). Zero runtime dependencies; it only decides
> *when*, and delegates the actual summarization to the official
> `@deepseek-ai/dsh-compaction-basic` backend via `/compact`.

## 它解决什么问题

DSH 自带的自动压缩只在“回合进行中、跑到模型上下文阈值（默认 80%）”时才触发。
长会话往往在回合结束时停在 60%~80% 之间，之后你放着不动，下一句话照样要带着
一坨旧历史进请求：首 token 慢、贵，还容易在再聊几轮后直接顶到上限。

这个插件补上“空闲期”这一段：只要某个会话**已经静默够久**，且**上下文占用已过线**，
它就在后台把旧历史压成一条 checkpoint，等你回来时上下文是干净的。

## 判定规则

每个巡检周期（默认 15s）对每个存活会话依次检查：

| 条件 | 说明 |
| --- | --- |
| `agent.status === "idle"` | 回合正在跑时**绝不**介入，不和进行中的对话抢状态 |
| 静默 ≥ `idleMs` | 会话日志事件、agent 状态变化、收件箱投递都会刷新“最后活跃时间” |
| 上下文 ≥ `thresholdRatio` | 取 token-meter 的上下文投影（与界面显示的百分比同源） |
| 距离上次尝试 ≥ `cooldownMs` | 成功、失败、跳过都计入冷却，避免反复打扰模型 |
| 不在压缩中 | 单个会话同时只允许一次自动压缩 |

命中后调用官方压缩链路，把可压缩的历史压成一条 checkpoint。压缩本身产生的事件
会刷新活跃时间，所以不会连环触发。

## 安装

### 方式一：从 tgz 安装（推荐）

```bash
dsh plugin --profile desktop add file:C:/Plugins/dsh-auto-compact-0.1.0.tgz
```


### 方式二：从源码（GitHub）

```bash
git clone https://github.com/fpm0312/dsh-auto-compact.git
cd dsh-auto-compact
npm pack
dsh plugin --profile desktop add "file:$PWD/dsh-auto-compact-0.1.2.tgz"
```

PowerShell 里最后一行写成：

```powershell
dsh plugin --profile desktop add "file:$((Get-Location).Path)\dsh-auto-compact-0.1.2.tgz"
```

开发调试可以直接用 `link:` 挂目录（改动免重装，但需要重启应用让宿主重新 import）：

```bash
dsh plugin --profile desktop add "link:$PWD"
```

### 方式三：手工挂载（等价）

1. 把本包放进 profile 的依赖里（`~/.dsh/profiles/desktop/package.json`）：
   `"dsh-auto-compact": "file:C:/Plugins/dsh-auto-compact-0.1.0.tgz"`
2. 在同一个文件的 `dsh.profile.bundles` 里追加 `"dsh-auto-compact"`。
3. 在 profile 目录执行 `pnpm install`。

本包自带 `cordis.patch.yml`（`dsh.bundle.patch`），安装后会把 `auto-compact`
一行插进配置树，不需要手改 `cordis.patch.yml`。桌面端的 profile 监听会在
`package.json` / patch 变化时热重载插件树；否则重启一次应用即可。

## 配置

配置写在插件行上（profile 的 `cordis.patch.yml`，或直接用上面的 `config` 段覆盖）：

```yaml
- id: auto-compact
  name: dsh-auto-compact
  config:
    thresholdRatio: 0.30     # 上下文占用阈值（占模型上下文窗口比例）
    idleMs: 180000           # 静默多久算“没动静”（毫秒）
    pollMs: 15000            # 巡检间隔（毫秒）
    cooldownMs: 300000       # 两次尝试之间的最小间隔（毫秒）
    minTokens: 0             # 低于这个绝对 token 数不压缩
    compactTimeoutMs: 600000 # 单次压缩超时
    dryRun: false            # true = 只记录“本该压缩”，不真的压
    statusFile: true         # 心跳状态文件；false 关闭，或给绝对路径
    via: auto                # auto | service | command
    verbose: true            # 是否输出 info 日志
```


### `via` 是什么

压缩后端挂在**每个 agent preset 的隔离作用域**里，宿主平面拿不到 `ctx.compaction`。
插件按以下顺序找通道：

1. `service`：`agent.ctx.get("compaction")` 能拿到就直接调 `compactNow()`；
2. `command`：拿不到就执行内置的 `/compact` 命令 —— 同一条官方压缩链路，
   会在会话日志里留下 `command/run` + `command/done`，界面上可见。

`auto`（默认）先试 1 再退 2；`service` / `command` 可以强制只走某一条。

## 可观测性

- **心跳文件**：默认 `~/.dsh/auto-compact.status.json`，每次巡检后刷新。里面有每个
  会话的 `totalTokens` / `contextWindow` / `ratio` / `reason` / `lastAction`，
  一眼能看出“为什么这次没压”。
- **命令**：`/autocompact` 查看当前会话的占用与判定；`/autocompact now` 立即评估一次
  （跳过静默等待，但仍受阈值与冷却约束）。
- **日志**：`[auto-compact]` 前缀，info 级汇报压缩结果，warn 级汇报真故障；
  “agent 忙 / 被取消”这类正常竞争只记 info。

## 设计取舍

- **只做决策，不重写压缩**：真正的摘要、写 checkpoint、替换 surface 全部交给
  `@deepseek-ai/dsh-compaction-basic`，插件只负责“什么时候该压”。
- **零 `@deepseek-ai/*` 依赖**：安装成 tgz 后不需要解析宿主的 peer 依赖，宿主升级
  也不会因为类型/内部实现变化把插件带崩。
- **空闲优先**：绝不压缩正在跑的回合。压缩是重活（要调一次模型），空闲期做最划算。
- **百分比与界面同源**：优先读 token-meter 的 `contextPressure` 投影
  （`pressureTokens + surfaceTokens - sampledSurfaceTokens`），拿不到才退回
  `measure().totalTokens` 估算。

## 开发

```bash
node --test test/auto-compact.test.mjs   # 16 个用例：决策矩阵 + 假宿主集成
node --check lib/index.js
npm pack                                  # 产出 tgz
```


`test/` 里用假宿主驱动 `apply()`，覆盖：静默判定、阈值边界、运行中不介入、
事件刷新计时、冷却、dryRun、命令兜底、投影优先、心跳文件、`/autocompact`。

## 已知限制

- 只对**空闲**会话生效；回合进行中的压力压缩仍然交给 `compaction-basic` 自己的阈值
  （默认 80%）。两者互补，不冲突。
- 压缩会真实调用一次模型（摘要），会计费；`cooldownMs` 就是为此存在的。
- 如果 profile 里根本没有挂载任何压缩后端，`/compact` 也不存在，插件会如实报
  `missing` 并在心跳文件里留痕，不会静默失败。