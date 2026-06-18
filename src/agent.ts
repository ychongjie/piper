// 蒸馏式 agent 的节点模型 + TS builder + 运行时。
// 一份 agent = loop(on=固化触发器) → do(goal/steps,用 skill 做) → verify(panel,独立判官) + guard(自管闸)。
// YAML 和 TS 都编译到这个 AgentDef(窄腰)。词汇由 agent-schema.ts 封闭校验。
// 引擎从 AgentDef【自己解析】steps→固化动作、guard→自管闸、signal→触发契约;项目侧不再手写这些。
// runAgent=单 tick;runSentinel=常驻哨兵(loop+去重+持久化)。

import { homedir } from "node:os";
import type { defineTool } from "@earendil-works/pi-coding-agent";
import { type CrystallizableAction, crystallize } from "./crystallize.ts";
import { type EscalationHandler, selfManagedGate } from "./escalate.ts";
import { loop as scheduleLoop } from "./loop.ts";
import { type PanelResult, panel } from "./panel.ts";

export type SignalKind = "commit-sha" | "package-version" | "nonempty";

export interface AgentDef {
  name: string;
  distilledFrom?: { sessions?: string[]; skills?: string[] };
  backend?: BackendDef;
  forbidRuntimeDeps?: string[]; // 自包含禁则(正则字符串)
  loop: { on: string; signal?: SignalKind; every?: string; do: GoalDef };
  guard?: GuardDef;
}
export interface GoalDef {
  nl: string;
  using?: string[]; // skills
  steps?: StepDef[]; // 声明式多步;缺省=goal 当单步声明
  verify: VerifyDef;
}
export interface StepDef {
  id: string;
  nl: string;
  using?: string[];
  cwd?: string;
  danger?: string | null;
  selfContained?: boolean;
  verify?: string; // 对 stdout 的正则契约;缺省=非空
}
export type VerifyDef = { check: string } | { panel: PanelDef };
export interface PanelDef {
  n: number;
  judge: string;
  ground: string[];
  labels?: string[];
  escalateIf?: string;
}
export interface GuardDef {
  owns?: string; // 认领"本 agent 自管资源"的正则
  budget?: number; // 预算内自动放行次数
  rules?: GuardRule[];
}
export interface GuardRule {
  when: string;
  require: string;
}
export interface BackendDef {
  provider: string;
  model: string;
  baseUrl: string;
  api: string;
  apiKeyEnv: string;
}

// ---- TS builder(和 YAML 等价)----
export const agent = (name: string, meta: Omit<AgentDef, "name" | "loop">, loop: AgentDef["loop"]): AgentDef => ({ name, loop, ...meta });
export const loop = (on: string, doGoal: GoalDef, every?: string) => ({ on, every, do: doGoal });
export const goal = (nl: string, o: { using?: string[]; steps?: StepDef[]; verify: VerifyDef }): GoalDef => ({ nl, ...o });
export const panelOf = (n: number, judge: string, o: { ground: string[]; labels?: string[]; escalateIf?: string }): VerifyDef => ({ panel: { n, judge, ...o } });
export const check = (nl: string): VerifyDef => ({ check: nl });

// ---- 运行时依赖(项目侧注入,只剩"运行环境"相关)----
export interface RunDeps {
  cache: import("./crystallize.ts").CrystalCache;
  escalateFallback: EscalationHandler; // 自管闸的 fallback(有人值守=问人 / 无人=安全默认)
  cwd?: string;
  resolveGround: (groundNl: string[]) => ReturnType<typeof defineTool>[]; // panel ground NL → 取证工具(ground 固化是后续阶段)
  caseForVerify?: () => Promise<{ judgeContext: string } | null>; // 待判失败用例(真实里来自跑测;历史用例是 demo)
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

const DEFAULT_BUILD_ID = (signal: string): string => {
  try {
    const j = JSON.parse(signal);
    return String(j.ref_name ?? j.id ?? signal);
  } catch {
    const m = signal.match(/\d{2}\.\d{2}\.\d{2,}[\w.-]*/);
    return m ? m[0] : signal.trim().slice(0, 60);
  }
};

// signal 枚举 → 触发器输出的验收契约 + build id 抽取(替代项目侧手写 triggerVerify/buildIdOf)。
const SIGNAL: Record<SignalKind, { verify: (o: string) => boolean; buildId: (s: string) => string }> = {
  "commit-sha": {
    verify: (o) => /\b[0-9a-f]{7,40}\b/i.test(o),
    buildId: (s) => {
      const m = s.match(/\b[0-9a-f]{7,40}\b/i);
      return m ? m[0].slice(0, 12) : s.trim().slice(0, 12);
    },
  },
  "package-version": {
    verify: (o) => /\d{2}\.\d{2}\.\d{2,}[\w.-]*/.test(o),
    buildId: (s) => {
      const m = s.match(/\d{2}\.\d{2}\.\d{2,}[\w.-]*/);
      return m ? m[0] : s.trim().slice(0, 60);
    },
  },
  nonempty: { verify: (o) => o.trim().length > 0, buildId: DEFAULT_BUILD_ID },
};
const signalOf = (a: AgentDef) => SIGNAL[a.loop.signal ?? "nonempty"];

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
    cwd: expandHome(s.cwd),
    danger: s.danger ?? null,
    selfContained: s.selfContained,
    verify: compileVerify(s.verify),
  }));

const forbidPatterns = (a: AgentDef): RegExp[] => (a.forbidRuntimeDeps ?? []).map((s) => new RegExp(s));

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

// ── 运行 ────────────────────────────────────────────────────────────────

// ① 探测:固化触发器成只读轮询脚本(强制自包含),探当前最新构建,按 signal 契约抽 build id。
async function detectSignal(a: AgentDef, deps: RunDeps, gate: EscalationHandler, log: (m: string) => void): Promise<{ raw: string; buildId: string } | null> {
  const sc = signalOf(a);
  const trigger: CrystallizableAction = {
    id: `${a.name}__trigger`,
    nl: a.loop.on,
    skills: a.loop.do.using,
    cwd: expandHome(deps.cwd),
    danger: null,
    selfContained: true, // 只读触发器强制自包含(产物可入仓钉死)
    verify: sc.verify,
  };
  try {
    const t = await crystallize(trigger, { cache: deps.cache, escalate: gate, maxRepairs: 1, onLog: log, forbidRuntimeDeps: forbidPatterns(a) });
    if (!t.signal) return null;
    return { raw: t.signal, buildId: sc.buildId(t.signal) };
  } catch (e) {
    log(`[${a.name}] 触发器固化未成:${(e as Error).message}`);
    return null;
  }
}

// ② do:真跑声明式 steps(各按 danger 过自管闸)→ verify(用真实测试输出)。
async function runDo(a: AgentDef, _buildId: string, deps: RunDeps, gate: EscalationHandler, log: (m: string) => void): Promise<{ verify?: PanelResult; steps: StepOutcome[] }> {
  const steps: StepOutcome[] = [];
  let testOutput: string | undefined;
  const forbid = forbidPatterns(a);

  const actions = stepsToActions(a);
  if (actions.length) {
    for (const step of actions) {
      try {
        const r = await crystallize(step, { cache: deps.cache, escalate: gate, onLog: log, forbidRuntimeDeps: forbid });
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

  // verify:有真实测试输出就用它当判官上下文;否则用注入的(历史)用例。
  let verify: PanelResult | undefined;
  const vd = a.loop.do.verify;
  if ("panel" in vd) {
    const ctx = testOutput ?? (deps.caseForVerify ? (await deps.caseForVerify())?.judgeContext : undefined);
    if (ctx) {
      const p = vd.panel;
      log(`verify:起 ${p.n} 个独立判官……`);
      verify = await panel(
        {
          n: p.n,
          judge: `${p.judge}\n\n待判情况:\n${ctx}`,
          ground: deps.resolveGround(p.ground),
          labels: p.labels,
          escalateLabels: p.labels?.filter((l) => /版本错位|out_of_scope|超范围/.test(l)),
        },
        gate,
      );
      log(`verify 判官结论 = ${verify.verdict}${verify.escalated ? "(⚠ 升级)" : ""}  票数=${JSON.stringify(verify.tally)}`);
    } else {
      log("verify:无失败用例 / 无测试输出(测试干净 → 无回归)");
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
