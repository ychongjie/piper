// 蒸馏式 agent 的节点模型 + TS builder + 运行时。
// 一份 agent = loop(on=固化触发器, every) → do(goal/steps,用 skill 做) → judge(独立判官) + guard(自管闸)。
// YAML 和 TS 都编译到这个 AgentDef(窄腰)。词汇由 agent-schema.ts 封闭校验。
// 引擎从 AgentDef【自己解析】steps→固化动作、guard→自管闸;触发器去重=stdout 全等;项目侧不再手写这些。
// runAgent=单 tick;runSentinel=常驻哨兵(loop+去重+持久化)。

import { homedir } from "node:os";
import { type CrystallizableAction, type CrystalCache, compileAction } from "./compile.ts";
import { runAction } from "./execute.ts";
import { type EscalationHandler, selfManagedGate } from "./escalate.ts";
import { loop as scheduleLoop } from "./loop.ts";
import { type PanelResult, panel } from "./panel.ts";

export interface AgentDef {
  name: string;
  loop: { on: string; every?: string; do: GoalDef };
  guard?: GuardDef;
}
export interface GoalDef {
  nl: string; // goal:这一轮的意图
  using?: string[]; // skills(编译期参考;step 缺省继承)
  model?: string; // 默认标准模型名(触发器 + 各 step 缺省用它;step 可覆盖)
  steps?: StepDef[]; // 声明式多步
  judge?: JudgeDef; // do 层验收=活判断(独立判官);缺省=只靠各 step 的 verify
}
export interface StepDef {
  id: string;
  nl: string;
  using?: string[];
  model?: string; // 本步用的标准模型名(覆盖 do.model);查 piper 配置解析
  cwd?: string;
  danger?: string | null;
  selfContained?: boolean;
  verify?: string; // 对 stdout 的正则契约;缺省=非空
}
export interface JudgeDef {
  ask: string; // 判官判什么(NL)
  ground: string[]; // 取证手段(NL → 运行期解析成工具)
  labels?: string[]; // 候选结论
}
export interface GuardDef {
  owns?: string; // 认领"本 agent 自管资源"的正则
  budget?: number; // 预算内自动放行次数
}

// ---- TS builder(和 YAML 等价)----
export const agent = (name: string, meta: Omit<AgentDef, "name" | "loop">, loop: AgentDef["loop"]): AgentDef => ({ name, loop, ...meta });
export const loop = (on: string, doGoal: GoalDef, every?: string) => ({ on, every, do: doGoal });
export const goal = (nl: string, o: { using?: string[]; model?: string; steps?: StepDef[]; judge?: JudgeDef }): GoalDef => ({ nl, ...o });
export const judgeOf = (ask: string, o: { ground: string[]; labels?: string[] }): JudgeDef => ({ ask, ...o });

// ---- 运行时依赖(项目侧注入,只剩"运行环境"相关)----
export interface RunDeps {
  cache: CrystalCache;
  escalateFallback: EscalationHandler; // 自管闸的 fallback(有人值守=问人 / 无人=安全默认)
  cwd?: string;
  caseForVerify?: () => Promise<{ judgeContext: string } | null>; // 待判失败用例(真实里来自跑测;历史用例是 demo)
  compileMissing?: boolean; // 执行期缺产物时就地编译(dev/惰性);缺省 false=严格,先跑 compileAgent
  onLog?: (m: string) => void;
}

export interface StepOutcome {
  id: string;
  mode: string;
  ok: boolean;
  note: string;
}

export interface TickResult {
  signal: string | null;
  buildId: string | null;
  verify?: PanelResult;
  steps: StepOutcome[];
}

// ── 引擎解析:从 AgentDef 派生触发契约 / 步骤动作 / 自管闸 ──────────────────

const DEFAULT_JUDGES = 3; // judge 起几个独立判官(默认;不进 YAML 词汇)
// 触发器去重 = stdout 全等:触发器脚本编译后只打印那一个构建 key,无需 signal 枚举抽取。
const buildIdOf = (raw: string): string => raw.trim();

// YAML 里 cwd 可写 ~/… 或 $HOME/…(引擎展开;cwd 传给 spawn 不经 shell,不会自动展开)。
const expandHome = (p?: string): string | undefined => p?.replace(/^(~|\$HOME)(?=\/|$)/, homedir());

const compileVerify = (re?: string): ((o: string) => boolean) => {
  if (!re) return (o) => o.trim().length > 0;
  const rx = new RegExp(re);
  return (o) => rx.test(o);
};

// 声明式 steps → 可固化动作(verify 正则串编译成谓词)。
const stepsToActions = (a: AgentDef): CrystallizableAction[] =>
  (a.loop.do.steps ?? []).map((s) => ({
    id: `${a.name}__${s.id}`,
    nl: s.nl,
    skills: s.using ?? a.loop.do.using,
    model: s.model ?? a.loop.do.model, // step 覆盖 → do 默认 → 配置 default
    cwd: expandHome(s.cwd),
    danger: s.danger ?? null,
    selfContained: s.selfContained,
    verify: compileVerify(s.verify),
  }));

// guard → 自管闸:owns 命中且预算内自动放行,否则走 fallback。无 owns 则直接用 fallback。
const buildGate = (a: AgentDef, fallback: EscalationHandler): EscalationHandler => {
  const g = a.guard;
  if (!g?.owns) return fallback;
  const re = new RegExp(g.owns);
  return selfManagedGate({
    owns: (reason) => re.test(reason),
    budget: g.budget != null ? { max: g.budget, used: { n: 0 } } : undefined,
    fallback,
  });
};

// 触发器动作:固化成只读轮询脚本(强制自包含),探当前最新构建。
const triggerAction = (a: AgentDef, cwd?: string): CrystallizableAction => ({
  id: `${a.name}__trigger`,
  nl: a.loop.on,
  skills: a.loop.do.using,
  model: a.loop.do.model, // 触发器用 do 默认编译模型
  cwd: expandHome(cwd),
  danger: null,
  selfContained: true, // 只读触发器强制自包含(产物可入仓钉死)
  verify: (o) => o.trim().length > 0, // 触发器只需非空;去重=stdout 全等
});

// ── 编译阶段:离线把触发器 + 所有 step 固化成自包含产物(入仓、可 review)──────────
/** 编译一个 agent 的全部动作(触发器 + steps)。执行前先跑此阶段;执行期不再首次编译。 */
export async function compileAgent(a: AgentDef, deps: Pick<RunDeps, "cache" | "escalateFallback" | "cwd" | "onLog">): Promise<void> {
  const log = deps.onLog ?? (() => {});
  const gate = buildGate(a, deps.escalateFallback);
  const actions = [triggerAction(a, deps.cwd), ...stepsToActions(a)];
  log(`[${a.name}] 编译阶段:${actions.length} 个动作`);
  for (const action of actions) {
    await compileAction(action, { cache: deps.cache, escalate: gate, selfContained: action.selfContained, onLog: (m) => log(`  ${m}`) });
  }
  log(`[${a.name}] 编译完成`);
}

// ── 执行 ────────────────────────────────────────────────────────────────

// ① 探测:跑已编译的触发器脚本,取 stdout 作构建 key(去重=全等)。
async function detectSignal(a: AgentDef, deps: RunDeps, gate: EscalationHandler, log: (m: string) => void): Promise<{ raw: string; buildId: string } | null> {
  const trigger = triggerAction(a, deps.cwd);
  try {
    const t = await runAction(trigger, { cache: deps.cache, escalate: gate, maxRepairs: 1, onLog: log, selfContained: true, compileIfMissing: deps.compileMissing });
    if (!t.signal) return null;
    return { raw: t.signal, buildId: buildIdOf(t.signal) };
  } catch (e) {
    log(`[${a.name}] 触发器执行未成:${(e as Error).message}`);
    return null;
  }
}

// ② do:真跑声明式 steps(各按 danger 过自管闸)→ verify(用真实测试输出)。
async function runDo(a: AgentDef, _buildId: string, deps: RunDeps, gate: EscalationHandler, log: (m: string) => void): Promise<{ verify?: PanelResult; steps: StepOutcome[] }> {
  const steps: StepOutcome[] = [];
  let testOutput: string | undefined;

  const actions = stepsToActions(a);
  if (actions.length) {
    for (const step of actions) {
      try {
        const r = await runAction(step, { cache: deps.cache, escalate: gate, onLog: log, compileIfMissing: deps.compileMissing });
        steps.push({ id: step.id, mode: r.mode, ok: true, note: r.mode });
        log(`步骤 ${step.id}:${r.mode} ✓`);
        testOutput = r.output; // 最后一步(run-test)的输出 = 真实测试结果
      } catch (e) {
        const note = (e as Error).message;
        steps.push({ id: step.id, mode: "failed", ok: false, note });
        log(`步骤 ${step.id} 中止:${note}`);
        return { steps }; // 一步挂/被拒(如建别人的环境被升级deny)→ 停 do
      }
    }
  } else {
    log(`goal:${a.loop.do.nl} —— do 未声明 steps`);
  }

  // judge:有真实测试输出就用它当判官上下文;否则用注入的(历史)用例。
  let verify: PanelResult | undefined;
  const jd = a.loop.do.judge;
  if (jd) {
    const ctx = testOutput ?? (deps.caseForVerify ? (await deps.caseForVerify())?.judgeContext : undefined);
    if (ctx) {
      log(`judge:起 ${DEFAULT_JUDGES} 个独立判官……`);
      verify = await panel(
        {
          n: DEFAULT_JUDGES,
          judge: `${jd.ask}\n\n待判情况:\n${ctx}`,
          groundNl: jd.ground, // 取证手段(NL)进判官提示词;判官用只读 read/bash 自己取证
          cwd: expandHome(deps.cwd),
          labels: jd.labels,
          escalateLabels: jd.labels?.filter((l) => /版本错位|out_of_scope|超范围/.test(l)),
        },
        gate,
      );
      log(`judge 判官结论 = ${verify.verdict}${verify.escalated ? "(⚠ 升级)" : ""}  票数=${JSON.stringify(verify.tally)}`);
    } else {
      log("judge:无失败用例 / 无测试输出(测试干净 → 无回归)");
    }
  }
  return { verify, steps };
}

/** 跑一个完整 tick:探新构建 → do(真跑步骤 + verify panel)。 */
export async function runAgent(a: AgentDef, deps: RunDeps): Promise<TickResult> {
  const log = deps.onLog ?? (() => {});
  const gate = buildGate(a, deps.escalateFallback);
  const sig = await detectSignal(a, deps, gate, log);
  log(`[${a.name}] 新构建信号 = ${sig?.buildId ?? "(无)"}`);
  if (!sig) return { signal: null, buildId: null, steps: [] };
  const r = await runDo(a, sig.buildId, deps, gate, (m) => log(`[${a.name}] ${m}`));
  return { signal: sig.raw, buildId: sig.buildId, ...r };
}

/** 常驻哨兵:loop 定时探新构建 → 去重(vs 持久化 last-seen)→ 新构建才跑 do。 */
export async function runSentinel(
  a: AgentDef,
  deps: RunDeps,
  opts: { intervalMs: number; maxTicks?: number; statePath?: string },
): Promise<{ ticks: number; lastSeen: string | null; reason: string }> {
  const gate = buildGate(a, deps.escalateFallback);
  const r = await scheduleLoop<{ lastSeen: string | null }>({
    name: a.name,
    state: { lastSeen: null },
    statePath: opts.statePath,
    intervalMs: opts.intervalMs,
    maxTicks: opts.maxTicks,
    onLog: deps.onLog,
    tick: async ({ tick, state, log }) => {
      const sig = await detectSignal(a, deps, gate, () => {}); // 探测安静(命中缓存=便宜)
      if (!sig) {
        log(`  tick ${tick}:没探到构建`);
        return;
      }
      if (sig.buildId === state.lastSeen) {
        log(`  tick ${tick}:无新构建(${sig.buildId})→ 跳过`);
        return;
      }
      log(`  tick ${tick}:🔔 新构建 ${sig.buildId}(上次=${state.lastSeen ?? "无"})→ 触发守望`);
      await runDo(a, sig.buildId, deps, gate, (m) => log(`    ${m}`));
      state.lastSeen = sig.buildId;
    },
  });
  return { ticks: r.ticks, lastSeen: r.state.lastSeen, reason: r.reason };
}
