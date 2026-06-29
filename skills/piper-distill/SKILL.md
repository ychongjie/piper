---
name: piper-distill
description: 把一段重复的 Claude Code 工作(会话历史 / 记忆 / 用到的 skill)蒸馏成一个 piper v2 agent —— 一份封闭词汇的编排 YAML + 一组自包含工具脚本 <agent>.tools/*.sh。TRIGGER 当用户想把"我手动重复做的某个流程"(回归守望、巡检、对账、构建部署测试等)固化成一个能便宜跑的自动 agent,或说"蒸馏成 agent / 写成 piper yaml / 把这套自动化下来"。蒸馏产出 YAML(人可调的窄腰)+ 调通的 .sh 工具,不写引擎 TS。
---

# piper-distill：把重复工作蒸馏成 v2 agent

蒸馏是两阶段架构(蒸馏 / 执行)的**蒸馏阶段**,由你(Claude Code,强模型、能读会话/记忆/skill)离线完成。
产物入仓两样:① 一份 **agent YAML**(封闭词汇编排,人可读可调);② 一组 **`<agent>.tools/*.sh`**
(自包含工具脚本,把机械操作调通)。运行期由 piper v2 引擎(`runOnce`)活解释 YAML、活 agent 按名调用工具。

**硬约束:词汇是封闭的。** 项目专属语义只能写进 **`intent` 的自然语言**(markdown),永远不要新增关键字。
词汇与执行语义以 piper 的 `DESIGN.md` 为准。`intent` 只接受字符串,不能嵌套 YAML 键。

## 封闭词汇(速查,详见 DESIGN.md)

```
顶层:   agent: <名>;loop: { on: <触发器 intent>, every?: <30m>, do: <节点> }
节点:   裸串 | 叶子对象 | { fanout:{...} } | [ 节点, … ](列表=顺序)
叶子:   { intent, verify?, budget?, labels?, model?, tools?, using?, cwd?, when? }
验收:   verify: '<正则>' | { intent, ground?, n? }(判官独立取证)
判官:   叶子带 labels → 产出 {label,confidence,evidence};fanout+gather:vote = panel
fanout: { when?, over:[{model?,intent?}…], intent?, gather:{how:vote|merge,labels?,…}, concurrency? }
条件:   when: <label>(机械配紧邻上一步 label)
```

## 蒸馏步骤

1. **找循环体**:在会话/记忆里找出用户**反复做**的那件事。"每次触发 → 一串机械步骤 → 一个判断"就是一个 agent。
2. **定触发器 `loop.on`**:NL 描述"探什么"——必须是**只读查询**,把构建标识打到 stdout(如"查 origin/master
   最新合入 sha")。去重=stdout 全等(sha 没变=没有新合入),触发器本身别记状态。
3. **拆 `do`**(通常是个**列表**=顺序):
   - **机械活**(对账/编译/部署/跑测)→ 一个**带 `tools` 的叶子**:intent 写"依次做什么 + 红线 + 要的输出",
     机械操作交给 `tools`(下一步写),别在 intent 里现搭逻辑。配 `verify`(独立判官)+ `budget`(收敛轮数)。
   - **判断活**(是不是 flaky、归因)→ **判官叶子**(带 `labels`)或 **`fanout`**(多份投票)。
   - 不确定能否固化成确定脚本的(如"登进环境按当下症状提取不同日志做根因")→ 是**活的判断**,进判官/fanout 的 `intent`,不要塞进工具。
4. **写自包含工具 `<agent>.tools/*.sh`**:把机械步骤做成脚本,粒度自定。每个满足:
   - **自包含**:运行期只依赖系统工具(curl/jq/ssh/glab/git/docker)+ 活基础设施;**不**读 `~/.claude/skills`、
     **不** shell-out 到检出里的 `.sh`。skill/repo 逻辑在蒸馏期**内联**进脚本。
   - **头部文档**:脚本头写结构化注释(用途/入参/环境/输出/红线/用法)——引擎按叶子 `tools:[...]` 注入这些头给 agent。
   - **`using`**:在叶子上记蒸馏时参考了哪些 skill(从中内联出 tools)。
5. **定验收 `verify`**:纯机械可查 → `'<正则>'`;需要判断(部署对不对/真不真回归)→ `{ intent, ground, n? }`,
   `ground` 是取证手段的 NL,`n>1` 是一组判官投票。**契约要抓得住真失败**——别让"status=running"这种字串蒙混(弱 verify = 安全网有洞)。
6. **填 `model`**:用**标准模型名**(如 `deepseek-v4-pro`),piper 配置映射到网关 id。主控通常省略(=`default_model`);
   只在需要模型多样性/横评处(如归因 fanout 的 `over`)给不同 `model`。
7. **安全是运行期策略,不进 YAML**:危险写经宿主 runner 注入的升级 handler;红线软约束写进 `intent`。

## 实地调试(蒸馏的一半价值在这)

**真跑每个工具脚本**,验证能用、修 bug,跑通才提交——便宜模型运行期只调用已调通的脚本,不现推细节
(这正是治"现推操作出错"那类 bug,如部署陈旧二进制)的关键。再跑一遍整条 `runOnce`,确认从触发到结论闭环。

## 验收这次蒸馏

- 通读 YAML:触发器只读、机械活在带 `tools` 的叶子、判断在判官/fanout、`verify` 抓得住真失败、危险写不在 YAML。
- 每个 `.tools/*.sh` 头部文档齐全、自包含(不碰 skills/检出脚本)、能独立 bash 跑通。
- 交接:项目侧写一个薄 runner(设 `cwd`/`toolsDir`、监控循环),`runOnce(loadAgentV2(yaml), …)` 跑起来。

> 漂移:工具是蒸馏那刻的快照。上游 API/skill 真改了,靠运行期 `verify` + 判官发现,或重新蒸馏一版。
