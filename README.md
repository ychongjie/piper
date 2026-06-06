# Piper

一门 **AI agent / harness 的编排语言**(基于 Racket)。把 SICP 的三件武器——
**同像性、元循环求值器、一等 continuation**——用作 agent 编排的控制平面:
**可自我重写的编排策略、可被 LLM 编织的求值循环、可暂停/回溯/事务化的执行状态**。

**定位**:不是又一个 harness(像 Claude Code 那样的单 agent 系统),而是 harness 的
**编排器**。模型(或 shell 出去的真 harness)当聪明 **worker**,Piper 当**控制平面**——
分工清晰:模型负责聪明,语言负责控制。它的独特之处是**编排逻辑本身**是用 `call/cc`
写的、可回溯、可事务、可在运行时 `redefine!` 自我进化的程序——这是固定的 harness 循环
或固定的 workflow API 给不了的。

把"一次 agent run"当可组合的值,语言提供控制平面:

- **编排组合子** `fanout` / `best-of`(LLM 裁判)/ `vote` / `first-ok` / `retry` / `pipeline`(`lib/orchestrate.piper`)
- **回溯搜索** `amb` / `require` —— 在 worker 候选间搜索、剪枝(`lib/amb.piper`)
- **事务** `capture` / `restore` —— 给整段编排打检查点、失败整体回滚
- **自适应** `redefine!` / `improve!` / `evolve!` —— 编排策略自我进化(`lib/self-modify.piper`)
- **worker 接口** `ask` / `gen` / `llm-code`(LLM)、`shell`(真 harness/工具)、子 `goal`;统一适配器见 `lib/workers.piper`

### worker 后端选型(开源模型友好 + 不额外付费)

worker 后端保持中立(`lib/workers.piper`),同一套编排组合子对任意 worker 成立:

| 后端 | 角色 | 开源模型 | 成本 | 用法 |
|---|---|---|---|---|
| **`llm`**(默认) | 薄补全 | ✅ 插件接 Ollama/本地/托管开源 | 最低 | `(llm-worker "deepseek-v4-pro")` |
| **`pi`** | 厚 harness | ✅ `--provider/--model` 任意 | 你自己的开源端点 | `(pi-worker "ollama" "qwen2.5")` |
| `claude` | 厚 harness | ❌ 锁 Anthropic | ⚠️ 订阅不含 headless,`-p` 计费 | `(claude-worker)`,慎用 |

因为默认走 `llm`,Piper 天然能 **fan-out 到一组不同开源模型再 vote/best-of**
(开源模型评审团,见 `examples/panel.piper`)——多样性来自不同模型,单模型给不了。

`goal`(目标循环)与 `loop`(周期/自定步重入)是其中两种内建编排模式
(灵感来自 Claude Code 的 `/goal` 与 `/loop`),非终点。

技术栈:**Racket + 原生 `call/cc` + [`llm`](https://github.com/simonw/llm) CLI 作为 LLM 原语**。

状态:**M0–M6 全部里程碑完成** 🎉(求值器 + 一等 continuation + LLM 接入 + 宏/amb 回溯 + goal 目标循环 + loop 重入 + 运行时自修改)。108 测试全绿。路线见 [docs/DESIGN.md](docs/DESIGN.md) §10。

## 快速上手

需要 [Racket](https://racket-lang.org/)(`brew install --cask racket`)。

```sh
make test                          # 跑测试
make repl                          # 进 REPL
make run FILE=examples/hello.piper # 运行一个 Piper 程序
```

M0 已支持:`quote / if / define / set! / lambda / begin / let / cond / and / or`、
递归与闭包、变参(`(lambda args ...)` 与点对 `(a . rest)`),以及用 Piper 自身写的
prelude(`map / filter / foldl / range / append / reverse ...`,见 `lib/prelude.piper`)。

M1 新增唯一的特权控制特殊形式 `call/cc`(委托宿主,一等 continuation),
以及状态检查点 `capture`/`restore`(全局环境快照 + 事务性回滚,见 `examples/control.piper`)。

M2 把 LLM 编织进求值器:`ask`(问答)、`llm-code`(LLM 文本 → 可 eval 的 s-expr)、
`gen`(生成即运行)。需要 [`llm`](https://github.com/simonw/llm) CLI(默认模型
`deepseek-v4-pro`,可 `parameterize current-model` 切换),见 `examples/ai.piper`。
spawn 子进程时会自动为其剥掉 `*_proxy` 变量,正常 `make run` 即可。

M3 新增 `define-macro`(宏设施,「小核心库生长」的引擎),并用它把 `amb`/`require`/`amb*`
回溯写成**纯库代码**(`lib/amb.piper`,仅依赖 `call/cc`),见 `examples/amb.piper`。

M4 实现 `goal`:LLM 驱动的目标循环(观察→生成下一步→eval→检查成功),每步前 `capture`
出错 `restore`,能力白名单由 `eval-in` 沙箱强制(LLM 生成的代码只能调 tools)。按三层做成
`goal-run`(L2 driver 过程)+ `goal`(L3 clause 薄宏),纯库代码 `lib/agent.piper`,
见 `examples/goal.piper`(真实 LLM,含错误自恢复)。

M5 实现 `loop`:`(times N)` / `(until PRED [every S])` / `(self-paced)` 重入,用 `call/cc`
给每轮一个 `break` 续延;自定步由 body 返回的指令 `(continue)`/`(delay s)`/`(stop v)` 决定调度
——这正是 LLM 控制循环的接口(`lib/loop.piper`,见 `examples/loop.piper`)。

M6 实现运行时自修改:`redefine!`/`force-redefine!`、`procedure-source`(同像性取闭包源)、
`redefine-log`(审计)、`try`(安全冒烟)、核心绑定保护,以及助手 `improve!`——
用 LLM 读自己的源码改正,冒烟不过则事务回滚(`lib/self-modify.piper`,见
`examples/self-modify.piper`,真实 LLM)。这把同像性 + 元循环器 + continuation + LLM
四根支柱串成完整闭环。

### 自进化函数(`examples/evolve-calc.piper`)

`evolve!`(`lib/self-modify.piper`)是**失败驱动的自我进化**:给一个确定性测试表,
每轮把"当前源码 + 失败的具体用例"喂给 LLM 要新实现,只保留严格减少失败数的版本
(退步则 `restore` 回滚)——带 LLM 变异的爬山法。实测:从 `(lambda (s) (string->number s))`
出发,deepseek-v4-pro **一轮**就进化出完整的 tokenizer + 递归下降计算器,通过全部
优先级/括号/多位数/空格用例。

为支撑 LLM 写出的地道 Scheme,求值器已补 `letrec` / 具名 `let` / `let*` / `when` / `unless`
及字符串-字符原语(`string->list`/`char-numeric?`/`string-ref`/`substring`/...)。
LLM 调用默认把输入/输出/耗时打到 stderr(`current-llm-verbose`),便于观察 agent 进展。
