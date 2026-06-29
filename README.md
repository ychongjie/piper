# Piper

通用 agent 编排**引擎**(TypeScript,构建在 [pi](https://github.com/earendil-works/pi) SDK 之上)。
把一段**重复的 Claude Code 工作**蒸馏成一份**声明式 YAML**,运行时由 **pi + 国产便宜模型**实际执行。

**北极星**:用接近 SOTA 的便宜国产模型 + 大量自动化 **test-time compute**(冗余/投票)+ 接地验证,
跑出强模型单次推理的效果。**强作者 / 弱执行**:贵的强模型(Claude Code)一次性写好并**调通** YAML
和工具脚本;便宜模型运行期只**活解释 YAML、调用已调通的脚本**,不现推操作细节。

完整设计见 **[DESIGN.md](DESIGN.md)**;引擎如何复用 pi SDK 见 [docs/pi-capabilities.md](docs/pi-capabilities.md)。

## 两阶段

```
蒸馏(Claude Code 强模型,离线)   产出并入仓:
  ① agent YAML(编排:loop/do/fanout/verify/intent/tools…)
  ② <agent>.tools/*.sh(自包含工具脚本,粒度自定,每个带文档头)
  ③ 实地调试这些脚本(真跑、验证、修 bug)
执行(piper 引擎 + 便宜模型,运行期)
  活 agent 跑 YAML,按名调用入仓的自包含工具;脚本兜不住的异常 agent 兜
```

**本仓库只放通用引擎,零项目耦合。** 具体项目的 agent(YAML + `.tools/` + runner)住单独的
`piper-agents` 仓库,通过 `"piper": "file:../piper"` 依赖本引擎;第一个真实样本是 safeline-3
api-test 回归守望(见 piper-agents)。

## 引擎(`bun test` 全绿)

| 模块 | 内容 |
|---|---|
| `src/v2/engine.ts` | **活引擎**:封闭 YAML(loop/do/list/fanout/verify/intent/tools/labels/when)活解释。活叶子续会话收敛、判官独立取证、fanout 投票、按需注入工具文档;每行输出带 `[角色·模型]` 标签便于分析/benchmark |
| `src/v2/run.ts` | 入口:`loadAgentV2` + `runOnce`(跑一个 tick:触发器 → do 树) |
| `src/session.ts` | pi 会话 + **进程内**注册便宜模型 provider(`backendForModel`/`setBackendOverride`,不碰全局 pi 配置) |
| `src/config.ts` | 网关 + 标准模型名映射(`resolveModel`;`~/.piper/config.json`) |

词汇与执行语义见 DESIGN.md。

## 用作依赖

```ts
// piper-agents 里:
import { loadAgentV2, runOnce } from "piper/v2";
const a = loadAgentV2(readFileSync("agents/<x>.v2.yaml", "utf8"));
await runOnce(a, { cwd, toolsDir, runTrigger: true, onLog: console.error });
```

```sh
piper run <agent.yaml> [--cwd DIR] [--tools DIR] [--no-trigger]   # 跑一个 tick
bun test                                                          # 引擎单测(mock/合成,不打网络、不花钱)
```

## 配置

`~/.piper/config.json`:网关 base_url + `api`(端点类型,如 `anthropic-messages`)+ `api_key_env`
+ 标准模型名 → 网关 modelId 映射。key 放环境变量(如 `BAIZHI_API_KEY`),不入仓。
