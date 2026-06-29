# pi 能力盘点 → Piper 复用了什么

研究对象:`~/Code/github/pi`(earendil-works/pi,TS monorepo)。
结论先行:**pi 不只是一个 CLI,而是一个完整的 agent 平台 + 干净的 TS SDK。** Piper v2 引擎
作为一个 TS 库**构建在 pi SDK 之上(in-process)**,直接复用 pi 的 agent 循环/模型接入/授权闸/
自定义工具/事件流,只自己写 pi 不做的那件事:**封闭词汇的 agent 编排 + 接地验证**。

## pi 的四个 package

| package | 是什么 | Piper 怎么用 |
|---|---|---|
| `@earendil-works/pi-ai` | provider 抽象(anthropic/openai/deepseek/… + 自定义 provider) | 便宜模型接入层 |
| `@earendil-works/pi-agent-core` | 有状态 agent + 工具执行 + 事件流 | 单个活叶子的执行引擎 |
| `@earendil-works/pi-coding-agent` | 完整编码 agent + **SDK**(`createAgentSession`)+ skill/工具管理 | **`src/session.ts` 直接 import 它驱动每个活叶子** |
| `@earendil-works/pi-tui` | 终端 UI | 用不上 |

## pi 已经提供的(= 引擎不用自己写的)

| 能力 | pi 机制 | 在 v2 引擎里 |
|---|---|---|
| 起会话、跑 agent 循环 | `createAgentSession()` / `agentLoop` | `backendForModel()` 起每个活叶子的 pi 会话(`engine.ts runLeaf`) |
| 接便宜模型、可换后端 | `ModelRegistry` / 自定义 provider(自定 baseUrl/api) | `session.ts` **进程内**注册 provider(见下),`config.ts` 映射标准模型名 |
| **自定义工具(契约即工具)** | `defineTool` / `customTools` | `submit_result` / `submit_verdict` / `submit_check` 用它定义,验收/投票结构从声明装配 |
| **授权闸(危险写拦截)** | `beforeToolCall` hook → `{block, reason}` | 运行期由宿主 runner 注入的「危险写升级 handler」(策略不进 YAML) |
| 续会话收敛 | 同一 session 可多轮 `prompt` | 活叶子带 verify+budget,在一个会话里续跑收敛(`runLeaf`) |
| 结构化事件(不靠文本解析) | 事件流:`tool_execution_start/end`、`message_end` | `observe()` 订阅事件 → 进日志(带 `[角色·模型]` 标签),不进数据流 |
| 会话分叉 / 多份并发 | `fork` / 多会话并发 | `fanout` 多份判官 + `gather:vote`(`runFanout`) |
| 成本/预算记账 | `get_session_stats` / 每条消息带 `usage` | token/成本观测 |
| skill 加载 | 直接 load `~/.claude/skills` | 蒸馏期参考 skill,把逻辑**内联**进 `<agent>.tools/*.sh` |
| 上下文管理 / 瞬态重试 | 自动 compaction、`set_auto_retry` | 免费拿到 |

## pi 不提供的(= Piper 引擎的价值)

pi 是**单 agent**:派一个 worker 跑到停。多 agent 编排刻意不做。Piper v2 引擎补的就是这层:

1. **封闭声明式编排** —— `loop`(定时/轮询触发)+ 列表(顺序)+ `fanout`(并行铺开)+ `when`(机械 gate),
   引擎活解释 YAML,而不是让模型运行时写编排。
2. **活叶子目标驱动** —— verify 回合间把关 + budget 收敛 + 到顶升级(外环在 pi 之上)。
3. **判官 / 投票** —— pi 给了 fork,但「N 份独立判官 + 投票定性 + 接地取证」的编排是引擎的。
4. **接地验证(反幻觉)** —— 每条结论引用命令输出(`ground`/`evidence`);便宜模型样本收敛≠正确,
   强制对外部客观验证器接地。
5. **常驻监控 + 去重** —— pi 没有调度器;「探到新构建才触发、跨重启续」的控制平面是引擎/runner 的。

## 三个确定结论

1. **语言:TS,构建在 pi SDK 之上(in-process)。** 拿到类型安全、直接状态访问、fork、自定义工具/hook;
   RPC 模式只在跨语言时才用,不需要。
2. **机械操作下放给自包含工具。** 蒸馏期把 skill/仓库逻辑内联进 `<agent>.tools/*.sh` 并调通,
   运行期活 agent 按名调用,不现推、不 shell-out skill。
3. **引擎只聚焦编排 + 接地验证。** agent 循环/模型接入/成本/fork/授权闸机制全由 pi 提供,
   引擎只写「封闭词汇活解释 + test-time compute 投票 + 接地」——这正是 Piper 的全部理由。

## 实测踩到的关键坑(已写进配置)

**baizhi 网关三个端点只有 `anthropic-messages` 干净。** baseUrl 填 `.../api/anthropic`(pi 追加
`/v1/messages`,鉴权 x-api-key)。`openai-responses`/`openai-completions` 的网关转换层有 bug
(并行工具调用 502,表现为 worker 读完文件就停手、像偷懒,实为 502 被吞)。`anthropic-messages`
直连原生端点,绕开坏转换层,并行工具调用正常。

**provider 只挂进程内,零全局改动。** `ModelRegistry.create(authStorage)` 读全局 auth/models 只读,
`registerProvider(...)` 只改进程内实例,`~/.pi/agent/*` 原样不动。key 放环境变量(如 `BAIZHI_API_KEY`),
不入仓。实现见 `src/session.ts` + `src/config.ts`。
