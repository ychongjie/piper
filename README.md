# Piper

一门 **AI 原生的 agent 编排语言**(Racket 实现)。用一组高层"agency 动词"编排 LLM 与
agent harness——**模型当 worker,语言当控制平面**。

不是又一个 harness(像 Claude Code),而是 harness 的**编排器**:`goal`/`loop`/`best`/`fan`
是语言里的**表达式**,可任意嵌套组合(`loop ⊃ fan ⊃ best ⊃ agent ⊃ goal`)——固定功能的
harness 表达不出"可当程序的编排"。引擎室是同像性 + 元循环求值器 + 一等 `call/cc`,但作者只写高层意图。

📖 [docs/DESIGN.md](docs/DESIGN.md) 目标与设计 · 📋 [docs/CHEATSHEET.md](docs/CHEATSHEET.md) 一页速查 · 🧩 [examples/](examples/) 可跑示例

## 核心词汇(~12,正交)

worker = `(lambda (task) -> 结果)`,仅 `model`/`agent` 两个构造器;控制平面对 worker 类型一视同仁。

- **worker**:`model`(认知,llm)· `agent`(执行,pi)
- **控制平面**:`fan-out` · `best` · `vote` · `amb`/`require` · `loop` · `goal`
- **认知动词**:`ask` · `judge` · `propose`

> **两层边界 = 碰不碰环境**:认知层(llm)纯、只看 prompt;要参考本地代码用 `read-files` 拼进 prompt,要探索则派 `agent`(pi)。

签名与例子见 [CHEATSHEET](docs/CHEATSHEET.md)。

## 快速上手

需要 [Racket](https://racket-lang.org/)(`brew install --cask racket`)+ [`llm`](https://github.com/simonw/llm) CLI(认知层)。

```sh
make test                          # 跑测试
make repl                          # 进 REPL
make run FILE=examples/panel.piper # 跑一个程序
```

执行层(`agent`/pi)可选,需一次性配 provider(指到现有开源端点、密钥在仓库外):见 [DESIGN 附录 A](docs/DESIGN.md)。

## 状态

M0–M6 已实现(求值器 + 一等 continuation + LLM 接入 + 宏/amb 回溯 + goal/loop + 运行时自修改),
正按编排语言方向收敛(两层 worker、精简原语、`#lang` 可读性、自改进编排)。路线图见 [DESIGN §7](docs/DESIGN.md)。

技术栈:**Racket + 原生 `call/cc` + [`llm`](https://github.com/simonw/llm)(认知)+ [`pi`](https://github.com/earendil-works/pi)(执行)**。
