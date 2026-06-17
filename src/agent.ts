// 蒸馏式 agent 的节点模型 + TS builder + 运行时。
// 一份 agent = loop(on=固化触发器) → do(goal,用 skill 做) → verify(panel,独立判官) + guard(授权闸)。
// YAML 和 TS 都编译到这个 AgentDef(窄腰),由 runAgent 执行。

import type { defineTool } from "@earendil-works/pi-coding-agent";
import { type CrystalCache, type CrystallizableAction, crystallize } from "./crystallize.ts";
import type { EscalationHandler } from "./escalate.ts";
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
  ground: string[]; // 取证工具的 NL 描述(各自固化 / 注册)
  labels?: string[];
  escalateIf?: string;
}
export interface GuardRule {
  when: string;
  require: string;
}

// ---- TS builder(让 TS 创作面和 YAML 等价)----
export const agent = (name: string, meta: Omit<AgentDef, "name" | "loop">, loop: AgentDef["loop"]): AgentDef => ({ name, loop, ...meta });
export const loop = (on: string, doGoal: GoalDef, every?: string) => ({ on, every, do: doGoal });
export const goal = (nl: string, o: { using?: string[]; verify: VerifyDef }): GoalDef => ({ nl, ...o });
export const panelOf = (n: number, judge: string, o: { ground: string[]; labels?: string[]; escalateIf?: string }): VerifyDef => ({ panel: { n, judge, ...o } });
export const check = (nl: string): VerifyDef => ({ check: nl });

// ---- 运行时依赖(项目侧注入:固化缓存、升级、取证工具、被验的失败用例来源)----
export interface RunDeps {
  cache: CrystalCache;
  escalate: EscalationHandler;
  // 把 panel 的 ground NL 列表解析成真实取证工具(项目注册表;git 真跑、查引擎等)
  resolveGround: (groundNl: string[]) => ReturnType<typeof defineTool>[];
  // 触发器/动作工作目录(如隔离 clone)
  cwd?: string;
  // 演示/真实:goal 跑测后拿到的"待判失败用例上下文"(真实里来自跑测;这里可注入历史真实用例)
  caseForVerify?: () => Promise<{ judgeContext: string } | null>;
  onLog?: (m: string) => void;
}

export interface TickResult {
  signal: string | null; // 探到的新构建
  verify?: PanelResult; // verify 判官结论
  guardsBlocked: string[]; // 被授权闸拦下的危险写
}

/** 跑一个 tick:固化触发器探新构建 → (goal 受 guard)→ verify 用 panel 独立判官。 */
export async function runAgent(a: AgentDef, deps: RunDeps): Promise<TickResult> {
  const log = deps.onLog ?? (() => {});
  const guardsBlocked: string[] = [];

  // ① 触发器:固化成只读轮询脚本,探当前最新构建。
  const trigger: CrystallizableAction = {
    id: `${a.name}__trigger`,
    nl: a.loop.on,
    skills: a.loop.do.using,
    cwd: deps.cwd,
    danger: null, // 只读
    verify: (out) => out.trim().length > 0 && !/error|fail/i.test(out.split("\n").pop() ?? ""),
  };
  log(`[agent:${a.name}] 触发器固化:${a.loop.on}`);
  let signal: string | null = null;
  try {
    const t = await crystallize(trigger, { cache: deps.cache, escalate: deps.escalate, maxRepairs: 1, onLog: log });
    signal = t.signal || null;
    log(`[agent:${a.name}] 触发器(${t.mode}) → 新构建信号 = ${signal ?? "(无)"}`);
  } catch (e) {
    log(`[agent:${a.name}] 触发器固化未成(${(e as Error).message});继续(机制已演示)`);
  }

  // ② goal:更新环境+跑测。动共享资源的步骤先过 guard(授权闸)。
  for (const g of a.guard ?? []) {
    const res = await deps.escalate({ kind: "authorization", reason: `${g.when} → ${g.require}`, options: ["approve", "deny"] });
    if (res.decision !== "approve") {
      guardsBlocked.push(g.when);
      log(`[agent:${a.name}] 授权闸拦下:${g.when}(无人值守→${res.decision})`);
    }
  }
  log(`[agent:${a.name}] goal:${a.loop.do.nl} —— 用 ${(a.loop.do.using ?? []).join("/")} skill(provision/teardown 受 guard)`);

  // ③ verify:有失败用例就用 panel 独立判官(执行者≠判官)。
  const verifyDef = a.loop.do.verify;
  let verify: PanelResult | undefined;
  if ("panel" in verifyDef) {
    const c = deps.caseForVerify ? await deps.caseForVerify() : null;
    if (c) {
      const p = verifyDef.panel;
      log(`[agent:${a.name}] verify:起 ${p.n} 个独立判官……`);
      verify = await panel(
        {
          n: p.n,
          judge: `${p.judge}\n\n待判情况:\n${c.judgeContext}`,
          ground: deps.resolveGround(p.ground),
          labels: p.labels,
          escalateLabels: p.labels?.filter((l) => /版本错位|out_of_scope|超范围/.test(l)),
          onWorkerEvent: undefined,
        },
        deps.escalate,
      );
      log(`[agent:${a.name}] verify 判官结论 = ${verify.verdict}${verify.escalated ? "(⚠ 升级)" : ""}  票数=${JSON.stringify(verify.tally)}`);
    } else {
      log(`[agent:${a.name}] verify:本轮无失败用例(测试干净 → 无回归)`);
    }
  }

  return { signal, verify, guardsBlocked };
}
