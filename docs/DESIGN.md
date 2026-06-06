# Piper 设计文档

> 一门 AI 原生的 Lisp 方言。它把 SICP 的三件武器——**同像性、元循环求值器、一等 continuation**——
> 直接对应到 AI agent 的三个核心诉求:**可自我重写的计划、可被 LLM 编织的求值循环、可暂停/回溯的执行状态**。
> 语言原生支持 `goal`(追求目标直到达成)与 `loop`(周期/自定步重入),并支持**运行时自修改**。

状态:M0–M6 已实现 + 自进化 / 自我生长 / 编排层已落地。

## 定位(方向性结论)

Piper 是 AI agent / harness 的**编排语言**,不是又一个 harness。

- **harness**(如 Claude Code):把"模型+工具"变成**一个**会干活的 agent,agent loop 是**写死**的。
- **编排器**(Piper):把**多个 agent run** 当可组合的值,组成结果——fan-out、投票、回溯、调度、自适应。
- 分工:**模型(或 shell 出去的真 harness)当聪明 worker,语言当控制平面。**
- 独特之处:**编排逻辑本身**是 `call/cc` 写的、可回溯(`amb`)、可事务(`capture/restore`)、可在运行时 `redefine!` 自我进化的程序——固定的 harness 循环 / 固定的 workflow API 给不了。

这也解决了"模型一次就做完、语言没出力"的问题:在编排器里两者不抢戏,语言贡献的是搜索/回溯/调度/自适应逻辑,看得见、必须出力。`goal`/`loop` 只是两种内建编排模式,非终点。worker 接口:`ask`/`gen`/`llm-code`(LLM)、`shell`(真 harness/工具)、子 `goal`。编排组合子见 `lib/orchestrate.piper`。

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
| **同像性(code = data)** | 计划要能被读取、推理、改写 | LLM 吐出的字符串 `read` 成 s-expr,既能 `eval` 又能被 agent 当数据反思/重写;`goal`/`loop`/`tool` 都是可被 `redefine!` 的库代码。 |
| **元循环求值器** | 求值的每一步都要能插桩、注入 LLM、处理空洞 | 我们拥有 `eval`/`apply`,于是 **eval 循环 = agent 循环**:可记录 trace、遇到高层目标就问 LLM、失败就让 LLM 修复重试。 |
| **一等 continuation** | 暂停/恢复、回溯、检查点 | `call/cc` 给出:等工具/审批时**挂起**、计划失败就**回溯**(amb)、把执行状态**捕获成检查点**用于事务性自修改。 |

一句话:**eval 循环即 agent 循环,continuation 即 agent 的可暂停状态,同像性即 agent 可自我重写的载体。**

---

## 2. 设计原则

1. **小核心,库生长**:核心求值器只认极少数特殊形式;`goal`/`loop`/`tool`/`amb` 等都在语言内部用库代码(driver 过程 + 薄宏)生长出来,**不进 eval 的 cond**。判据见第 5.3 节的 litmus test。
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
│   ├── agent.rkt            ← goal-driver(过程)/ loop(薄宏)+ loop-driver
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

### 5.3 什么必须进 eval?(litmus test)与三层模型

一个核心设计判断:`goal`/`loop`/`amb` **不**做成 `eval` 的 cond 分支(特殊形式),而是做成库代码。判据:

> **litmus test**:一个形式必须进 `eval` 的 cond,**当且仅当**它要改变求值协议本身,且这种改变无法用「已经被反映成一等值的原语」表达出来。

把 continuation 反映成一等公民后(`call/cc` 作为唯一不可约的控制原语),回溯 / 搜索 / 目标循环 / 重入**全都退化成普通过程 + 闭包**,够不到这条线:

| 形式 | 改变求值协议? | 落点 |
|---|---|---|
| `call/cc` | 是——唯一不可约的控制原语 | **特殊形式(eval case)** |
| `amb`/`require` | 经典 SICP 需要;但有了 `call/cc` 即可用「`call/cc` + 失败栈」做成库 | 库(或为 SICP 教学保真而做成 eval case,二选一) |
| `goal` | 否——它要的(LLM 调用、`capture`、受限 `eval`、trace)全是已反映的值 | **库:driver 过程**(参数全是值,甚至无需宏) |
| `loop` | 否——只是要"延迟/重复求值 body",这是宏的本职 | **库:driver 过程 + 一层薄宏** |

**对自修改语言这是决定性的**:goal/loop 若烤进宿主层 eval,agent 就永远无法 `redefine!` 它们——而改进"追求目标/循环调度的策略"恰恰是本语言的卖点。写成 Piper 自身的库代码,它们的源即可读可改的 s-expr,同像性直接变现。

**goal 与 loop 的差异**:`goal` 的参数全是值(描述是字符串、`#:success?` 是只构造不调用的 lambda、`#:tools` 是 list、`#:max-steps` 是数),applicative-order 先求值再调用完全正确,故 `goal` 可以**就是个普通过程**;`loop` 的 body 必须被延迟并反复求值,需一层薄宏把 body 包成 thunk(`(loop #:every t body...)` → `(loop-driver t (λ () body...))`),宏/闭包还**自动捕获词法环境**——比 eval case 手动穿 env 更省事。

由此得到**三层模型**:

```
L1 特权原语(eval case / primitive)——不可约的那一小撮
    call/cc(特殊形式) ; capture / restore / eval / current-env ; tracer 钩子
        ↑ 唯一真正"动求值协议"的控制原语只有 call/cc

L2 driver(普通过程,用 Piper 写,可被 redefine!)
    goal-driver : step 循环 + 每步 capture 回溯 + 工具白名单
    loop-driver : 重入 / 挂起 / 调度
    amb/require : call/cc + 失败栈

L3 表面语法(薄宏 / 过程)
    goal : 可直接是过程
    loop : 一层薄宏,只负责 body thunk 化 + 关键字糖
```

效果:core 的 cond 里关于控制流的特权项**只有 `call/cc` 一个**,其余全是 agent 可自行改写的库代码——既最 SICP,又最契合自修改定位。第 8 节的 `goal`/`loop`/`amb` 均按此分层实现。

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

### 6.1 `capture` / `restore`:状态检查点(与控制正交)

`capture`/`restore` **只管状态,不管控制**——控制跳转一律由 `call/cc` 负责。两者正交组合,才是干净的分解:

- `(capture)` → 返回一个 checkpoint,内含**全局环境某一刻的快照**(纯数据值)。
- `(restore cp)` → 把全局环境**整体替换**回快照。这是真正的事务语义:`capture` 之后新增的顶层绑定会一并被回滚掉。
- **不做控制跳转**:`restore` 之后代码线性继续。需要"跳回某点重试"时,用 `call/cc` 捕获续延(`amb` 即如此:用 `call/cc` 记跳点 + `capture/restore` 滚状态)。

事务性自修改(M6)与 `amb` 回溯(M3)都建立在这一对原语上。MVP 只快照全局 frame(局部状态由 continuation 承载)。

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

### 7.1 M2 实现要点(已落地,见 `src/llm.rkt`)

- **backend 可注入**:`current-llm` 参数 `(prompt system model) -> string`,默认走真实子进程;测试注入 mock,不打真网络(`tests/m2-test.rkt`)。
- **默认模型** `current-model = "deepseek-v4-pro"`(SiliconFlow,经 `llm` CLI 配置);可 `parameterize` 切换(如 `kimi2.6`)。
- **代理处理**:spawn `llm` 时为**子进程**剥掉 `*_proxy` 变量(`current-strip-proxy`)。因 httpx 走 SOCKS 需 `socksio`,直连更省事;用户照常 `make run` 无需手动 `env -u`。
- **围栏清洗**:`strip-fences` 去掉模型偶发的 ```` ```lang ... ``` ````,再 `read` 成一棵 s-expr。
- **Piper 原语**:`llm` / `llm-code` / `eval`(默认在全局环境)/ `current-env`(M2 简化为全局);prelude 里 `ask`=问答、`gen`=生成即运行。

---

## 8. Agent 层语义

> 本节所有形式都按第 5.3 节的**三层模型**实现:`call/cc` 是唯一特权控制原语(L1),`amb`/`goal-driver`/`loop-driver` 是普通过程(L2),`goal`/`loop` 是薄宏或过程(L3)。它们全部可被 `redefine!`。

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
(define plan (amb* (eval (llm-code "给出 3 个修复策略,返回一个 list"))))
(require (plan-passes? plan))
```

**实现(已落地,`lib/amb.piper`,纯库代码)**:维护一个失败续延栈 `*amb-fail*`;`amb-thunks` 用 `call/cc` 捕获成功/重试续延,试第一个候选并经 `succeed` 逃逸,回溯时弹栈顶续延推进到下一个候选;`(require #f)` 即调 `amb-fail`。`(amb e ...)` 由 `define-macro` 展开为 `(amb-thunks (list (lambda () e) ...))`——候选惰性化是回溯的前提。`amb*` 在运行时列表间选择(候选可为 LLM 产出)。**唯一控制特殊形式仍只有 `call/cc`**,amb 因此可被 `redefine!`。

#### 两个相关实现要点

- **`define-macro`(M3 新增的核心设施)**:`eval` 在应用位置先求值算子,若得到宏对象,则把**未求值的实参形式**交给 transformer 展开再求值(`src/eval.rkt`)。宏是「小核心、库生长」的引擎——`amb` 用它,`loop`(M5)也将用它。它是元语言设施,不是控制协议,故进核心是正当的。
- **read-all 语义**:`eval-file`/`eval-string` 先把**所有**顶层 form 读进列表再逐个求值。这样 `amb` 回溯跳回前面的 form 时,续延持有的是不可变列表尾、约束会被重新检查;若从可变 port 逐个读则会"读过头"导致约束漏检。因此**一段含回溯的程序应作为一个文件/字符串整体求值**(REPL 逐行模式不支持跨行回溯)。

### 8.3 `goal`(追求目标直到达成)✅ 已实现(`lib/agent.piper`)

> 灵感来自 Claude Code 的 `/goal`:给定目标 + 成功判据,agent 自行迭代直至达成或耗尽预算。

**实现采用 clause 语法**(而非 `#:keyword`——M0 无关键字参数;clause 是更 Lispy 的薄宏糖):

```scheme
(goal "把 total 累加到正好 30"
  (success?  (lambda () (= total 30)))           ; 0 参谓词
  (tools     (list (cons 'add add)))             ; ((name . proc) ...) 能力白名单
  (max-steps 12))
;; => (success <history>) | (exhausted <history>)
```

去糖:`(goal desc clause...)` 宏展开为 `(goal-run desc success? tools max-steps)`。L2 driver 循环:

```
goal-run(desc, success?, tools, max-steps):
  history := []
  for n in 1..max-steps:
    if (success?) -> return (success history)
    step    := (llm-code (goal-render desc tools history))   ; LLM 产出下一条 s-expr
    ckpt    := (capture)                                     ; 每步前快照全局 env
    outcome := (eval-in step tools)                          ; 沙箱执行 -> (ok.v)|(err.msg)
    if ok  -> record (n step => v)
    if err -> (restore ckpt); record (n step ERR msg)        ; 回滚副作用,LLM 据历史重试
  -> (exhausted history)
```

要点(与实现一致):
- **每步前 `capture`、出错 `restore`**:坏步的副作用被回滚(§6.1 状态检查点)。
- **能力白名单由 `eval-in` 强制**:step 在**只含 tools 的隔离环境**里求值(无 parent),碰不到 `+`/`car`/`llm`/`redefine!` 等——想 `(set! total ...)` 绕过工具会因 `total` 不在沙箱而 unbound。这是第 9 节安全模型的落地。
- **`history` 是 s-expr 数据**,回灌进 prompt 让 LLM 观察并自我纠错(实测:LLM 在 `(add 29)` 超限报错后,读历史改用 `(add 10)` 系列达成目标)。
- 后续可加 `#:on-fail 'ask-human`(用 continuation 挂起等人)、子 goal、predicate 之外的预算约束(token/时间)。

### 8.4 `loop`(周期 / 自定步重入)✅ 已实现(`lib/loop.piper`)

> 灵感来自 Claude Code 的 `/loop`:把一个任务按间隔或自定步反复执行。

**实现采用 clause 语法**(同 goal 的理由;`mode` 是第一个子形式,其余是 body):

```scheme
(loop (times 5)            (do-step))             ; 重复 N 次
(loop (until (deployed?))  (check-ci))            ; 直到谓词为真(每轮前检查)
(loop (until #f every 30)  (poll))                ; 每 30s 周期执行
(loop (self-paced)                                ; 自定步:body 返回指令决定调度
  (set! x (* x 2))
  (llm-code "x 大于 100 就返回 (stop x) 否则 (continue)"))
```

三层落地:
- **L3 宏 `loop`**:把 body 展开成 `(lambda (break) body...)`(thunk 化是反复求值的前提;`break` 是当轮可用的中断续延),按 `mode` 分发到对应 driver。
- **L2 driver**:`loop-times` / `loop-until`(带可选 `every` 周期 sleep)/ `loop-self-paced`。每个都用 `call/cc` 捕获一个 `break` 续延,body 可 `(break v)` 提前退出。
- **自定步即"LLM 决定调度"的接口**:body 返回指令数据 `(continue)` / `(delay secs)` / `(stop val)`——`llm-code` 把模型输出直接 `read` 成这种指令(无需 `eval`),于是 LLM 决定循环是否继续、停多久。实测:翻倍循环 x=2→128,模型每轮返回 `(continue)`,超过阈值返回 `(stop 128)`。

进程内 MVP 用宿主定时器(`sleep` 原语)。将来求值器去函数化、continuation 可序列化后,挂起可跨进程持久化(对接 Claude Code 的 ScheduleWakeup/cron 思路);届时 driver 不变,只是 `break`/续延变成可落盘的数据。

### 8.5 `redefine!` / `capture` / `restore`(自修改 + 事务)

```scheme
;; 事务性自修改:坏了能回滚
(define ckpt (capture))                       ; 抓全局 env 快照(纯状态,见 §6.1)
(redefine! 'review-latest-pr
  (llm-code "根据最近 3 次失败改进这个过程,返回新的 lambda"
            (procedure-source review-latest-pr)
            (recent-failures 3)))
(unless (smoke-test-ok?) (restore ckpt))      ; 冒烟不过 → 整体回滚到改之前
```

- `capture`/`restore`:状态检查点(§6.1),只滚全局环境、不做控制跳转;`restore` 后线性继续。**M1 已实现。**
- `redefine!`:改写全局 frame 里的绑定;`procedure-source` 取闭包源(因同像性,源就是 s-expr)。**M6 已实现。**

**M6 实现(`lib/self-modify.piper` + `src/primitives.rkt`)**:

- `procedure-source` 闭包 → `(lambda params body...)`;`redefine!`/`force-redefine!` 改写全局绑定并写审计;`redefine-log` 返回审计(seq name old-src new-src reason);`try` 安全调用 thunk(冒烟测试可能抛错,也当失败)。
- `improve! name 指令 smoke-ok?`:`capture` → LLM 读 `(procedure-source (eval name))` 改写 → `redefine!` → `try` 跑冒烟 → 不过(返回假或抛错)则 `restore`。返回 `kept`/`rolled-back`。
- 实测:LLM 把 `(lambda (x) (+ x x))` 修成 `(lambda (x) (* x x))`(kept);要求不可能的冒烟时改动被回滚(rolled-back),且两次尝试都留在审计日志里。

---

## 9. 自修改安全模型

自修改是核心卖点,也是最大风险。控制手段(✅ = 已实现):

1. **能力白名单 ✅**:LLM 生成的代码经 `eval-in` 在**只含授予工具的隔离环境**里求值,碰不到 `+`/`car`/`llm`/`redefine!` 等(M4)。
2. **核心保护 ✅**:`redefine!`/`restore`/`capture`/`eval`/`eval-in`/`procedure-source` 等标记为 protected,`redefine!` 拒绝改写(需显式 `force-redefine!`)(M6)。
3. **事务 + 冒烟测试 ✅**:自修改走 `capture`/`restore` 事务,`try` 跑冒烟,返回假或抛错即回滚(M1+M6)。
4. **审计日志 ✅**:`redefine-log` append-only 记录(seq、目标、旧源、新源、原因),含被回滚的尝试(M6)。
5. **预算约束 ✅(部分)**:`goal` 带 `max-steps`;`loop` 有 `times`/`until`/`self-paced`。token/时间预算待加。
6. **人审挂起点 ⏳**:`on-fail 'ask-human` / 工具标 `requires-approval` 用 continuation 挂起等人——待加(地基 `call/cc` 已具备)。

---

## 10. MVP 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 求值器** ✅ | reader(复用 Racket)+ env + eval/apply + 基本特殊形式 | 能跑 `(define (fact n) ...)` 等纯 Scheme |
| **M1 continuation** ✅ | `call/cc` 委托宿主 + `capture`/`restore` | 能用 call/cc 实现 generator;能快照/回滚全局 env |
| **M2 LLM 原语** ✅ | `llm` 子进程 + `ask` + `llm-code` + `eval` + `gen` | `(gen "算 6*7")` → 42;`llm-code` 定义过程后可直接调用 |
| **M3 amb** ✅ | `define-macro` 宏设施 + `amb`/`require` 回溯(纯库代码)+ `amb*` | 勾股数/约束求解通过;`amb*` 在运行时列表(可为 LLM 候选)间回溯 |
| **M4 goal** ✅ | `goal-run`(L2 过程)+ `goal`(L3 宏)+ step 循环 + 每步快照回滚 + `eval-in` 工具白名单 | 玩具 goal(累加到目标)真实 LLM 端到端达成,含错误自恢复 |
| **M5 loop** ✅ | `loop`(L3 宏)+ `loop-times/until/self-paced`(L2)+ call/cc break | until/break/self-paced 测试通过;LLM 自定步真实端到端跑通 |
| **M6 自修改** ✅ | `redefine!` / `force-redefine!` / `procedure-source` / `redefine-log` / `try` + `improve!` | 真实 LLM 读源码改正自己,冒烟不过事务回滚;核心绑定受保护 |

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
