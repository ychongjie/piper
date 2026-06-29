# Piper 设计基线(agent 编排 YAML)

> 本文是 Piper 的设计基线,也是**当前实现**:封闭 YAML 词汇由 `src/v2/engine.ts` 活解释执行
> (`loadAgentV2`/`runOnce`)。早期的 crystallize/compile/steps/guard 三阶段形态已删除,只保留 v2 活引擎。

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
那篇只把**编排**做成确定性,**工作**永远是活 LLM;Piper 沿用这一点——运行时**叶子永远是活 agent**,
引擎只解释封闭的编排结构(loop/列表/fanout/when),不把工作固化成死脚本。
(机械操作另由蒸馏期调通的**自包含工具**承担,活 agent 按名调用——见 §5.1。)

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
| `{ intent, verify?, budget?, labels?, model?, tools?, using?, cwd?, when? }` | 叶子(带属性) |
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
| `model` | 标准模型名(省略=`default_model`,piper 配置映射到网关);引擎日志按 `[角色·模型]` 标注每个 agent 输出,便于分析/benchmark |
| `tools` | **运行期可调的自包含工具脚本名**(蒸馏生成,在 `<agent>.tools/`);引擎注入这些工具及其文档给该 agent(见 §5.1) |
| `using` | 蒸馏期参考的知识来源 skill(从中内联出 `tools`) |
| `cwd` | 工作目录(可 `~`/`$HOME`) |
| `when` | 机械守卫:紧邻上一步 label == 此值才跑(见 §3 `when`) |

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

(机械操作不进叶子语义,由蒸馏期调通的自包含**工具**承担,活 agent 按名调用——见 §5.1。)

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

完整可跑的版本(含调通的 `.tools/`)在 `piper-agents` 仓库;本仓 `examples/safeline3-watchdog.yaml`
是同结构的精简示例。三段管道:

```yaml
agent: safeline3-回归守望
loop:
  on: 查 origin/master 最新一次合入的完整 sha(只读;sha 没变=没有新合入)
  every: 30m
  do:
    # ① 干活:一个 agent 连续 provision→编译→部署→跑测(状态在它自己上下文里贯通)
    - intent: |
        守望 master 最新合入:provision 本 agent 专用环境 → 编译并部署该构建 → 跑 api-test。
        (机械步骤都调注入的 tools;红线软约束写这里,硬授权由运行期 handler 兜。)
      tools: [provision-env, build, deploy, run-apitest]
      verify:                       # 独立判官:只从执行者贴出的工具输出/本地文件取证
        intent: 确认确实部署了本次构建并跑出了 api-test 计数
        ground: [build githash, deploy 进程状态, run-apitest 的 passed/failed 计数]
      budget: 4

    # ② 可复现性分诊:只判复现、不判根因
    - intent: 看 api-test 结果——全过→「测试通过」;有失败则复跑判定→「flaky」或「确定性失败」。
      tools: [run-apitest]
      labels: [测试通过, flaky, 确定性失败]

    # ③ 归因:仅"确定性失败"才跑;3 个不同模型的判官只读静态分析,投票出一个结论
    - fanout:
        when: 确定性失败
        over: [{model: deepseek-v4-pro}, {model: glm-5.2}, {model: kimi-k2.7-code}]
        intent: |
          确定性失败,只从代码与历史静态分析(diff/git blame/日志)定性:
          真回归 / 既有问题 / 测试bug / 版本错位。每条结论引用实际取证。
        gather: { how: vote, labels: [真回归, 既有问题, 测试bug, 版本错位] }
        concurrency: 1
```

- **主控用 `default_model`,只有归因 fanout 分流多个模型**(模型多样性 + 横评 benchmark)。
- 引擎日志把每个 agent 的输出按 `[角色·模型]` 标注(执行/分诊/验收/归因#N · 各自模型),
  grep 即可分离某 agent / 某模型的全部输出。

## 9. 砍掉了什么 + 为什么

| 砍掉 | 原因 |
|---|---|
| `route` | 模型版 if-else;简单决策该在 agent 上下文里做。真要 N 路结构派发再刻意加 |
| `repeat` | 拆解吸收:时间/触发重复=`loop`;目标重试=`verify`+`budget`(续会话);loop-until-dry 小众,defer |
| `sequence` 关键字 | 列表天生有序,无需包裹键 |
| `retry`/旋钮 | 活叶子只 `continue`(续会话收敛),没有 `fresh`/`retry` 旋钮 |
| `task`/`nl` | 叶子不该叫 agent 原语;统一 `intent`(描述工作,执行模式交引擎) |
| `guard`/`danger`/授权 | 安全=部署级运行期策略,不是 agent 编排词汇;红线软提示进 intent |
| `produced` | 显式数据流 defer;隐式上下文 + handoff 真文件够用 |
| `escalate_if` | vote 只负责定性;拿到 label 后怎么路由是下游/`when` 的事 |
| `compile`/`crystallize`/`freeze`/`steps`/`guard`(三阶段) | 早期把每步 NL 编译成钉死 `.sh` 入仓的形态;改为引擎活解释 YAML、机械操作下放给自包含 `tools`,整条删除 |

## 10. 词汇全集

```
结构:   loop(on/every/do) · 列表=顺序 · fanout(when?/over/intent?/gather/concurrency?)
叶子:   裸串 | {intent, verify?, budget?, labels?, model?, tools?, using?, cwd?, when?}
验收:   verify: string | {intent, ground?, n?}
判官:   叶子带 labels → {label,confidence,evidence};fanout+gather:vote = panel
条件:   when: <label>(机械配紧邻上一步 label,gate 结构)
归约:   gather: { how: vote|merge, labels?, intent?, model? }
工具:   tools: [<自包含脚本名>](蒸馏生成,引擎按需注入文档;<agent>.tools/)
提示词: intent(字符串/markdown,统一所有提示词,引擎不解析)
```

## 11. 实现映射(`src/v2`)

| 设计 | 实现 |
|---|---|
| 节点四形态(裸串/叶子/fanout/列表) | `engine.ts` `Node` union + `isLeaf`/`isFanout` 判别(YAML 类型分派,无独立 schema 校验) |
| 列表=顺序、`fanout`、`when` | `runList`(prior/history 线程)、`runFanout`(over→并发 cap→`gather:vote` 多数票)、`runNode` 里 `when` 机械配 label |
| 活叶子续会话收敛 | `runLeaf`:一个 pi 会话续跑,verify 回合间把关,到 `budget` 升级 |
| 判官 / 投票 | 叶子带 `labels` → `submit_verdict`;`gather:vote` 纯 JS 投票 |
| 运行期契约 | `submit_result`/`submit_verdict` 用 `defineTool`,transcript→`observe()` 进日志(带 `[角色·模型]` 标签) |
| tools 按需注入 | `injectTools`/`toolDoc` 读 `<agent>.tools/<name>.sh` 头部,按叶子 `tools:[...]` 注入 |
| 模型/网关 | `resolveModel`(`config.ts`)+ `backendForModel`(`session.ts`,进程内注册 provider) |

> 安全(危险工具经升级 handler、自管闸)是运行期注入的策略(§7),由宿主 runner 配,不在引擎核心。

## 12. 蒸馏(Claude Code,authoring)

由 Claude Code 离线在有 infra 的开发机上做,一次产出全部并入仓:

1. 读 用户的 Claude Code 会话(手动做过的流程)+ 相关 skill + repo。
2. 写 **agent YAML**(编排:loop/列表/fanout/when/intent/verify/tools…)。
3. 写 **`<agent>.tools/*.sh`**(自包含工具脚本,粒度自定,每个带文档头;满足自包含+可独立测+单一操作)。
4. **实地调试**:真跑每个工具脚本,验证能用、修 bug;跑通才提交。
5. 提交 agent YAML + `<agent>.tools/*.sh`(+ 项目侧 runner:设 cwd/toolsDir、监控循环)。

漂移:工具是快照;上游 API/skill 变了靠运行期 verify+判官发现,或重新蒸馏。
