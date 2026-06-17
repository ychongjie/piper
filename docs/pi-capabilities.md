# pi 能力盘点 → 对 Piper 的价值

研究对象:`~/Code/github/pi`(earendil-works/pi,v0.74.0,TS monorepo)。
结论先行:**pi 不只是一个 CLI,而是一个完整的 agent 平台 + 干净的 TS SDK。我们原打算自己写的"厚层"
里,有 60–70% pi 已经免费提供。Piper 应当作为一个 TS 库构建在 pi 的 SDK 之上,而不是 spawn CLI 解析文本。**

## pi 的四个 package

| package | 是什么 | 对我们 |
|---|---|---|
| `@earendil-works/pi-ai` | provider 抽象(anthropic/openai/deepseek/… + 自定义 provider via `models.json`) | 便宜模型接入层,**DeepSeek 内置**,siliconflow 走自定义 provider |
| `@earendil-works/pi-agent-core` | 有状态 agent + 工具执行 + 事件流(`Agent` 类 / `agentLoop`) | 单个 worker 的执行引擎(替代我们 `pi.rkt`) |
| `@earendil-works/pi-coding-agent` | 完整编码 agent + **SDK**(`createAgentSession`)+ skill/extension/session 管理 | **我们直接 import 它来驱动 worker** |
| `@earendil-works/pi-tui` | 终端 UI | 用不上 |

## pi 已经提供的(= 我们不用自己写的"厚层"管道)

| Piper 厚层需求 | pi 提供 | 机制 |
|---|---|---|
| 派 worker、跑 agent 循环 | ✅ 完整 | `createAgentSession()` / `Agent` / `agentLoop` |
| 接便宜模型、可换后端 | ✅ | `getModel` / `ModelRegistry` / `models.json`(自定义 baseUrl)/ `streamFn` 代理。DeepSeek 内置 |
| **授权闸(spec §8)** | ✅✅ | `beforeToolCall` / `tool_call` hook → 返回 `{block:true, reason}`。**正是我们的爆炸半径闸**:拦住"删 baseline / 动 license"这类危险 bash |
| **验证器即工具(spec §6)** | ✅✅ | `defineTool` / `customTools` → 把 `V_rerun_old`/`V_engine_rule` 注册成 pi 工具,worker 直接调 |
| **成本/预算记账** | ✅✅ | `get_session_stats` → tokens + cost + contextUsage;每条 assistant 消息带 `usage.cost`;observability `pi.ai.provider.usage` |
| **结构化事件(不靠文本解析)** | ✅✅ | 事件流 / RPC JSONL:`tool_execution_end{isError}`、`turn_end{toolResults}`、`agent_end{messages}` |
| **会话分叉做 TTC** | ✅✅ | `fork` / `clone` / `SessionManager.branch` → 同一上下文分叉 N 份跑 `bestOfN`/`debate` |
| thinking 档位(TTC 旋钮) | ✅ | `set_thinking_level`(off→xhigh)、`thinkingBudgets` 每调用可调 |
| 上下文管理 | ✅ 免费 | 自动 + 手动 compaction、`transformContext` |
| 瞬态错误重试 | ✅ 免费 | `set_auto_retry`(overloaded/429/5xx)——注意:这是**基础设施**重试,不是我们的"验收失败重派" |
| **升级给人的传输通道** | ✅✅ | RPC 的 Extension UI 协议:`select`/`confirm`/`input` → emit 请求并阻塞等回应,带 `timeout` 自动兜底。**这就是 `escalate(human)` 的现成通道** |
| 持久化 / 断点续跑 | ✅(已设计) | session = 可追加的durable 树;durable-harness 设计;我们的 `loop` 状态(`last_tested_tag`)可落成 session entry 或 sidecar |
| **skill = 薄层** | ✅✅ | pi 直接 load skill,**包括 `~/.claude/skills`**(settings 里加目录即可)。你现有的 `safeline-apitest-env`/`build-minion`/`babysit-ci` 等 skill **pi+便宜模型可直接用** |
| 可观测 / tracing | ✅ | `subscribePiObservability` / 事件 → 落日志,安全字段默认脱敏 |

## pi 不提供的(= Piper 真正要写的厚层 = 我们的价值)

pi 是**单 agent**:派一个 worker 跑到停。它刻意不做多 agent 编排。以下全是 Piper 的:

1. **`goal` 客观验收外环** —— pi 的 `terminate`/`shouldStopAfterTurn` 只在一次 run 内;"跑 check 命令 → 失败带反馈重派"的外环在 pi 之上,是我们的。
2. **`bestOfN` / `vote` / `judge`** —— pi 给了 fork 机制,但"N 份分叉 + 聚合 + 收敛检验"的编排是我们的。
3. **`debate` / `refute`** —— 主张 vs 证伪 + 裁决,两个 pi session 对打,是我们的。
4. **`decompose`** —— 把判断拆成带验证器的子查询(每个子查询可以是一个 pi 工具或子 session),编排是我们的。
5. **`loop` 定时/轮询守望** —— pi 没有调度器;"夜跑 / 探到新构建才触发"的控制平面是我们的。
6. **spec 引擎** —— 声明式步骤 + 失败→修复表 + 升级策略,是我们的。
7. **升级 _策略_** —— pi 给了授权闸_机制_(`beforeToolCall`)和升级_通道_(UI 协议),但"删 baseline = 升级"这个_策略_是我们的。
8. **回归判定的跨 run 状态与收敛逻辑** —— 我们的。

## 这对架构的三个确定结论

1. **语言定了:TS,构建在 pi SDK 之上(in-process)。** SDK 文档明确建议 Node/TS 用 `AgentSession`
   而非 spawn 子进程——拿到类型安全、直接状态访问、fork、自定义工具/hook。RPC 模式只在跨语言时才用,
   我们不需要。现有 Racket `pi.rkt`/`goal.rkt` 的职责被 pi SDK 覆盖,迁移即弃。

2. **薄层更薄了。** 薄 spec 里的"动作"可以直接 `skill: safeline-apitest-env`,pi 加载 `~/.claude/skills`
   就能跑;"验证器"用 `defineTool` 注册;"授权闸"用 `beforeToolCall` 配策略。spec 几乎只剩"编排意图"。

3. **厚层小了一圈,但价值更聚焦。** Piper 不再需要写 agent 循环/模型接入/成本/fork/升级通道,只写
   pi 不做的那件事:**带客观验收和接地验证的 test-time compute 多 agent 编排**。这正是 Piper 的全部理由。

## 验证清单(已在本机跑通 ✅,脚本见 `verify/`,`bun run verify` 一键复跑)

- [x] **#1** `createBaizhiSession()` 用 baizhi 网关 deepseek-v4-pro 跑一轮,出文 + token 用量到位
- [x] **#2** `session.agent.beforeToolCall` 拦住 bash(授权闸,对应 spec §8)
- [x] **#3** `defineTool` 注册的假"验证器"工具被便宜模型调用(验证器即工具,spec §6)
- [x] **#4** 3 路 `createBaizhiSession` 并发(1.6s 全返回,bestOfN/debate 机制成立)
- [x] **#6** `DefaultResourceLoader` 从 `~/.claude/skills` 发现 11 个 skill,含
  `safeline-apitest-env`/`build-minion`/`babysit-ci`(薄层复用现有 skill)
- 预算记账:#1 已拿到 `usage`(input/output/cacheRead);成本费率网关未知,先置 0,token 数照常统计。

### 实测踩到的关键坑(写进配置)

**baizhi 网关三个端点只有 `anthropic-messages` 干净。** baseUrl 填 `.../api/anthropic`(pi 追加
`/v1/messages`,鉴权 x-api-key)。踩坑过程(全靠观测层定位):
- `openai-responses`:`/responses` 流 `content_part.added` 结构不标准,pi 解析器崩(`event.part.type`)。
- `openai-completions`:单工具调用能跑,**并行工具调用**(一回合多个 tool_use)502
  `tool_use ids ... without tool_result blocks immediately after`——网关 OpenAI→Anthropic 转换层 bug。
  迷惑性极强:表现为 worker 读完文件就停手、输出 0 字,像模型偷懒,实为 502 被吞。
- `anthropic-messages`:直连网关原生 Anthropic 端点,绕开坏转换层,并行工具调用正常,goal 闭环 1 轮修好 bug。

**provider 只挂进程内,零全局改动。** `ModelRegistry.create(authStorage)` 读全局 auth/models 只读,
`modelRegistry.registerProvider("baizhi", …)` 只改进程内实例。`~/.pi/agent/*` 原样不动,别处 pi 仍用 siliconflow。
key 放 `.env.local`(gitignore),bun 自动加载。实现见 `src/backend.ts`。
