# Piper

一门 **AI 原生的 Lisp 方言**(基于 Racket)。把 SICP 的三件武器——
**同像性、元循环求值器、一等 continuation**——对应到 AI agent 的三个核心诉求:
**可自我重写的计划、可被 LLM 编织的求值循环、可暂停/回溯的执行状态**。

语言原生支持:

- `goal` —— 追求一个目标直到达成(灵感来自 Claude Code 的 `/goal`)
- `loop` —— 周期 / 自定步重入(灵感来自 Claude Code 的 `/loop`)
- 运行时**自修改**(事务性 `redefine!`,坏了可回滚)

技术栈:**Racket + 原生 `call/cc` + [`llm`](https://github.com/simonw/llm) CLI 作为 LLM 原语**。

状态:**M0–M4 完成**(求值器 + continuation + LLM 接入 + 宏/amb 回溯 + goal 目标循环)。路线见 [docs/DESIGN.md](docs/DESIGN.md) §10。

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

`loop`、`redefine!` 自修改在后续里程碑(M5+)。
