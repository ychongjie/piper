// escalate:升级。两类——
//  1. 授权边界(authorization):危险写操作(删 baseline / 动 license)即便模型有把握也必须问人。
//     这是【治理决定,非能力决定】。机制走 pi 的 beforeToolCall 闸,策略(什么算危险)在这里配。
//  2. 收敛兜底(no-converge):bestOfN 没过半多数 → 升级给人/强模型,不让便宜模型瞎猜。
// 升级【通道】可换:交互式问 stdin / 无人值守安全默认 / 记录到磁盘待办。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { BestOfNResult } from "./ttc.ts";

export type EscalationKind = "authorization" | "no-converge" | "low-confidence" | "error";

export interface Escalation {
  kind: EscalationKind;
  reason: string;
  options?: string[]; // 可选项(默认 approve/deny)
  payload?: unknown;
}

export interface EscalationResolution {
  decision: string;
  resolvedBy: "human" | "default";
  note?: string;
}

export type EscalationHandler = (e: Escalation) => Promise<EscalationResolution>;

/** 交互式:打印升级 + 读 stdin。给人在场时用。 */
export function consoleEscalation(): EscalationHandler {
  return (e) =>
    new Promise((resolve) => {
      const options = e.options ?? ["approve", "deny"];
      process.stderr.write(`\n⚠ 升级[${e.kind}]:${e.reason}\n选项:${options.join(" / ")}\n> `);
      const rl = createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        rl.close();
        const pick = options.find((o) => o === line.trim()) ?? options[options.length - 1];
        resolve({ decision: pick, resolvedBy: "human" });
      });
    });
}

/** 无人值守(cron/CI):安全默认。授权→deny;判断类→uncertain。可选记录到磁盘待人处理。 */
export function denyByDefault(dir?: string): EscalationHandler {
  let seq = 0;
  return async (e) => {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `escalation-${e.kind}-${(seq += 1)}.json`), JSON.stringify(e, null, 2));
    }
    return {
      decision: e.kind === "authorization" ? "deny" : "uncertain",
      resolvedBy: "default",
      note: "无人值守,采用安全默认(授权拒绝 / 判断标记 uncertain)",
    };
  };
}

/** 授权闸:返回 pi 的 beforeToolCall 钩子。命中危险操作 → 升级问人,非 approve 则 block。 */
export function authorizationGate(opts: {
  isDangerous: (toolCall: { name: string; arguments?: any }) => string | null; // 危险描述或 null
  handler: EscalationHandler;
}) {
  return async ({ toolCall }: { toolCall: { name: string; arguments?: any } }) => {
    const danger = opts.isDangerous(toolCall);
    if (!danger) return undefined; // 安全操作放行
    const res = await opts.handler({
      kind: "authorization",
      reason: danger,
      options: ["approve", "deny"],
      payload: toolCall,
    });
    if (res.decision === "approve") return undefined;
    return { block: true, reason: `授权被拒(${res.resolvedBy}):${danger}` };
  };
}

/**
 * 自管资源闸:agent 管【自己专用】的资源(如它的专用环境)是本职 —— 预算内自动放行;
 * 超预算、或碰【别人的】资源 → 走 fallback(升级给人)。这是"全自动 + 专用环境"该有的校准:
 * 不是所有共享写都问人,而是"自己的 + 在预算内 → 自动;别人的 / 超预算 → 升级"。
 */
export function selfManagedGate(opts: {
  owns: (reason: string) => boolean; // 这次授权请求是不是"动本 agent 自管的资源"
  budget?: { max: number; used: { n: number } }; // 自管写操作的预算(如一天最多重建 N 次)
  fallback: EscalationHandler; // 非自管 / 超预算 → 升级
}): EscalationHandler {
  return async (e) => {
    if (e.kind === "authorization" && opts.owns(e.reason)) {
      if (opts.budget && opts.budget.used.n >= opts.budget.max) {
        return opts.fallback({ ...e, reason: `超预算(${opts.budget.max} 次):${e.reason}` });
      }
      if (opts.budget) opts.budget.used.n += 1;
      return { decision: "approve", resolvedBy: "default", note: "自管专用资源,预算内自动放行" };
    }
    return opts.fallback(e);
  };
}

/**
 * 收敛兜底:
 *  - 收敛到普通标签 → 直接用 winner;
 *  - 收敛到 escalateLabels 里的标签(如 out_of_scope,本就不可自动处理)→ 升级通知,但保留模型判断;
 *  - 不收敛 → 升级裁决。
 */
export async function resolveOrEscalate<V>(
  r: BestOfNResult<V>,
  opts: { labelOf: (v: V) => string; handler: EscalationHandler; escalateLabels?: string[] },
): Promise<{ label: string; escalated: boolean; resolution?: EscalationResolution }> {
  const winnerLabel = r.winner ? opts.labelOf(r.winner) : undefined;
  const mustEscalate = winnerLabel != null && (opts.escalateLabels ?? []).includes(winnerLabel);

  if (r.converged && r.winner && !mustEscalate) {
    return { label: winnerLabel as string, escalated: false };
  }

  if (mustEscalate && r.converged) {
    // 收敛到一个"必升级"标签:不是判错,而是这类(版本错位/基础设施)本就要人接手。
    const res = await opts.handler({
      kind: "low-confidence",
      reason: `归因=${winnerLabel}:非产品回归/测试bug/flake(如被测构建版本错位、基础设施问题),需人工处理`,
      options: [winnerLabel as string],
      payload: r.samples,
    });
    return { label: winnerLabel as string, escalated: true, resolution: res };
  }

  // 不收敛:升级裁决。
  const res = await opts.handler({
    kind: "no-converge",
    reason: `bestOfN 未收敛(票数 ${JSON.stringify(r.tally)}),不让便宜模型瞎猜,升级裁决`,
    options: Object.keys(r.tally).length ? Object.keys(r.tally) : ["uncertain"],
    payload: r.samples,
  });
  return { label: res.decision, escalated: true, resolution: res };
}
