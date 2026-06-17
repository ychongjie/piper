// spec 引擎:厚层的收口。把"声明式 agent spec"跑起来 —— detect→(每阶段 run→verify→
// 失败匹配修复表→没命中则归因/升级)→记录,全程在 loop 里带状态持久化。
//
// 薄层只声明:探什么信号、有哪些阶段、每阶段怎么验收、失败对应什么修复、哪些是要授权的共享写、
// 失败归因用什么。控制流(循环/重试/修复匹配/升级/持久化)全在这个引擎里,写一次。

import type { CheckResult } from "./check.ts";
import { type EscalationHandler, authorizationGate, resolveOrEscalate } from "./escalate.ts";
import { type LoopResult, loop } from "./loop.ts";
import type { BestOfNResult } from "./ttc.ts";

export interface StageContext<S> {
  signal: string; // 本 tick 处理的工作信号(如构建 tag)
  state: S;
  log: (m: string) => void;
}

export interface Remediation<S> {
  match: RegExp; // 验收输出里的症状
  remedy: string; // 修复动作的人类描述
  apply: (ctx: StageContext<S>) => Promise<void>; // 施加修复(之后引擎重跑 run+verify)
}

export interface Stage<S> {
  id: string;
  run: (ctx: StageContext<S>) => Promise<{ output: string } | void>;
  verify?: (output: string, ctx: StageContext<S>) => CheckResult | Promise<CheckResult>;
  onFail?: Remediation<S>[]; // 症状→修复表(便宜模型按表执行,不做判断)
  attribute?: (ctx: StageContext<S>) => Promise<BestOfNResult<{ label: string }>>; // 没命中修复→TTC 归因
  authorize?: (ctx: StageContext<S>) => string | null; // 返回危险描述则先过授权闸
  required?: boolean; // 失败则中止本 tick 后续阶段
}

export interface StageResult {
  id: string;
  ok: boolean;
  note: string;
}

export interface AgentSpec<S extends object> {
  name: string;
  state: S;
  statePath?: string;
  intervalMs?: number;
  maxTicks?: number;
  detect: (state: S) => Promise<string | null>; // 探工作信号;null = 没活干,结束
  isNew: (signal: string, state: S) => boolean; // 是否新信号(否则跳过本 tick)
  record: (signal: string, state: S, results: StageResult[]) => void; // 记录处理结果到 state
  stages: Stage<S>[];
  escalate: EscalationHandler;
}

async function runStage<S extends object>(
  stage: Stage<S>,
  ctx: StageContext<S>,
  escalate: EscalationHandler,
): Promise<StageResult> {
  // 授权闸:共享写操作先问人,拒则不执行。
  if (stage.authorize) {
    const danger = stage.authorize(ctx);
    if (danger) {
      const gate = authorizationGate({ isDangerous: () => danger, handler: escalate });
      const blocked = await gate({ toolCall: { name: stage.id } });
      if (blocked?.block) return { id: stage.id, ok: false, note: `授权被拒:${danger}` };
    }
  }

  let out = (await stage.run(ctx)) ?? { output: "" };
  if (!stage.verify) return { id: stage.id, ok: true, note: "完成(无验收)" };

  let res = await stage.verify(out.output, ctx);
  if (res.ok) return { id: stage.id, ok: true, note: "验收通过" };

  // 修复表:命中症状→施加修复→重跑 run+verify。
  for (const rem of stage.onFail ?? []) {
    if (rem.match.test(res.output)) {
      ctx.log(`    ${stage.id} 命中修复:${rem.remedy}`);
      await rem.apply(ctx);
      out = (await stage.run(ctx)) ?? { output: "" };
      res = await stage.verify(out.output, ctx);
      if (res.ok) return { id: stage.id, ok: true, note: `修复后通过:${rem.remedy}` };
    }
  }

  // 没命中修复 → 归因(bestOfN)→ 不收敛则升级,不让便宜模型瞎猜。
  if (stage.attribute) {
    const att = await stage.attribute(ctx);
    const r = await resolveOrEscalate(att, { labelOf: (v) => v.label, handler: escalate });
    return { id: stage.id, ok: false, note: `归因=${r.label}${r.escalated ? "(不收敛→升级)" : ""}` };
  }

  // 兜底升级。
  const r = await escalate({ kind: "error", reason: `${stage.id} 验收失败且无匹配修复`, payload: res.output });
  return { id: stage.id, ok: false, note: `升级=${r.decision}` };
}

export async function runSpec<S extends object>(spec: AgentSpec<S>): Promise<LoopResult<S>> {
  return loop<S>({
    name: spec.name,
    state: spec.state,
    statePath: spec.statePath,
    intervalMs: spec.intervalMs ?? 1000,
    maxTicks: spec.maxTicks,
    tick: async ({ state, log }) => {
      const signal = await spec.detect(state);
      if (signal === null) return { done: true, reason: "没有更多工作" };
      if (!spec.isNew(signal, state)) {
        log(`  ${signal} 非新信号 → 跳过`);
        return;
      }
      log(`  处理 ${signal}`);
      const results: StageResult[] = [];
      for (const stage of spec.stages) {
        const r = await runStage(stage, { signal, state, log }, spec.escalate);
        log(`    [${stage.id}] ${r.ok ? "✓" : "✗"} ${r.note}`);
        results.push(r);
        if (!r.ok && stage.required) {
          log(`  必需阶段 ${stage.id} 失败 → 中止本 tick`);
          break;
        }
      }
      spec.record(signal, state, results);
    },
  });
}
