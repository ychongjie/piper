# Piper

一门 **AI 原生的 Lisp 方言**(基于 Racket)。把 SICP 的三件武器——
**同像性、元循环求值器、一等 continuation**——对应到 AI agent 的三个核心诉求:
**可自我重写的计划、可被 LLM 编织的求值循环、可暂停/回溯的执行状态**。

语言原生支持:

- `goal` —— 追求一个目标直到达成(灵感来自 Claude Code 的 `/goal`)
- `loop` —— 周期 / 自定步重入(灵感来自 Claude Code 的 `/loop`)
- 运行时**自修改**(事务性 `redefine!`,坏了可回滚)

技术栈:**Racket + 原生 `call/cc` + [`llm`](https://github.com/simonw/llm) CLI 作为 LLM 原语**。

状态:**M0–M1 完成**(纯 Scheme 子集求值器 + 一等 continuation)。路线见 [docs/DESIGN.md](docs/DESIGN.md) §10。

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

LLM 接入(`ask`/`llm`)、`amb` 回溯、`goal`/`loop` 在后续里程碑(M2+)。
