# Piper 设计:厚编排层 + 薄声明式 agent

## 北极星

用**接近 SOTA 的便宜国产模型(如 DeepSeek-V4-Pro,落后 SOTA 半年内)+ 大量自动化 test-time
compute + 接地验证**,跑出强模型单次推理的效果,从而为不同项目/任务**快速搭出全自动 agent**。

一句话架构:

> **厚 Piper(通用编排层,写一次)+ 薄声明式 agent spec(项目/任务专属,由 Claude 从历史
> session 编译出来)。** 厚层提供 test-time compute 编排、客观验收、状态/预算/升级;薄层只声明
> "这个任务的步骤、验收闸、失败→修复表、可用验证器、授权边界"。

这条路线的实证依据见 piper-agents 仓库 `docs/safeline3/EXTRACTION-api-test.md`(从 5 个真实 Claude Code session 提炼,
机械层 ≈70–80% 已是 skill/脚本,判断层 ≈20–30% 中绝大多数**可验证**)。

## 与 Claude Dynamic Workflows 的关系(差异化定位)

Anthropic 的 [Dynamic Workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
让**前沿 Claude** 运行时动态写编排脚本、fan-out 几十~几百个并行 subagent、互相证伪到收敛再交付。
它**验证了 Piper 的核心机制,但经济目标正好相反**,二者不该混淆。

**趋同(博客在替 Piper 的原语背书)**:并行 fan-out ≈ `bestOfN`;"从不同角度切入+证伪+迭代到收敛"
≈ `debate`+收敛检验;验后交付 ≈ 客观验收+escalate;进度可续 ≈ `loop` 状态 + pi durable session。
Anthropic 用海量资源独立收敛到几乎一样的形状,说明 Piper 在造的是同一套正确范式,只是换了成本档与底座。

**根本差异(方向相反,不是大小之别)**:

| 维度 | Dynamic Workflows | Piper |
|---|---|---|
| 经济目标 | 让最强模型更强(明说烧更多 token) | 让便宜模型够用(成本就是全部理由) |
| 运行时谁推理 | 前沿 Claude 每次都在回路里写编排 | 贵模型只在**创作期**编译 spec;运行时=便宜模型+引擎 |
| 生命周期 | 一次性大任务,authoring+run 一把过 | **反复跑**:编译一次,无人值守跑 N 次 |
| 形态 | 加强版交互 session(数小时~数天) | 常驻 daemon:定时/轮询、跨重启续、授权边界叫人 |
| 验证接地 | 主要靠 agent 互相证伪(内部一致性) | 额外强制**接地到外部客观验证器**(便宜模型样本收敛≠正确) |
| 底座 | 闭源 Claude Code + Claude 模型 | 开源 pi + 国产模型(可跑内网、可定制、数据不出网) |

**定位结论**:

1. **一次性前沿大任务**(全库查 bug、大迁移)——Dynamic Workflows 已经更强、零搭建,Piper 不去竞争。
2. **Piper 的护城河 = DW 的盲区**:反复、无人值守、便宜、可客观验证、数据不出网的工作流(每日回归守望)。
   最初动机"更自动化/更便宜/更可定制/国产模型"正好落在这块。
3. **跨生命周期互补**:DW 是"Claude 动态写编排",Piper 是"Claude 离线编译 spec、便宜模型跑"。
   所以 **Dynamic Workflows 可当 Piper 的 authoring 上游**——用它挖 session、生成/打磨 watchdog spec(贵、一次),
   Piper 引擎拿去便宜地反复跑。即本设计「创作期贵一次、运行期便宜」的现成实现路径。

## 三条根本判断

### 1. 可验证性 > 确定性

筛选"哪些任务能交给便宜模型"的标准,不是"流程确不确定",而是**"有没有便宜的客观验证器"**。

- 不确定但可验证(回归归因:可复跑、可查引擎、可查 diff)→ **吃得到 test-time compute 红利**。
- 既不确定又没有便宜验证器(测试框架设计好不好)→ 范围外,投票只是重复偏见。

### 2. test-time compute 是核心价值,不是附属

模型便宜,才负担得起 10–20× 推理。拿便宜 token 换质量,在**有界 + 可验证**的任务上,便宜模型
×N 算力能逼平 SOTA 单次,总价更低。所以 Piper 厚层的核心模块就是 test-time compute 编排器,
而不只是 goal/loop。

**铁律:收敛 ≠ 正确。** 优先"候选答案对着 ground truth 验证",而非"样本之间投票"——5 个样本
一致可能是 5 倍同一个偏见。每个结论必须由一条命令的输出背书(`ground`),无据结论一律不采信。

### 3. 升级只留"授权边界",不留"能力缺口"

上一版架构把"升级给强模型/人"压得太重。重新映射后,判断层其实是四种不同性质的问题:

| 卡点性质 | 解法 | 谁负责 |
|---|---|---|
| 接地纪律(pipeline 绿 ≠ 用例真过) | 协议化:永远验解析后的真值,不信自报 | 厚层验收闸 |
| 可验证推理(真回归 vs 测试 bug vs flake) | test-time compute + 接地验证 | 便宜模型 + 厚层 TTC |
| 工具缺口(多层引号取证、时区陷阱) | 给更好的工具(自带包裹/时区处理) | 薄层工具脚本 |
| 授权/策略边界(删共享 baseline、动 license) | 升级给人——理由是"没被授权",非"判不了" | 厚层授权闸 → 人 |

"升级给强模型"几乎消失(被 TTC 取代),只在 N 次采样对验证器仍不收敛时兜底,极少触发。

## 厚层:Piper 通用原语(写一次,所有 agent 共用)

**重要前提:构建在 pi SDK 之上,不重造轮子。** 研究 pi 源码后(见 `docs/pi-capabilities.md`)发现 pi
不只是 CLI,而是带干净 TS SDK 的 agent 平台。我们原以为要自己写的厚层管道,pi 已免费提供 60–70%:
agent 循环(`createAgentSession`)、模型接入(DeepSeek 内置 + 自定义 provider)、**授权闸**
(`beforeToolCall` hook)、**验证器即工具**(`defineTool`)、**成本记账**(`get_session_stats`)、
**会话分叉做 TTC**(`fork`)、**升级给人的通道**(RPC Extension UI 协议)、skill 加载(直接吃
`~/.claude/skills`)、compaction、瞬态重试。

所以 Piper 厚层 = **只写 pi 不做的那件事:带客观验收和接地验证的多 agent test-time compute 编排**。
下面接口草图里,标 ⓟ 的由 pi 提供机制、我们只配策略;其余是我们的编排代码:

### 执行与控制流
- **`goal(check, dispatch)`** —— 客观验收外环:验收→派 worker→失败带反馈重派,直到 check 通过或预算用尽。worker 用 pi session,外环是我们的。
- **`loop(tick, signal)`** —— 定时/轮询 tick,等某个外部状态变化(形如 babysit-ci 的 ScheduleWakeup)。pi 无调度器,纯我们的。
- **`escalate(reason, payload)`** —— 升级:授权边界停下来问人(ⓟ 走 pi 的 UI 协议通道)/兜底交强模型;升级_策略_是我们的。

### test-time compute(核心模块)
- **`bestOfN(task, n, aggregate)`** —— N 次采样 + 聚合 + 收敛检验;发散即信号。
- **`debate(claim, refute)`** —— 对抗对:一个 worker 主张,另一个被指派证伪。
- **`decompose(question, subchecks[])`** —— 把一个判断拆成若干**带验证器**的子查询,逐项接地。
- **`ground(conclusion, evidence)`** —— 强制结论引用命令输出,拒绝无据结论。
- **`judge(candidates, rubric)`** —— LLM-as-judge 按 rubric 在候选间裁决。

### 支撑设施
- **spec 引擎** —— 跑薄层声明式 spec(步骤 + 验收闸 + 失败→修复表),每步带客观验收,失败先匹配
  remediation 表,没命中走默认 TTC 归因,仍不收敛才 escalate。**我们的。**
- ⓟ 成本/预算记账(`get_session_stats`)、ⓟ 结构化事件日志(observability)、ⓟ 状态持久化
  (session durable 树)、ⓟ 爆炸半径闸(`beforeToolCall`)——机制 pi 给,策略/聚合我们配。

## 薄层:声明式 agent spec 格式

一个 agent ≈ 一份声明(理想 30–80 行),复用现有 skill/脚本当"动作",厚引擎负责跑:

```yaml
agent: <name>
trigger:  { poll | schedule, signal: <外部状态> }
state:    [<跨 tick 持久化的字段>]
verify_principle: <这个项目"真验收"的硬规则,例如"解析 trace 失败数,不信 pipeline 状态">
steps:
  - id: <step>
    action: { skill: <现有 skill> } | { run: <命令> }
    check:  <客观验收闸:退出码 / grep / 状态轮询>
    on_fail:
      - match: <症状正则>  → <remediation 动作>
      - default            → <TTC 归因 or escalate>
verifiers:        # test-time compute 循环可调用的客观验证器(项目专属、可枚举)
  - <名字>: <一条能产出 ground truth 的命令>
judgment_points:  # 每个判断点配:验证器 + 用哪种 TTC 模式
  - <名字>: { mode: bestOfN|debate|decompose, verifiers: [...], escalate_if: <不收敛条件> }
authorization:    # 必须升级给人的写操作(授权边界,非能力边界)
  - <什么算危险写>
```

## 创作期 vs 运行期

**薄是运行时的薄,不是创作时的薄。** 一个新项目的第一个 agent 不可能凭空薄——得有人挖出步骤/
验收/失败模式/验证器/授权边界。这正是"挖 Claude Code session"的活:

> **创作期:用 Claude Code(贵、跑一次)把历史 session 编译成 spec。
> 运行期:Piper(便宜模型 + TTC)永远跑这份 spec。**

这就是"提取交给 Claude、执行交给 pi+国产模型"的落地:贵一次,然后便宜地跑到底。提取本身将做成
一个 Claude Code skill。

## 语言选择(已定)

走 **TypeScript,作为库构建在 pi SDK 之上(in-process)**。研究 pi 后这个决定从"为互操作"升级为
"为复用 pi 的整个 agent 平台":pi SDK 文档明确建议 Node/TS 用 `createAgentSession` 而非 spawn 子进程
——拿到类型安全、直接状态访问、`fork`、自定义工具/hook。RPC 模式只在跨语言时才需要,我们不需要。
现有 Racket `pi.rkt`/`goal.rkt` 的职责被 pi SDK 覆盖,**迁移即弃**。

## 实施纪律

1. **先具体,后泛化。** 先把第一个 agent(api-test master 回归 watchdog)具体地、甚至有点硬编码地
   做出来跑通,见 piper-agents 仓库 `docs/safeline3/api-test-master-watchdog.md`。
2. **两个数据点之前不做泛化。** 跑通 watchdog 后再挖第二个 agent,让公共部分**自己沉淀**成厚层原语。
   不照单一案例造"万能引擎"——那是 v1 翻车的教训(先建元循环求值器,再发现没真需求)。
3. **厚层每加一个原语,都要被 ≥2 个薄 spec 真用到。**
