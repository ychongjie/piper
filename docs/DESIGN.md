# Piper 设计文档

> 一门 **AI 原生的 agent 编排语言**(Racket 实现)。用一组高层"agency 动词"
> ——`goal` / `loop` / `best` / `fan` / `try` / `ask` / `do`——编排 LLM 与 agent harness。
> **模型当 worker,语言当控制平面。** 引擎室是同像性 + 元循环求值器 + 一等 `call/cc`,但作者只写高层意图。

状态:核心已实现(求值器 / `call/cc` / LLM 接入 / 宏 / amb / goal / loop / 自修改 / 编排组合子),
正按编排语言方向收敛(精简原语、两层 worker、`#lang` 可读性、自改进编排)。163 测试全绿。

---

## 1. 目标与定位(北极星)

### 1.1 是什么 / 不是什么

Piper 是 agent / harness 的**编排语言**,**不是**又一个 harness。

- **harness**(如 Claude Code):把"模型 + 工具"变成**一个**会干活的 agent;`/goal`、`/loop`、agent teams 是**固定功能**——能调用,但不能当程序任意嵌套 / 组合,层间协调靠模型临场发挥。
- **编排器**(Piper):`goal` / `loop` / `best` / `fan` 是**语言里的表达式**,返回值、可作为任意其它原语的参数。**灵活的嵌套 / 组合是核心差异**(已机械验证 `loop ⊃ fan ⊃ best ⊃ agent ⊃ goal` 任意套)。
- 分工:**模型 / 真 harness 当 worker,语言当控制平面。** 控制平面贡献搜索 / 回溯 / 择优 / 调度 / 自适应——看得见、必须出力,而不是"模型一次做完、语言没出力"。

### 1.2 工作层级:agency 动词,不是 go/chan

原语在"**agent 在干什么**"这一层,而非线程 / 通道。续延、并发、eval、快照全部降为**引擎室(substrate)**,不进用户词汇——作者永远不碰 `call/cc`。哲学是**少而胖**:每个原语本身高层、可配置(与 Go 的"少而薄"相反)。

### 1.3 三个 Scheme 特性的真实角色:引擎室,而非"即 agent"

(早期把三特性 1:1 等同于 agent,已不准。新口径:它们服务的是**编排**。)

| 特性 | 在编排器里撑起什么 |
|---|---|
| **元循环求值器** | 把 LLM 织入求值——`goal` 的"观察→生成下一步→eval→检查"由此长出;eval 是编排程序的引擎(不等于某个 agent 的循环) |
| **一等 continuation** | **编排**的可暂停 / 可回溯控制状态:`amb` 回溯、`loop` 重入、`capture/restore` 事务、(未来)挂起等审批 |
| **同像性(code = data)** | **编排**可自我改写的载体:LLM 吐可组合代码、`redefine!`、以及"自改进编排"(§3) |

### 1.4 价值轴(四根支柱)

一句话:**把不可靠 / 昂贵 / 有副作用的 AI agent,变成可编排的积木**,在四个轴上增值。

| 支柱 | 是什么 | 靠什么 | 状态 |
|---|---|---|---|
| **① 程序化编排(地基)** | 把 coding agent(claude/pi)的编排从"内部命令 / 手动执行"变成**可组合、自动运行的程序** | `agent`/`fan`/`best`/`loop`/`goal` + `shell` 真实反馈 | ✅ 基本实现(`examples/fix-compete.piper`) |
| **② 可靠化:组合换可靠** | 用**多个不可靠 run 组合出可靠产出**(不是把单个 agent 变强) | `best`/`vote`/`amb`、跨模型/跨 harness 评审团、keep-best、不信自我汇报 | ✅ 有 demo(`panel`) |
| **③ 安全化:可逆 + 受限 + 可审批** | 让无人值守自动化从"冒险"变"可控"——**最被低估,却决定敢不敢真放手** | 能力沙箱 `eval-in`、事务 `capture/restore`(+文件快照待补)、人审挂起(`call/cc`) | ⚠️ 部分(文件级事务、durable 人审待补) |
| **④ 自改进:越用越好** | 编排把确定步骤沉淀成代码、积累技能,变便宜 / 快 / 可靠 | crystallize / `settle`(frontier→scaffold,§3)、`learn!`、`evolve!`/`improve!` | ⏳ 最有 insight、最未证明 |

次级(派生但真实):**可审计 / 可复现**(编排即数据、`redefine-log`)、**成本优化**(两层 + 模型分级 + 自改进)。

排序:① 是地基(已做到);**③ 安全化最被低估**、却决定"敢不敢真放手";④ 自改进最独特但别全押。

---

## 2. 原语集(agency 的动词,其余皆库)

worker = `(lambda (task) -> 结果)`;仅 `model` / `agent` 两个构造器;控制平面对 worker 类型一视同仁。

| 原语 | 含义 | 状态 |
|---|---|---|
| **`goal`** | 追求一个目标直到达成(agent 自主决定步骤) | ✅ |
| **`loop`** | 重复:**收敛式**(直到达标 `until` / `times` / `self-paced` 的 `stop`)/ **反应式**(常驻 `every`) | ✅ |
| **`best`** | 在多个不确定尝试中择优(score 可为函数,也可为标准字符串 → 自动 `judge`) | ✅ |
| **`vote`** | 多个尝试多数表决 | ✅ |
| **`fan`** | 同一件事**并行**交给多个 worker / 并行处理一批输入 | ⚠️ 现为顺序 `fan-out`,并发待补(§7) |
| **`try`** | 试探性地做,坏了回滚 | ✅(状态级);文件级事务待补 |
| **`amb` / `require`** | 非确定性选择 + 回溯搜索 | ✅ |
| **`ask` / `model`** | 调用认知层(LLM):想 | ✅ |
| **`do` / `agent`** | 调用执行层(pi):干 | ✅ |
| **`judge`** | 给内容按标准打 0-10 分(`best` 的 score) | ✅ |
| **`propose`** | 生成 n 个候选(`amb*` 的搜索空间) | ✅ |
| **`settle`** | 把被验证为确定的步骤沉淀进骨架(§3) | ⏳ 待设计 |

`vote` / `race` / `timeout` / `evolve!` / `improve!` / `debate` / `pipeline` 等皆为上面几样的**库组合**——就像 Go 用 `go`+`chan` 搭出一切。

### 2.1 两层 worker + 边界规则(llm 想 / pi 干)

- **认知层(`llm`)** = 编排器的"脑子":纯、无副作用、只看 prompt。`model` / `ask` / `judge` / `propose`。`lib/cognition.piper`。
- **执行层(`pi`)** = 被派出的自主 agent:重、有工具 + 循环 + 副作用。`agent`。`lib/agents.piper`。
- **边界 = 碰不碰环境**:认知层要参考本地代码,就由控制平面 `(read-files …)` 读出来拼进 prompt(认知层仍是纯函数,可缓存 / 可 mock);"该看哪些代码"本身需要探索,则改用 `(agent …)`。
- worker 后端中立:`llm` 走开源插件生态(默认),`pi` 走任意开源端点(§附录 A);`claude`/`codex` 也能包成 agent,但锁厂商 / 计费,默认不用。

### 2.2 组合即差异(核心论据)

原语是表达式,可任意互套——这是固定功能 harness 给不了的:

```scheme
(loop (every 3600)                                   ; 反应式常驻
  (fan-out open-mrs (lambda (mr)                       ; 每个 MR(将来并行)
    (define review
      (best (map (lambda (_) (agent (repo mr))) (range 3))  ; 3 个 agent 竞争
            (fmt "review MR {}" mr) "最严重、最有依据"))      ; 认知裁判择优
    (when (risky? review)
      (goal (fmt "深查 MR {} 的风险" mr)                  ; 嵌套:升级成自主 goal
        (tools (list (cons 'run-tests rt))) (max-steps 15)))
    (post mr review)))))
```

---

## 3. 自改进编排:frontier → scaffold

编排有两轨:**scaffold**(确定的固定代码)与 **frontier**(LLM 驱动)。agent 把执行中**被验证为确定**的步骤(如 `loop review` 里"查 MR 内容")从 frontier **沉淀进 scaffold**——该步不再走 LLM。

效果:**用得越久,编排越便宜 / 快 / 可靠**,LLM 只留在真正新颖处。这是保留同像性 + 自修改的根本理由。

机制(零件已具备):历史即数据(同像性)→ 检测确定性 → `redefine!` 改写编排 → `capture/restore` + 验证。
难点:① 确定性判定(需证据阈值 + 沉淀后验证 + 可回退);② 改写活控制流的安全(事务 + 逃生舱)。
光谱:缓存决策(轻)→ 提取命名工具(中,见 `lib/grow.piper` 的 `learn!`)→ **删掉 LLM 决策点、焊进骨架**(`settle`,最彻底)。

---

## 4. 可读性:先定语义,后定皮

表层用 Racket **`#lang` 自定义 reader** 做友好语法,**展开回核心 s-expr**;同像性保留(表层 → 规范 s-expr,自改写在 s-expr 上做)。渐进两档:

- **轻档**(已做一半):具名参数(`goal`/`loop`/`best` 的 clause)+ `fmt` 模板 + `model`/`agent` 双模式 + `best` 接受字符串 score。
- **重档**(语义定稿后):缩进 / 无括号 DSL。理想形态见 §8。

---

## 5. 架构:引擎室(substrate)

```
  编排程序(人写,或 LLM 生成):goal / loop / best / fan / try / ask / do 的组合
        │  库:lib/*.piper —— 这些 agency 动词都是库代码,可被 redefine!
  ┌─────▼───────────────────────────────────────┐
  │ 引擎室(Racket,src/*.rkt):                   │
  │   Reader        同像性:文本 → s-expr           │
  │   eval / apply  元循环;唯一特权控制:call/cc    │
  │   Environment   frame 链,数据(自修改/快照基石) │
  │   Continuation  委托宿主 call/cc(amb/loop/事务) │
  │   eval-in       能力沙箱(白名单,LLM 代码受限)  │
  └─────┬────────────────────────┬────────────────┘
        │ 认知(纯)              │ 执行(副作用)
  ┌─────▼────────┐         ┌─────▼────────┐
  │ llm CLI       │         │ pi CLI        │   worker(开源模型)
  │ model / ask   │         │ agent         │
  └───────────────┘         └───────────────┘
        │ 真实世界:shell / read-file / write-file
```

### 5.1 Reader(同像性)
复用 Racket `read`:LLM 文本 `(read (open-input-string …))` 即得可 `eval`、可改写的 s-expr。

### 5.2 元循环求值器(`eval` / `apply`)
直接风格,跑在宿主栈上。特殊形式:`quote if define define-macro set! lambda begin let let* letrec cond and or call/cc`。可应用对象:闭包 / 原语 / continuation / 宏。
**小核心,库生长**:唯一进 cond 的控制特殊形式是 `call/cc`;`amb`/`goal`/`loop`/`best` 全是库(`define-macro` + 过程),因此可被 `redefine!`。

### 5.3 Environment(数据)
frame 链(可变 hash),全局 frame 单独持有 → `capture`/`restore`(快照 / 回滚)与 `redefine!` 都不依赖序列化。

### 5.4 Continuation
Piper 的 `call/cc` 直接委托宿主 Racket `call/cc`(解释递归跑在宿主栈上,无需写 CPS)。`capture`/`restore` 是**状态检查点**(只滚全局 env,不做控制跳转;控制跳转归 `call/cc`)。`amb` = `call/cc` + 失败栈。

### 5.5 LLM / agent I/O
- **认知**:shell 出 [`llm`](https://github.com/simonw/llm)。backend 可注入(`current-llm`,测试用 mock);默认模型 `deepseek-v4-pro`;`current-max-tokens` 防截断;`current-llm-verbose` 把输入/输出/耗时打到 stderr;spawn 时剥 `*_proxy`。
- **执行**:shell 出 [`pi`](https://github.com/earendil-works/pi)(`agent`),任意开源端点(§附录 A)。
- **能力沙箱 `eval-in`**:LLM 生成的步骤在**只含授予工具**的隔离环境求值,碰不到 `+`/`car`/`llm`/`redefine!` 等。

### 5.6 read-all 语义
`eval-file`/`eval-string` 先把**所有**顶层 form 读进列表再逐个求值——这样 `amb` 回溯跳回前面的 form 时约束会被重新检查(从可变 port 逐个读则会"读过头")。

---

## 6. 实现现状(已落地)

| 模块 | 文件 | 内容 |
|---|---|---|
| 环境 | `src/env.rkt` | frame 链;定参 / 点对 / 变参 |
| 求值器 | `src/eval.rkt` | `peval`/`papply` + 特殊形式 + `define-macro` + `letrec`/`let*`/具名 `let`;`call/cc` |
| 原语 | `src/primitives.rkt` | 算术/比较/list/字符串(+`fmt`/`shell-quote`/`string-trim`)/字符/IO;`shell`/`read-file`/`write-file`;`eval`/`eval-in`/`try`/`->string`/`repr`;`capture`/`restore`;`procedure-source`/`redefine!`/`redefine-log`/`protected?`;`llm`/`llm-code` |
| LLM 接入 | `src/llm.rkt` | 可注入 backend、剥代理、max_tokens、verbose 日志、围栏清洗 |
| 装配 | `src/interp.rkt` | read-all、加载 `lib/*.piper`、REPL/文件运行 |
| 标准库 | `lib/prelude.piper` | `map`/`foldl`/`zip`/`range`/… + `when`/`unless` + `ask`/`gen` |
| 回溯 | `lib/amb.piper` | `amb`/`amb*`/`require`(call/cc + 失败栈) |
| 控制平面 | `lib/orchestrate.piper` | `fan-out`/`best`/`vote`/`best-by`/`tally`/`shell-ok?`/`read-files` |
| 认知层 | `lib/cognition.piper` | `model`/`judge`/`propose` |
| 执行层 | `lib/agents.piper` | `agent`(派 pi 子 agent) |
| goal | `lib/agent.piper` | `goal-run`(driver)+ `goal`(clause 宏)+ `eval-in` 工具白名单 |
| loop | `lib/loop.piper` | `loop-times`/`until`/`self-paced` + `loop` 宏(call/cc break) |
| 自修改 | `lib/self-modify.piper` | `improve!`/`evolve!`(失败驱动)/`with-checkpoint` |
| 自生长 | `lib/grow.piper` | `learn!`(给自己写并装上新技能,事务 + 重试) |

测试 `tests/`(163 例,真实 LLM 走 mock);示例 `examples/`(含真实 LLM 的 panel/goal/loop/fix-compete/evolve-calc/grow/self-modify)。

### 6.1 安全模型(✅ 已实现)
能力白名单(`eval-in`)、核心绑定保护(`redefine!` 拒改 `restore`/`eval`/… 除非 `force-redefine!`)、事务 + 冒烟(`capture`/`restore` + `try`)、审计(`redefine-log`)、预算(`goal` 的 `max-steps`)。待加:人审挂起点(`call/cc` 地基已具备)。

### 6.2 选型复核(结论:维持 Racket + 手写求值器)
`call/cc` 是灵魂(回溯 / 挂起 / 检查点,主流语言别扭)→ 维持 Racket;宏长"胖原语" → 维持;同像性因"自改进编排"重新成刚需 → 维持手写求值器(沙箱 eval + 可改写 + 将来可序列化续延)。

---

## 7. 路线图与缺口

组合 / 嵌套的**语义已成立**;要在执行层**又快又稳**,缺三块引擎室能力(都在 substrate,不动高层词汇):

1. **并发与本机调度(优先级最高)**:**目标 = 本机并发调度 ≤100 个 agent run**(不做跨机海量——那时 Piper 当策略层、套在外部分布式 runtime 上,见下)。`fan`/`best` 现为顺序 → 嵌套时延迟叠加。agent run 是 **I/O 密集**,Racket **绿色线程**很适配:`thread`/`channel`/`sync` + 并发上限信号量 + token/$ 预算 + per-item 隔离重试 + 超时;顺带白送 `race`/`timeout` 与 agent 间通信。**这块是"大规模"(本机 ≤100)的总开关。**
2. **工作区事务**:`capture/restore` 只滚 Piper 状态、滚不了 agent 改的文件。补 `snapshot-dir`/`restore-dir`(git/cp),让 `try` 回滚有副作用的执行层组合。
3. **逐项错误隔离**:`fan`/`loop` 里单个 worker 抛错会掀翻整组;在其内建 per-item `try`。

语义与表层:
4. **原语集定稿**:把 agency 动词(尤其 `loop` 两态、`best` 多选法、`fan`、`settle`)写成规格 + 测试。
5. **可读性 `#lang`**:轻档已做一半;语义定稿后写重档 reader。
6. **`settle`(自改进编排)**:确定性判定策略 + 改写活控制流的安全;是否升为原语。

更远:
7. **可序列化 continuation**:去函数化成显式栈 → 跨进程挂起 / 恢复(常驻 agent 抗重启、等人审批跨会话)。
8. **多 worker 协作**:debate / 黑板 / 市场(建在并发 + channel 之上)。

---

## 8. 理想形态:常驻评审编排(嵌套 + 自改进)

同一段编排两种写法——**重档 `#lang` 表层**(目标形态,reader 待写)与它**展开成的核心 s-expr**(`fan`/`settle` 待实现外今天可写)。

### 重档 `#lang piper`(目标形态)
```
#lang piper

loop every 1h:
    fan mr in open-mrs():                          # 每个 MR 并行
        review = best 3 by "最严重、最有依据":        # 3 个 agent 竞争 + 认知裁判
            agent in repo(mr): "review MR {mr},找出问题"
        when risky(review):
            goal "深查 MR {mr} 的风险":              # 嵌套:升级成自主 goal
                tools:     run-tests, read-file
                until:     verdict-ready()
                max-steps: 15
        post(mr, review)

    settle steps stable-for 5                       # 沉淀:连续 5 轮确定的步骤焊进骨架
```

### 展开成的核心 s-expr(今天的写法)
```scheme
(loop (every 3600)
  (fan-out open-mrs (lambda (mr)
    (define review
      (best (map (lambda (_) (agent (repo mr))) (range 3))
            (fmt "review MR {} 找出问题" mr)
            "最严重、最有依据"))
    (when (risky? review)
      (goal (fmt "深查 MR {} 的风险" mr)
        (success?  verdict-ready?)
        (tools     (list (cons 'run-tests rt) (cons 'read rd)))
        (max-steps 15)))
    (post mr review)))))
```

集齐了 Piper 想证明的一切:**嵌套组合**、**两层 worker**、**真实反馈 + 择优**、(`settle`)**frontier→scaffold 自改进**。

---

## 附录 A. 执行层(pi)配置

pi 用 **Custom Provider** 指到现有 OpenAI 兼容开源端点(如 SiliconFlow),复用开源模型、不用新账号。**密钥写在 `~/.pi/agent/models.json`(仓库之外,`chmod 600`),绝不进代码仓库。**

```json
{
  "providers": {
    "siliconflow": {
      "baseUrl": "https://api.siliconflow.cn/v1",
      "api": "openai-completions",
      "apiKey": "<你的 key,不要提交>",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        { "id": "deepseek-ai/DeepSeek-V4-Pro" },
        { "id": "deepseek-ai/DeepSeek-V4-Flash" },
        { "id": "Pro/moonshotai/Kimi-K2.6" }
      ]
    }
  }
}
```

`lib/agents.piper` 默认 `*agent-provider* = "siliconflow"`、`*agent-model* = "deepseek-ai/DeepSeek-V4-Pro"`;`agent` 调 pi 前 `env -u *_proxy`。实测 pi agent 能在沙箱目录用 `read`/`bash`/`edit`/`write` 完成任务。

## 附录 B. 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 宿主语言 | Racket | `call/cc` + 宏 + `#lang` + 电池齐;选型复核(§6.2)维持 |
| continuation | 原生 `call/cc`,先进程内 | 无需先写 CPS;可序列化留作升级(§7) |
| 认知 worker | [`llm`](https://github.com/simonw/llm) CLI | 瘦补全 + 开源模型插件生态 |
| 执行 worker | [`pi`](https://github.com/earendil-works/pi) CLI | 开源厚 harness,任意 provider(不锁厂商) |
