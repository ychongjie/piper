# Piper

通用 agent 编排**引擎**(TypeScript,构建在 [pi](https://github.com/earendil-works/pi) SDK 之上)。
给个人开发提供 Claude Code 之外的另一个选择:更自动化、更便宜(国产模型)、更可定制。

**北极星**:用接近 SOTA 的便宜国产模型 + 大量自动化 **test-time compute** + 接地验证,跑出强模型
单次推理的效果——**厚 Piper(通用编排层,写一次)+ 薄声明式 agent spec(项目/任务专属,由 Claude
从历史 session 编译出来)**。完整设计见 **[docs/DESIGN.md](docs/DESIGN.md)**,与 Claude Dynamic
Workflows 的差异化定位见 DESIGN 同名小节,引擎如何构建在 pi 上见 [docs/pi-capabilities.md](docs/pi-capabilities.md)。

**本仓库只放通用引擎,零项目耦合。** 具体项目的 agent(薄层 spec + glue)住单独的私有仓库
`piper-agents`,通过 `"piper": "file:../piper"` 依赖本引擎;第一个真实样本是 safeline-3 api-test
回归守望(见 piper-agents)。

## 引擎模块(厚层,`bun test` 全绿)

| 模块 | 内容 |
|---|---|
| `src/session.ts` | pi 会话 + **可注入后端**(`setBackend`/`getBackend`/`createPiSession`)——引擎不绑死具体模型 |
| `src/check.ts` | 客观验收抽象(`shellCheck`/`fnCheck`)——不信 agent 自报 |
| `src/goal.ts` | `goal` 外环:验收→派 worker→失败带反馈重派 |
| `src/ttc.ts` | test-time compute:`structuredWorker`/`bestOfN`/`debate` + 接地 |
| `src/loop.ts` | 定时/轮询守望 + 状态持久化续跑 |
| `src/escalate.ts` | 升级:授权闸(`beforeToolCall`)+ bestOfN 不收敛兜底 |
| `src/spec.ts` | **spec 引擎**:跑声明式 agent spec(detect→run→verify→修复表→归因→升级→授权) |
| `src/observe.ts` | 观测:实时控制台 + `logs/` 落盘复盘 |
| `src/verifiers/git.ts` | 通用 `git_diff_touches`(只读,参数化 repo) |
| `src/ci/gitlab.ts` | 通用 GitLab 只读访问(`gitlabReader(project)`) |
| `src/sh.ts` / `src/index.ts` | shell 执行 / 公开导出面 |

## 用作依赖

```ts
// piper-agents 里:
import { goal, bestOfN, debate, loop, runSpec, resolveOrEscalate, setBackend } from "piper";
setBackend(myCheapModelSession);   // 注入你的便宜模型后端
```

```sh
bun test    # 引擎单测(mock/合成,不打网络、不花钱)
```

## 实施纪律(见 DESIGN)

先具体后泛化:先把第一个 agent 具体做通(在 piper-agents),两个数据点之前不泛化;
厚层每加一个原语,都要被 ≥2 个薄 spec 真用到。
