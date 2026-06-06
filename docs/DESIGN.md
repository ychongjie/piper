# Piper 设计文档

> 一门 AI 原生的 Lisp 方言。它把 SICP 的三件武器——**同像性、元循环求值器、一等 continuation**——
> 直接对应到 AI agent 的三个核心诉求:**可自我重写的计划、可被 LLM 编织的求值循环、可暂停/回溯的执行状态**。
> 语言原生支持 `goal`(追求目标直到达成)与 `loop`(周期/自定步重入),并支持**运行时自修改**。

状态:**设计阶段(v0)**。本文是动手前的蓝图,不是最终实现。

---

## 0. 决策记录(已拍板)

| 决策 | 选择 | 理由 |
|---|---|---|
| 宿主语言 | **Racket** | 电池最齐:子进程、JSON、包管理、IDE 现成;`#lang` 机制让 Piper 将来可做成独立 `#lang piper`;迭代最快。 |
| continuation | **原生 `call/cc`,先进程内** | 直接委托宿主 `call/cc` 即可让 Piper 拥有一等 continuation,**无需先写 CPS**;暂不要求可序列化(对应"先进程内")。 |
| LLM 接入 | **外部 CLI:[`llm`](https://github.com/simonw/llm)** | 一个"prompt 进 / 文本出"的瘦原语,正好补元循环器缺的那块。不选 [pi](https://github.com/earendil-works/pi)——它本身是个 agent,会和我们要手搓的 agent loop 职责重叠。 |
| LLM 风格 | **显式 `ask`/`llm` + 可选隐式空洞填充** | MVP 先做显式原语(边界清晰、可测试);`goal` 内部用 LLM 自动求解作为"隐式"那一档。 |

---

## 1. 愿景与定位

普通语言里,程序是死的:写定、编译、运行。Piper 里程序是**活的**——它是 LLM 与人共同在运行时持续编写的 s-expr 树。

三个特性各自兑现一项能力:

| Scheme 特性 | Agent 诉求 | 在 Piper 里的兑现点 |
|---|---|---|
| **同像性(code = data)** | 计划要能被读取、推理、改写 | LLM 吐出的字符串 `read` 成 s-expr,既能 `eval` 又能被 agent 当数据反思/重写;`goal`/`loop`/`tool` 都是宏。 |
| **元循环求值器** | 求值的每一步都要能插桩、注入 LLM、处理空洞 | 我们拥有 `eval`/`apply`,于是 **eval 循环 = agent 循环**:可记录 trace、遇到高层目标就问 LLM、失败就让 LLM 修复重试。 |
| **一等 continuation** | 暂停/恢复、回溯、检查点 | `call/cc` 给出:等工具/审批时**挂起**、计划失败就**回溯**(amb)、把执行状态**捕获成检查点**用于事务性自修改。 |

一句话:**eval 循环即 agent 循环,continuation 即 agent 的可暂停状态,同像性即 agent 可自我重写的载体。**

---

## 2. 设计原则

1. **小核心,宏生长**:核心求值器只认少数特殊形式;`goal`/`loop`/`tool`/`amb` 等都用宏在语言内部生长出来。
2. **LLM 是一种求值策略,不是外挂**:`ask`/`llm` 是一等原语,可出现在任意表达式位置;`goal` 把"LLM 生成下一步 → eval → 检查"做成内建循环。
3. **环境是数据**:全局环境是我们自己持有的 frame 结构,因此自修改与快照都不依赖序列化。
4. **可暂停优先于高性能**:控制流以 continuation 为中心设计,宁可慢也要能挂起/回溯。
5. **自修改必须可回滚**:任何 `redefine!` 都在可快照的事务里发生,坏了能恢复。
6. **平滑升级**:直接风格求值器 → 将来去函数化成显式栈(continuation 变数据结构)即可获得可序列化,语义层不动。

---

## 3. 架构总览

```
              源码 / LLM 产出的字符串
                       │
                ┌──────▼──────┐
                │   Reader     │  同像性:文本 → s-expr(datum)
                └──────┬──────┘
                       │ s-expr
                ┌──────▼───────────────────────────────┐
                │      元循环求值器 (eval / apply)        │
                │  ┌─────────────────────────────────┐  │
                │  │ 特殊形式: quote if lambda define  │  │
                │  │           set! begin call/cc ...  │  │
                │  ├─────────────────────────────────┤  │
                │  │ Agent 层(宏 + 原语):             │  │
                │  │   ask / llm / llm-code            │  │
                │  │   amb / require                   │  │
                │  │   goal / loop                     │  │
                │  │   redefine! / capture / restore   │  │
                │  └─────────────────────────────────┘  │
                └──────┬───────────────┬────────────────┘
                       │               │
              ┌────────▼──────┐  ┌─────▼─────────┐
              │ Environment    │  │ Continuation   │
              │ (frame 链, 数据)│  │ (宿主 call/cc) │
              └────────┬───────┘  └────────────────┘
                       │ 工具调用 / LLM 调用
              ┌────────▼───────────────────────────┐
              │  Effects 层:tool 注册表 + 能力白名单  │
              │   - shell / 文件 / 网络 ... (受控)     │
              │   - llm 子进程 (simonw/llm CLI)        │
              └─────────────────────────────────────┘
```

代码组织(计划):

```
piper/
├── docs/
│   └── DESIGN.md            ← 本文
├── src/
│   ├── reader.rkt           ← 读取(MVP 先复用 Racket reader)
│   ├── datum.rkt            ← 核心数据表示
│   ├── env.rkt              ← 环境(frame 链,first-class)
│   ├── eval.rkt             ← 元循环 eval/apply
│   ├── special-forms.rkt    ← 特殊形式
│   ├── continuation.rkt     ← call/cc 封装、capture/restore
│   ├── llm.rkt              ← llm CLI 原语 + prompt 渲染
│   ├── amb.rkt              ← 非确定性求值/回溯
│   ├── agent.rkt            ← goal / loop 宏
│   ├── self-modify.rkt      ← redefine! + 事务快照
│   └── tools.rkt            ← 工具注册表 + 能力白名单
├── lib/                     ← 用 Piper 自身写的标准库(.piper)
├── examples/
└── tests/
```

---

## 4. 核心数据表示与 Reader(同像性)

MVP 直接复用 Racket 的 `read`,把 Piper 程序当作 Racket datum 读入。这样 LLM 产出的字符串经 `read` 即得到可 `eval` 的树。

```scheme
;; AI-native 的关键一步:LLM 文本 → s-expr → 既能 eval 又能被改写
(read (open-input-string (llm "...prompt..."))) ; => 一棵 s-expr
```

未来若要自定义语法(如 `#:`-关键字、goal 块的特殊读法),再写专用 reader 或做成 `#lang piper`。

数据类型(MVP):符号、数字、字符串、布尔、pair/null、过程(闭包)、原语过程、continuation 对象、`amb` 失败哨兵。

---

## 5. 元循环求值器(`eval` / `apply`)

经典 SICP 结构,直接风格(跑在宿主栈上):

```scheme
(define (eval exp env)
  (cond
    [(self-evaluating? exp) exp]
    [(symbol? exp)          (lookup exp env)]
    [(special-form? exp)    (eval-special exp env)]   ; quote if lambda define set! begin ...
    [else                   (apply (eval (car exp) env)
                                    (map (λ (a) (eval a env)) (cdr exp)))]))

(define (apply proc args)
  (cond
    [(primitive? proc)   (apply-primitive proc args)]
    [(closure? proc)     (eval (closure-body proc)
                               (extend-env (closure-params proc) args (closure-env proc)))]
    [(continuation? proc)(invoke-continuation proc args)]
    [else (error "not applicable" proc)]))
```

求值器**拥有控制权**这一点是 agent 化的全部基础:`goal` 的 step 循环、trace 记录、错误时问 LLM,都是在这一层插入。

### 环境模型(环境是数据)

环境是 frame 的链表,每个 frame 是一个可变 hash;全局 frame 单独持有,便于自修改与快照:

```scheme
(struct env (vars parent) #:mutable)         ; vars: mutable hash
(define (extend-env params args parent) ...)  ; 新 frame
(define (lookup sym env) ...)                 ; 沿链查找
(define (define! sym val env) ...)            ; 当前 frame 绑定
(define (set!! sym val env) ...)              ; 沿链改写

;; 自修改/快照的基石:
(define (snapshot-global) (hash-copy (env-vars *global*)))
(define (restore-global! snap) (set-env-vars! *global* (hash-copy snap)))
```

---

## 6. Continuation 模型

MVP:**Piper 的 `call/cc` 直接委托宿主 Racket 的 `call/cc`**。因为解释递归跑在宿主栈上,宿主捕获的 continuation 即 Piper 的 continuation——**不写 CPS 也得到一等 continuation**。

```scheme
;; 特殊形式 (call/cc (lambda (k) ...))
;; 实现:用宿主 call/cc 捕获,把宿主续延包成 Piper continuation 对象
(define (eval-callcc exp env)
  (call-with-current-continuation
   (λ (host-k)
     (define k (make-piper-continuation host-k))
     (apply (eval (callcc-proc exp) env) (list k)))))
```

衍生能力:`amb` 回溯、`goal` 的搜索、工具/审批前的挂起,统统建在它上面。

**升级路径(非 MVP)**:当需要"挂起数小时 / 跨进程恢复 / 抗崩溃"时,把直接风格求值器**去函数化**成显式栈解释器,continuation 成为可序列化的数据结构。届时语义层(goal/loop/amb/redefine!)无需改动——这是第 2 节"平滑升级"原则的兑现。

---

## 7. LLM 接入(`llm` CLI 原语)

把 [simonw/llm](https://github.com/simonw/llm) 当作一个无状态补全子进程:

```scheme
;; 原语:文本进 → 文本出
(define (llm prompt #:system [sys ""] #:model [m (current-model)])
  (parameterize ([current-subprocess-custodian (make-custodian)])
    (define-values (sp out in err)
      (subprocess #f #f #f (find-executable "llm")
                  "-m" m "-s" sys prompt))
    (begin0 (port->string out)
      (subprocess-wait sp) (close-input-port out)
      (close-output-port in) (close-input-port err))))

;; 同像性兑现:LLM → s-expr
(define (llm-code prompt #:system [sys *code-system*] . ctx)
  (read (open-input-string (llm (render prompt ctx) #:system sys))))
```

`*code-system*` 是一段系统提示,约束模型**只输出一个合法的 Piper s-expr,不带解释、不带 markdown 围栏**。`render` 负责把目标、可用工具签名、历史 trace 拼成 prompt。

多 provider / 本地模型 / 日志(SQLite)全由 `llm` CLI 的插件体系承担,Piper 不重复造。

---

## 8. Agent 层语义

### 8.1 `ask` / `llm` / `llm-code`

显式 LLM 调用,可出现在任意表达式位置:

```scheme
(ask "总结这段 diff 的风险")                  ; => 字符串
(llm-code "写一个把列表去重的过程" )           ; => 一棵可 eval 的 s-expr
(eval (llm-code "...") (current-env))          ; 生成即运行
```

### 8.2 `amb` / `require`(非确定性 + 回溯)

SICP amb 求值器的语义,候选可由 LLM 生成:

```scheme
(define strat (amb 'rebase 'merge 'cherry-pick))
(require (strategy-works? strat))   ; 失败 → 回溯到 amb 换下一个
```

```scheme
;; LLM 驱动的 amb:候选本身来自模型
(define plan (amb* (llm-code "给出 3 个修复测试的不同策略,返回一个 list")))
(require (plan-passes? plan))
```

实现:维护一个失败 continuation 栈;`(require #f)` 调用栈顶失败续延回到最近的 `amb`。

### 8.3 `goal`(追求目标直到达成)

> 灵感来自 Claude Code 的 `/goal`:给定目标 + 成功判据,agent 自行迭代直至达成或耗尽预算。

```scheme
(goal "把 repo 里所有测试跑绿"
  #:success?  (lambda () (tests-pass?))
  #:tools     (list run-tests read-file edit-file)
  #:max-steps 20
  #:on-fail   'backtrack)        ; 'backtrack | 'ask-human | 'abort
```

语义(去糖后的核心循环):

```
GOAL(desc, success?, tools, max-steps):
  history := []
  repeat up to max-steps:
    if (success?) -> return success(history)
    step  := llm-code(render(desc, tools, history))   ; LLM 产出下一条 s-expr
    ckpt  := capture()                                 ; 每步前捕获 continuation+env 快照
    result:= eval(step, env)                           ; 执行(可能是工具调用 / 新代码)
    history := history ++ [(step, result)]
    if (step-failed? result) and on-fail == 'backtrack -> restore(ckpt)
  -> exhausted(history)         ; 交给 on-fail 处理:ask-human / abort
```

要点:
- **每步前 `capture`**,失败可回溯到上一个好状态(continuation + env 快照协同)。
- LLM 只被允许调用 `#:tools` 白名单内的过程(见第 9 节安全模型)。
- `history` 是 s-expr 数据,可被反思、摘要、用于自改进。

### 8.4 `loop`(周期 / 自定步重入)

> 灵感来自 Claude Code 的 `/loop`:把一个任务按间隔或自定步反复执行。

```scheme
;; 固定间隔
(loop #:every 5min
  (when (new-pr?) (review-latest-pr)))

;; 条件直到
(loop #:until (deployed?)
  (check-ci) (sleep 30sec))

;; 自定步:由 LLM 决定下次何时、带什么上下文重入(对应 /loop 不带间隔)
(loop #:self-paced
  (define next (review-one-item))
  (resume-when (llm-code "根据这次结果,返回 (delay <秒>) 或 (stop)" next)))
```

语义:每轮结束**捕获 continuation**;`#:every`/`#:until` 用定时/谓词驱动重入,`#:self-paced` 由 LLM 决定调度。进程内 MVP 用宿主定时器;将来可序列化后,挂起可跨进程持久化(对接 Claude Code 的 ScheduleWakeup/cron 思路)。

### 8.5 `redefine!` / `capture` / `restore`(自修改 + 事务)

```scheme
;; 事务性自修改:坏了能回滚
(define ckpt (capture))                       ; 抓 continuation + 全局 env 快照
(redefine! 'review-latest-pr
  (llm-code "根据最近 3 次失败改进这个过程,返回新的 lambda"
            (procedure-source review-latest-pr)
            (recent-failures 3)))
(unless (smoke-test-ok?) (restore ckpt))      ; 冒烟不过 → 回到改之前
```

- `capture`:返回一个包含「全局 env 快照 + 当前 continuation」的检查点对象。
- `restore`:换回 env 快照并跳回 continuation(用 call/cc)。
- `redefine!`:改写全局 frame 里的绑定;`procedure-source` 取闭包源(因同像性,源就是 s-expr)。

---

## 9. 自修改安全模型

自修改是核心卖点,也是最大风险。控制手段:

1. **能力白名单**:LLM 生成的代码默认运行在**受限环境**里,只能访问显式授予的工具(`#:tools`)。`shell`/文件写/网络等"危险原语"必须显式注入,否则在受限环境查不到绑定。
2. **核心保护**:`eval`/`apply`/`redefine!`/`restore` 等核心绑定标记为 protected,`redefine!` 拒绝改写它们(除非显式 `--allow-core`)。
3. **事务 + 冒烟测试**:所有自修改走 `capture`/`restore` 事务;改完跑冒烟测试,不过即回滚。
4. **审计日志**:每次 `redefine!` 记录(时间、目标、旧源、新源、触发原因)到 append-only 日志,可回放/审查。
5. **预算约束**:`goal`/`loop` 带 `#:max-steps` / token / 时间预算,防失控。
6. **人审挂起点**:`#:on-fail 'ask-human` 或工具标 `#:requires-approval`,用 continuation 挂起等人确认。

---

## 10. MVP 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 求值器** | reader(复用 Racket)+ env + eval/apply + 基本特殊形式 | 能跑 `(define (fact n) ...)` 等纯 Scheme |
| **M1 continuation** | `call/cc` 委托宿主 + `capture`/`restore` | 能用 call/cc 实现 generator;能快照/回滚全局 env |
| **M2 LLM 原语** | `llm` 子进程 + `ask` + `llm-code` + prompt 渲染 | `(eval (llm-code "写个加法") env)` 生成即运行 |
| **M3 amb** | `amb`/`require` 回溯 + LLM 驱动的 `amb*` | SICP 经典 amb 谜题通过;LLM 候选回溯通过 |
| **M4 goal** | `goal` 宏 + step 循环 + 回溯 + 工具白名单 | 一个玩具 goal(如"让某测试通过")端到端达成 |
| **M5 loop** | `loop` 宏:`#:every` / `#:until` / `#:self-paced` | 周期任务与自定步任务各跑通一个 demo |
| **M6 自修改** | `redefine!` + 事务 + 审计 + 安全模型 | agent 自我改写一个过程并在冒烟失败时回滚 |

每个里程碑配示例 + 测试,放 `examples/` 与 `tests/`。

---

## 11. 开放问题(待后续定)

1. **Prompt 工程**:`render` 如何把 trace/工具签名压缩进上下文?长历史怎么摘要?
2. **s-expr 校验**:LLM 产出非法/越权代码时的解析与拒绝策略(沙箱 eval + 静态白名单检查)。
3. **`amb` 与 continuation 的交互**:回溯栈在挂起/恢复下的语义边界。
4. **可序列化时机**:何时值得把求值器去函数化?触发条件(需要跨进程挂起)是什么?
5. **`loop #:self-paced` 调度**:进程内定时器 vs. 外部调度器(cron/wakeup)的对接面。
6. **多 agent**:goal 内部能否 spawn 子 goal?continuation 能否在 agent 间传递?

---

## 12. 示例:一个会自我改进的评审循环(目标形态)

```scheme
;; 周期评审最新 PR;若连续失误,自己改写评审过程
(loop #:every 10min
  (when (new-pr?)
    (define ckpt (capture))
    (define verdict
      (goal "评审最新 PR 并给出可执行结论"
        #:success? (lambda () (verdict-ready?))
        #:tools    (list read-diff run-tests post-comment)
        #:max-steps 15))
    (record! verdict)
    ;; 自改进:最近三次评审若被人工推翻,改写评审策略
    (when (>= (recent-overrides 3) 2)
      (redefine! 'review-strategy
        (llm-code "依据最近被推翻的评审,改进策略,返回新 lambda"
                  (procedure-source review-strategy)
                  (recent-overrides 3)))
      (unless (smoke-test-ok?) (restore ckpt)))))
```

这段程序集齐了四样东西:**loop 重入、goal 求解、LLM 生成代码、事务性自修改**——也就是 Piper 想要证明的东西。
