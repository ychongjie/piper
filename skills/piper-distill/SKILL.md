---
name: piper-distill
description: 把一段重复的 Claude Code 工作(会话历史 / 记忆 / 用到的 skill)蒸馏成一份 piper agent.yaml —— 三阶段(蒸馏→编译→执行)的第一阶段。TRIGGER 当用户想把"我手动重复做的某个流程"(回归守望、巡检、对账、构建部署测试等)固化成一个能便宜跑的自动 agent,或说"蒸馏成 agent / 写成 piper yaml / 把这套自动化下来"。蒸馏只产出 YAML(人可调的窄腰),不写 agent 的 TS——TS 只能是编译产物。
---

# piper-distill：把重复工作蒸馏成 agent.yaml

蒸馏是三阶段的第一阶段,由你(Claude Code,强模型、能读会话/记忆/skill)离线完成。
产物**只有一份 `agent.yaml`**——人可读、可调的窄腰。之后 `piper compile` 把它固化成自包含 `.sh`(便宜模型/框架执行)。

**硬约束:词汇是封闭的。** 项目专属语义只能写进 **NL 值**(被编译期固化),永远不要新增关键字。
每改一版就 `piper validate <yaml>`,它会精确报未知键/类型错。你不能改 piper 的 schema,也不能手写 agent 的 TS。

## 蒸馏步骤

1. **找循环体**:在会话/记忆里找出用户**反复做**的那件事。它的"每次触发→一串机械步骤→一个判断"就是一个 agent。
2. **定触发器 `loop.on`**:用 NL 描述"探什么"——必须是**只读查询**,把构建标识打到 stdout(如"查某仓库某分支最新 commit sha")。去重交给哨兵,触发器本身别记状态。
   - 选 `signal`:`commit-sha` | `package-version` | `nonempty`(决定怎么从 stdout 抽 build id + 验收契约)。
3. **拆步骤 `do.steps[]`**:把那串机械操作拆成有序的步,每步:
   - `id` 短横线命名;`nl` 描述"这一步做什么"——必须是**机械、可固化成确定脚本**的(对账/编译/部署/跑测)。
   - `verify`:对该步 stdout 的**正则**契约(机械门,缺省=非空)。契约要**抓得住真失败**——别让"status=running"这种硬编码字串蒙混过关(历史教训:弱 verify = 安全网有洞)。
   - `cwd`(可 `~`/`$HOME`)、`danger`(非空字符串=危险写,过自管闸)、`using`(编译期可参考的 skill 名)、`self_contained`(重活步可设 `false` 暂用仓库脚本)。
   - 不确定能否固化成确定脚本的(如"登进环境按当下症状提取不同日志做根因")→ 那是**investigate(活的判断)**,不该进 steps,应进 `verify.panel`。
4. **定验收 `do.verify`**:
   - 纯机械门 → `{ check: <正则> }`。
   - 需要**判断**(归因/是否真回归)→ `{ panel: { n, judge, ground, labels, escalate_if } }`:`n` 个独立判官(活的、不固化),`judge` 是 NL 判题,`ground` 是取证手段的 NL(运行期由项目侧 `--inject` 解析成真实工具),`labels` 候选结论,`escalate_if` 命中哪类要升级(如版本错位/超范围)。
5. **定自管闸 `guard`**:`owns`= 认领"本 agent 自管资源"的**正则**(如 `本 agent 专用|piper-watchdog`),`budget`= 预算内自管写自动放行次数。碰别人的/超预算 → 自动升级。这是"全自动 + 专用环境"的安全校准。
6. **填 `model`**:用**标准模型名**(如 `deepseek-v4-pro`),piper 配置负责映射到具体网关 id;别写网关专属命名。
7. **记来源 `distilled_from`** + **自包含禁则 `forbid_runtime_deps`**(正则:运行期不许 shell-out 的外部仓库脚本路径,逼编译期内联)。

## 起手式

`piper distill <name>` 打印一份合法骨架到 stdout;以它为基底,边读会话边填实,边 `piper validate`。

## 验收这次蒸馏

- `piper validate <yaml>` 无未知键/类型错。
- 通读一遍:触发器只读、每步可固化且 verify 抓得住真失败、判断都在 panel 不在 steps、危险写都标了 danger、自管边界 owns/budget 合理。
- 交接给编译:`piper compile <yaml>` → 产物入 `crystallized/`(`.sh` + `lock.json`,可 review)。

> 漂移:内联逻辑是编译那刻的快照。上游真改了,靠运行期 verify + 自修兜底,或重新蒸馏一版。
