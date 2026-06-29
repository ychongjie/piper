# Piper 设计基线(agent 编排 YAML)

> 本文是**目标设计**,不是对当前实现的描述。当前仓里还存在 crystallize/steps/guard 等旧形态;
> 这份基线是改 schema / 引擎前的依据。改造时以本文为准。

## 1. 定位

Piper 把一段**重复的 Claude Code 工作**(会话历史 / 记忆 / 用到的 skill)**蒸馏**成一份
**agent 编排 YAML**;运行时由 **pi + 国产便宜模型**实际执行。

两阶段(蒸馏与编译合一,都由 Claude Code 做):

```
蒸馏(Claude Code 强模型,离线,在有 infra 的开发机上)
  读 会话/skill/repo → 产出三样并入仓:
    ① agent YAML(编排)
    ② <agent>.tools/*.sh(自包含工具脚本,粒度由 Claude Code 自定)
    ③ 实地调试这些脚本(真跑、验证能用、修 bug)
执行(piper + 便宜模型,运行期)
  活 agent 跑 YAML,按名调用入仓的自包含工具;脚本兜不住的异常 agent 兜
```

**强作者 / 弱执行**:贵的强模型一次性写好并**调通**脚本;便宜模型运行期只**调用已调通的脚本**,不现推
(这直接治"现推操作细节出错"那一类 bug,如部署陈旧二进制)。

灵感来自 Claude Code 的 dynamic workflows(`agent`/`parallel`/`pipeline` 三原语 + 6 种模式),
但做了三件不同的事:

1. **封闭声明式 YAML 词汇**(不是任意 JS):清晰、可审、可蒸馏。
2. **跑在便宜模型上**(不是 Claude):靠冗余/投票补单发不稳。
3. **常驻 + 生产安全 + 可观测**:守望类任务,要碰生产写、要人能 review。

与 dynamic workflows 的关键差异——**工作层不冻结模型**:
那篇只把**编排**做成确定性,**工作**永远是活 LLM;Piper 沿用这一点(运行时留活 agent),
`freeze`(固化成脚本)只作**可选优化**,默认不冻。

## 2. 核心原则

1. **键 = 引擎词汇,串值 = 模型内容**。YAML 的**键**是封闭编排词汇,引擎解析;**自然语言串值**
   (`intent`)原样喂模型,引擎不解析。判别一句话:**是键→引擎管;是 NL 串→模型读**。
2. **粗结构进 YAML,细判断进 agent**。`loop`/`fanout`/列表 这种结构进 YAML;
   "是不是 flaky、判哪个 label、决策树分支"这种**判断**进 agent 的 `intent`——**模型就是 if-else**。
   一旦想在 YAML 里画决策树,就是信号:它该回到某个 agent 的 intent 里。
3. **执行者 ≠ 判官**。验收永远独立于 doer,绝不靠 doer 自报"我做完了"。
4. **并行要无副作用 / 资源隔离**。有副作用的活(改共享状态、争用资源)→ 单独成步只做一次,
   或 `concurrency: 1`;判断/取证只读 → 可并行。
5. **schema 从声明装配,不从散文生成**。verdict 的 label 枚举来自 `labels` 声明;
   不让模型从 `intent` 散文反推结构。

## 3. 封闭词汇

### 节点(递归 union)

一个**节点**是下列之一:

| 形态 | 含义 |
|---|---|
| `"<NL 串>"` | 叶子(无属性) |
| `{ intent, verify?, budget?, labels?, model?, using?, cwd?, freeze? }` | 叶子(带属性) |
| `{ fanout: {...} }` | 并行铺开 + 归约 |
| `[ <节点>, … ]` | **顺序**(列表本身即 sequence,无关键字) |

判别靠 YAML 类型/键:列表→顺序;有 `fanout`→并行;有 `intent`→叶子;裸串→叶子。

### 顶层

```yaml
agent: <名>
loop:
  on: <触发器 intent:只读查询,把构建 key 打到 stdout;去重=stdout 全等>
  every: <30m>            # watch 默认探测节奏
  do: <节点>             # 内层编排树(通常是个列表)
```

### `fanout`(并行铺开 + 归约)

```yaml
fanout:
  when: <label>?         # 可选:机械配紧邻上一步的 label,满足才跑这套结构(否则跳过)
  over:                  # 铺开成几份;每项是该份的 {model?, intent?} 增量
    - { model?: <标准模型名>, intent?: <该份追加的视角/角色> }
  intent: <各份共享的 intent>?      # 可选:over 项的 intent 追加在它上面
  gather:                # N 份怎么合成 1 个
    how: vote | merge
    labels: [<候选标签>…]?           # vote 用;verdict 的 label 枚举由此装配
    intent: <合并者意图>?            # merge 用
    model: <合并者模型>?
  concurrency: <int>?    # 独立份并发上限,默认=份数。有副作用/争用资源时压成 1
```

- `vote`:N 份各出一个 label,投票出**一个明确结论**(纯 JS,不花模型)。
- `merge`:N 份合成一份产物(派一个合并者 agent)。
- 注意:**vote 只负责"定性",拿到 label 后怎么处理(报警/路由)是下游/`when` 的事**,不塞进 gather。

### 叶子属性

| 属性 | 含义 |
|---|---|
| `intent` | **自然语言提示词**(字符串,可 markdown);引擎不解析,原样喂 agent。**统一所有提示词字段**。 |
| `verify` | 验收契约(见 §4) |
| `budget` | 活叶子的收敛轮数上限(见 §5) |
| `labels` | 有 `labels` → 这是个**判官叶子**,产出 `{label, confidence, evidence}` |
| `model` | 标准模型名(piper 配置映射到网关) |
| `tools` | **运行期可调的自包含工具脚本名**(蒸馏生成,在 `<agent>.tools/`);引擎注入这些工具及其文档给该 agent(见 §6.1) |
| `using` | 蒸馏期参考的知识来源 skill(从中内联出 `tools`) |
| `cwd` | 工作目录(可 `~`/`$HOME`) |
| `freeze` | 可选:把这片机械叶子**直接当脚本跑**(无 agent)。与 `tools` 同种产物(自包含脚本),只是用法不同:`freeze`=整叶子就是脚本;`tools`=活 agent 调脚本 |

### `when`(条件,机械)

```yaml
when: <label>     # 机械:紧邻上一步的 verdict label == 此值,才跑当前节点;否则跳过
```

- **不是 agent、不是判断**:判断在上一步判官里做完、收敛成 label,`when` 只**机械匹配**。
- 一元守卫(只"满足才跑"),**不是 `route`**(无 N 路 cases)。要 N 路结构派发才刻意请回 `route`。
- 默认看**紧邻上一步**(位置性);引用非相邻步骤的结果 = 显式数据流,暂不支持。

### `intent` 的硬约束

- **只接受字符串**(markdown),schema 显式拒绝嵌套对象——防止"提示词升成 YAML 键"与编排词汇混淆。
- 要表达"一个 agent 内部的 task 列表/红线/输出",用 **markdown 结构**(`##`/列表),**不要**用 YAML 键。

## 4. 验收 `verify`(执行者 ≠ 判官)

verify 永远独立于 doer。按"达成要不要判断"分两形:

```yaml
verify: '<正则>'                          # 机械门:引擎跑,匹配 result。便宜,但对语义目标脆。
verify: { intent: <判什么>, ground?: [<取证手段>], n?: <判官数> }   # 判官:独立 agent 实地查
```

- **机械门**:适合客观可查的(`\d+ passed`、`ENV_ID=\d+`)。
- **判官**:适合需要判断的(部署的是不是 test-agent 构建?)。`n>1` = 一组独立判官投票(panel)。
- verdict 的 label 枚举从声明装配,不从散文生成。

判官与 `fanout + gather:vote` 是同一回事:**verify 按强度展开** = 机械门 → 1 判官 → N 判官投票。

## 5. 活叶子的执行语义(续会话收敛)

默认叶子是**活 agent**。带 `verify` + `budget` 的叶子 = **目标驱动**:

> 在**一个持续会话**里干 → verify 在回合间把关 → 没达成就**对同一会话**说"还没到:<反馈>,接着干"
> → 直到 verify 过或 `budget` 轮耗尽 → 升级。

- **续会话**(不是每轮重开 worker):agent **记得自己的 plan 和进度**,不重新规划、不遗忘、不和自己冲突。
- 这同时解决了"plan→execute 数据流":plan 在同一上下文里,执行直接用,不用显式传。
- 放弃的:锚死在烂 plan 上时靠 fresh 重启逃生——先不要,`budget` 到顶就升级。

(机械/`freeze` 叶子是另一条线:无状态重跑/结构性重编,不在此语义内。)

## 5.1 自包含工具(`tools`)与按需注入

活 agent 不该每次现推"怎么 provision / 二进制在哪 / 怎么 deploy"——那既贵又出错。
把这些**机械操作**做成**蒸馏期生成并调通的自包含脚本**(`<agent>.tools/*.sh`),活 agent 调用它们。

- **自包含契约**:工具脚本运行期**只**依赖系统工具(curl/jq/ssh/glab/git/docker)+ 活基础设施;
  **不**读 `~/.claude/skills`、**不** shell-out 到检出里的 `.sh`。skill/repo 逻辑在蒸馏期**内联**进脚本。静态检查兜底。
- **工具自带文档**:每个脚本头写结构化文档(用途/入参/环境/输出/用法),Claude Code 蒸馏时顺手写。
  ```bash
  # deploy.sh
  # 用途:把上一步编译的 minion/skyview-go 部署到 handoff 的环境
  # 入参:无(从 $HANDOFF source WAF_SSH/PLATFORM_ENV_ID)
  # 输出:stdout 打部署目标 host + 进程状态     # 用法:bash deploy.sh
  ```
- **按需、作用域注入**:引擎读该叶子 `tools: [...]` 里那几个工具的头,拼成"你可用的工具:…"
  **只注入这个 agent 的上下文**(不是全量塞所有 agent;不用工具的 agent 不背它们的文档)。
- **intent 不复述工具文档**:intent 只写活儿,按名用工具;只在容易选错处点一句("对账用 provision-env,别自己现搭")。

> 一句话:**工具说明"写一次(在工具里)、注相关(按 `tools`)、不污染 intent"。**

## 6. 运行期契约(不在 YAML)

| 契约 | 说明 |
|---|---|
| 活叶子 `submit_result({status, result})` | `status: done\|blocked`(done→引擎验,**不被信任**;blocked→直接升级);`result`=结果文本,verify 匹配它、下游读它 |
| 判官 `submit_verdict({label, confidence, evidence})` | `evidence` 每条引用实际取证输出(接地,反幻觉);`label` 枚举从 `labels` 装配 |
| transcript 只进日志 | 思考 + 每次工具调用 + 工具输出 = 可观测性(人看),**不进数据流**;数据流只取 `result` |
| `produced` 暂无 | 显式数据流(按名引用上游结构化句柄)defer;现在靠隐式上下文 + handoff 真文件 |

## 7. 安全(运行期,不在 YAML)

- **机制(引擎级,始终在)**:危险工具调用一律经**升级处理器**(approve/escalate)。默认=危险写就升级/拒绝。
- **策略(部署级,可选)**:"动自己专用资源、预算内自动放行"(自管闸)等,**运行时注入**(像模型配置/cwd 注入),
  不进 agent YAML。
- **红线**:软约束写进 `intent`(markdown);硬约束由注入的 handler 兜。
- 于是 agent YAML **纯描述工作、可移植**;换部署换安全策略,不动 agent。

## 8. 完整示例:safeline-3 回归守望

见 `examples/safeline3-watchdog.yaml`(下节内容)。三段:① 一个 agent 干完整管道
(对账→编译→部署→跑测) ② 可复现性分诊(复跑,只判 flaky) ③ 仅确定性失败才归因
(`when` gate + fanout 3 判官只读代码分析 + 投票)。

```yaml
agent: safeline3-回归守望
loop:
  on: 查 safeline-3 仓库 test-agent 分支最新 commit 完整 sha,打到 stdout(只读)
  every: 30m
  do:
    # ① 干活:一个 agent 连续做对账→编译→部署→跑测(状态在它自己上下文里贯通)
    - intent: |
        ## 目标
        守望 test-agent 这次提交:把它的构建部署到本 agent 专用环境,跑出 api-test 结果。
        ## 依次做(状态贯通,别丢)
        1. 对账环境:确保只给本 agent 用的虚拟化环境,基线=平台最新 master 每日构建;状态文件 ~/.piper-watchdog-state 认领。
        2. 编译:隔离检出(已 checkout test-agent)交叉编译 linux/amd64 的 minion + skyview-go。
        3. 部署:把刚编的二进制部署到这台环境(scp→备份→install→重启→确认进程)。
        4. 跑测:unset 代理、source handoff,跑含 C1 透明代理 catch-all 的 route-proxy 全套 api-test。
        ## 红线(软约束;硬授权由运行期 handler 兜)
        - 只动状态文件认领的本 agent 环境;容量满绝不删别人的。
        - 用隔离检出,不用 ~/Code/gitlab;禁止 task prepare。
        - 部署/跑测目标只能是 handoff 的 root@10.2.39.x,严禁 ssh-waf-mgt / 10.2.81.219。
        - 二进制必须是本次刚编的 test-agent 构建。
        ## 输出
        passed/failed 数 + 每个失败用例 trace;留下 handoff 供后续复跑用同一环境。
      tools: [provision-env, build, deploy, run-apitest]   # 运行期调用的自包含脚本(蒸馏生成,在 <agent>.tools/)
      verify:
        intent: 确认测试确实跑在 test-master 的被测构建的本 agent 环境上,且产出了 passed/failed 计数
        ground: [ssh 进环境查 minion/skyview-go 的 githash, 检查输出里有 pass/fail 计数]
      budget: 5

    # ② 可复现性分诊:只判复现、不判根因(复跑当前构建,副作用只一次)
    - intent: |
        看上一步 api-test 结果,做可复现性分诊(只判复现,不判根因):
        - 全部通过 → 「测试通过」。
        - 有失败 → source handoff 用同一环境,复跑失败用例 + 全量(当前构建):
          - 不再复现 / 间歇 → 「flaky」。
          - 确定性复现 → 「确定性失败」。
        输出标签 + 证据。
      labels: [测试通过, flaky, 确定性失败]

    # ③ 归因:仅"确定性失败"才跑;3 判官只从代码/历史静态分析,投票出一个明确结论
    - fanout:
        when: 确定性失败
        over: [{}, {model: qwen-max}, {model: glm-4-plus}]
        intent: |
          确定性复现的失败。只从代码与历史静态分析(只读:相关产品代码、本次 diff、git blame、日志),定性:
          - 真回归:本次改动引入(diff 触及失败路径 / blame 指向本次提交)。
          - 既有问题:bug 在本次未改动的代码里 / blame 指向早先提交 → 早先 MR 或上游引入(非本次)。
          - 测试bug:测试用例自身问题(断言/前置假设错)。
          - 版本错位:被测构建版本不对。
          不复跑旧基线,真回归/既有是基于代码的推断;把握不足就降置信。
          给标签 + 置信度 + 每条引用实际取证(代码/diff/blame/日志)的证据。
        gather:
          how: vote
          labels: [真回归, 既有问题, 测试bug, 版本错位]
        concurrency: 3
```

## 9. 砍掉了什么 + 为什么

| 砍掉 | 原因 |
|---|---|
| `route` | 模型版 if-else;简单决策该在 agent 上下文里做。真要 N 路结构派发再刻意加 |
| `repeat` | 拆解吸收:时间/触发重复=`loop`;目标重试=`verify`+`budget`(续会话);loop-until-dry 小众,defer |
| `sequence` 关键字 | 列表天生有序,无需包裹键 |
| `retry`/旋钮 | 活叶子只 `continue`(续会话);`fresh` 只服务 freeze 那条线,不在 verify 词汇里 |
| `task`/`nl` | 叶子不该叫 agent 原语;统一 `intent`(描述工作,执行模式交引擎) |
| `guard`/`danger`/授权 | 安全=部署级运行期策略,不是 agent 编排词汇;红线软提示进 intent |
| `produced` | 显式数据流 defer;隐式上下文 + handoff 真文件够用 |
| `escalate_if` | vote 只负责定性;拿到 label 后怎么路由是下游/`when` 的事 |

## 10. 词汇全集

```
结构:   loop(on/every/do) · 列表=顺序 · fanout(when?/over/intent?/gather/concurrency?)
叶子:   裸串 | {intent, verify?, budget?, labels?, model?, tools?, using?, cwd?, freeze?}
验收:   verify: string | {intent, ground?, n?}
判官:   叶子带 labels → {label,confidence,evidence};fanout+gather:vote = panel
条件:   when: <label>(机械配紧邻上一步 label,gate 结构)
归约:   gather: { how: vote|merge, labels?, intent?, model? }
工具:   tools: [<自包含脚本名>](蒸馏生成,引擎按需注入文档;<agent>.tools/)
提示词: intent(字符串/markdown,统一所有提示词,引擎不解析)
```

## 11. 落地 TODO(改 schema/引擎)

1. **schema**:typebox 封闭递归 union(节点四形态)+ `intent` 强制字符串 + `findUnknownKey` 报精确路径。
2. **引擎映射**:`leaf→agent()`、`列表→pipeline()`、`fanout→parallel()+gather`、`when→机械 label 比对`。
3. **活叶子执行**:续会话收敛(verify 回合间把关 + budget);`submit_result`/`submit_verdict` 显式产出,
   transcript 进日志(改掉现状"拼 text_delta 当 output")。
4. **判官**:`labels` 装配 verdict schema;`gather:vote` 纯 JS 投票。
5. **tools**:`<agent>.tools/*.sh` 自包含脚本 + 头部文档;引擎按叶子 `tools:[...]` 注入文档到该 agent;静态自包含检查。
6. **安全**:危险工具调用经注入的 escalation handler;自管闸作为可选 handler,部署级注入。
7. **freeze**:可选,把机械叶子直接当脚本跑(无 agent);与 tools 同种自包含产物。

## 12. 蒸馏(Claude Code,authoring)

由 Claude Code 离线在有 infra 的开发机上做,一次产出全部并入仓:

1. 读 用户的 Claude Code 会话(手动做过的流程)+ 相关 skill + repo。
2. 写 **agent YAML**(编排:loop/列表/fanout/when/intent/verify/tools…)。
3. 写 **`<agent>.tools/*.sh`**(自包含工具脚本,粒度自定,每个带文档头;满足自包含+可独立测+单一操作)。
4. **实地调试**:真跑每个工具脚本,验证能用、修 bug;跑通才提交。
5. 提交 YAML + tools + manifest(从工具头派生的索引)。

漂移:工具是快照;上游 API/skill 变了靠运行期 verify+判官发现,或重新蒸馏。
