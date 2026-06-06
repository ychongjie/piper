# Piper

一门 **AI 原生的 Lisp 方言**(基于 Racket)。把 SICP 的三件武器——
**同像性、元循环求值器、一等 continuation**——对应到 AI agent 的三个核心诉求:
**可自我重写的计划、可被 LLM 编织的求值循环、可暂停/回溯的执行状态**。

语言原生支持:

- `goal` —— 追求一个目标直到达成(灵感来自 Claude Code 的 `/goal`)
- `loop` —— 周期 / 自定步重入(灵感来自 Claude Code 的 `/loop`)
- 运行时**自修改**(事务性 `redefine!`,坏了可回滚)

技术栈:**Racket + 原生 `call/cc` + [`llm`](https://github.com/simonw/llm) CLI 作为 LLM 原语**。

状态:设计阶段。详见 [docs/DESIGN.md](docs/DESIGN.md)。
