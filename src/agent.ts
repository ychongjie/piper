// 蒸馏式 agent 的节点模型 + TS builder + 运行时。
// 一份 agent = loop(on=固化触发器) → do(goal,用 skill 做) → verify(panel,独立判官) + guard(授权闸)。
// YAML 和 TS 都编译到这个 AgentDef(窄腰)。runAgent=单 tick;runSentinel=常驻哨兵(loop+去重+持久化)。

import type { defineTool } from "@earendil-works/pi-coding-agent";
import { type CrystallizableAction, crystallize } from "./crystallize.ts";
import type { EscalationHandler } from "./escalate.ts";
import { loop as scheduleLoop } from "./loop.ts";
import { type PanelResult, panel } from "./panel.ts";

export interface AgentDef {
  name: string;
  distilledFrom?: { sessions?: string[]; skills?: string[] };
  loop: { on: string; every?: string; do: GoalDef };
  guard?: GuardRule[];
}
export interface GoalDef {
  nl: string;
  using?: string[]; // skills
  verify: VerifyDef;
}
export type VerifyDef = { check: string } | { panel: PanelDef };
export interface PanelDef {
  n: number;
  judge: string;
  ground: string[];
  labels?: string[];
  escalateIf?: string;
}
export interface GuardRule {
  when: string;
  require: string;
}

// ---- TS builder(和 YAML 等价)----
export const agent = (name: string, meta: Omit<AgentDef, "name" | "loop">, loop: AgentDef["loop"]): AgentDef => ({ name, loop, ...meta });
export const loop = (on: string, doGoal: GoalDef, every?: string) => ({ on, every, do: doGoal });
export const goal = (nl: string, o: { using?: string[]; verify: VerifyDef }): GoalDef => ({ nl, ...o });
export const panelOf = (n: number, judge: string, o: { ground: string[]; labels?: string[]; escalateIf?: string }): VerifyDef => ({ panel: { n, judge, ...o } });
export const check = (nl: string): VerifyDef => ({ check: nl });

// ---- 运行时依赖(项目侧注入)----
export interface RunDeps {
  cache: import("./crystallize.ts").CrystalCache;
  escalate: EscalationHandler;
  resolveGround: (groundNl: string[]) => ReturnType<typeof defineTool>[]; // panel ground NL → 真实取证工具
  cwd?: string;
  caseForVerify?: () => Promise<{ judgeContext: string } | null>; // 待判失败用例(真实里来自跑测)
  buildIdOf?: (signal: string) => string; // 从 signal 抽稳定 build id(默认解析 ref_name/sha/版本号)
  triggerVerify?: (out: string) => boolean; // 触发器输出的验收契约(项目侧定;如 commit sha / 包版本)
  onLog?: (m: string) => void;
}

export interface TickResult {
  signal: string | null;
  buildId: string | null;
  verify?: PanelResult;
  guardsBlocked: string[];
}

const DEFAULT_BUILD_ID = (signal: string): string => {
  try {
    const j = JSON.parse(signal);
    return String(j.ref_name ?? j.id ?? signal);
  } catch {
    const m = signal.match(/\d{2}\.\d{2}\.\d{2,}[\w.-]*/);
    return m ? m[0] : signal.trim().slice(0, 60);
  }
};

// ① 探测:固化触发器成只读轮询脚本,探当前最新构建,抽稳定 build id。
async function detectSignal(a: AgentDef, deps: RunDeps, log: (m: string) => void): Promise<{ raw: string; buildId: string } | null> {
  const trigger: CrystallizableAction = {
    id: `${a.name}__trigger`,
    nl: a.loop.on,
    skills: a.loop.do.using,
    cwd: deps.cwd,
    danger: null,
    // 真验收契约由项目侧给(如 commit sha / 包版本);默认仅"非空"。强契约防弱验收缓存垃圾。
    verify: deps.triggerVerify ?? ((out) => out.trim().length > 0),
  };
  try {
    const t = await crystallize(trigger, { cache: deps.cache, escalate: deps.escalate, maxRepairs: 1, onLog: log });
    if (!t.signal) return null;
    return { raw: t.signal, buildId: (deps.buildIdOf ?? DEFAULT_BUILD_ID)(t.signal) };
  } catch (e) {
    log(`[${a.name}] 触发器固化未成:${(e as Error).message}`);
    return null;
  }
}

// ② do:更新环境+跑测(动共享资源过 guard)→ verify(失败用例用 panel 独立判官)。
async function runDo(a: AgentDef, _buildId: string, deps: RunDeps, log: (m: string) => void): Promise<{ verify?: PanelResult; guardsBlocked: string[] }> {
  const guardsBlocked: string[] = [];
  for (const g of a.guard ?? []) {
    const res = await deps.escalate({ kind: "authorization", reason: `${g.when} → ${g.require}`, options: ["approve", "deny"] });
    if (res.decision !== "approve") {
      guardsBlocked.push(g.when);
      log(`授权闸拦下:${g.when}(无人值守→${res.decision})`);
    }
  }
  log(`goal:${a.loop.do.nl} —— 用 ${(a.loop.do.using ?? []).join("/")} skill(provision/teardown 受 guard)`);

  let verify: PanelResult | undefined;
  const vd = a.loop.do.verify;
  if ("panel" in vd) {
    const c = deps.caseForVerify ? await deps.caseForVerify() : null;
    if (c) {
      const p = vd.panel;
      log(`verify:起 ${p.n} 个独立判官……`);
      verify = await panel(
        {
          n: p.n,
          judge: `${p.judge}\n\n待判情况:\n${c.judgeContext}`,
          ground: deps.resolveGround(p.ground),
          labels: p.labels,
          escalateLabels: p.labels?.filter((l) => /版本错位|out_of_scope|超范围/.test(l)),
        },
        deps.escalate,
      );
      log(`verify 判官结论 = ${verify.verdict}${verify.escalated ? "(⚠ 升级)" : ""}  票数=${JSON.stringify(verify.tally)}`);
    } else {
      log("verify:本轮无失败用例(测试干净 → 无回归)");
    }
  }
  return { verify, guardsBlocked };
}

/** 跑一个完整 tick:探新构建 → do(guard + verify panel)。 */
export async function runAgent(a: AgentDef, deps: RunDeps): Promise<TickResult> {
  const log = deps.onLog ?? (() => {});
  const sig = await detectSignal(a, deps, log);
  log(`[${a.name}] 新构建信号 = ${sig?.buildId ?? "(无)"}`);
  if (!sig) return { signal: null, buildId: null, guardsBlocked: [] };
  const r = await runDo(a, sig.buildId, deps, (m) => log(`[${a.name}] ${m}`));
  return { signal: sig.raw, buildId: sig.buildId, ...r };
}

/** 常驻哨兵:loop 定时探新构建 → 去重(vs 持久化 last-seen)→ 新构建才跑 do。 */
export async function runSentinel(
  a: AgentDef,
  deps: RunDeps,
  opts: { intervalMs: number; maxTicks?: number; statePath?: string },
): Promise<{ ticks: number; lastSeen: string | null; reason: string }> {
  const r = await scheduleLoop<{ lastSeen: string | null }>({
    name: a.name,
    state: { lastSeen: null },
    statePath: opts.statePath,
    intervalMs: opts.intervalMs,
    maxTicks: opts.maxTicks,
    onLog: deps.onLog,
    tick: async ({ tick, state, log }) => {
      const sig = await detectSignal(a, deps, () => {}); // 探测安静(命中缓存=便宜)
      if (!sig) {
        log(`  tick ${tick}:没探到构建`);
        return;
      }
      if (sig.buildId === state.lastSeen) {
        log(`  tick ${tick}:无新构建(${sig.buildId})→ 跳过`);
        return;
      }
      log(`  tick ${tick}:🔔 新构建 ${sig.buildId}(上次=${state.lastSeen ?? "无"})→ 触发守望`);
      await runDo(a, sig.buildId, deps, (m) => log(`    ${m}`)); // ← 串起 guard + verify panel(归因)
      state.lastSeen = sig.buildId;
    },
  });
  return { ticks: r.ticks, lastSeen: r.state.lastSeen, reason: r.reason };
}
