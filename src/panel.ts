// panel:一组【独立】判官做主观判断(执行者≠判官)。N 个 agent 各自用 ground 工具取证、
// 提交结构化结论,按 label 投票收敛;不收敛 / 命中升级标签 → escalate。这是"活的判断"原语
// (不固化)。debate 是它的对抗变体。把验证过的 attributeBestOfN+接地+收敛升级抽成通用件。

import type { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type EscalationHandler, resolveOrEscalate } from "./escalate.ts";
import type { WorkerEvent } from "./goal.ts";
import { bestOfN, structuredWorker } from "./ttc.ts";

export interface Verdict {
  label: string;
  confidence: "high" | "low";
  evidence: string[]; // 每条引用某 ground 工具的输出(接地)
}

export interface PanelResult {
  verdict: string; // 收敛标签 / 升级裁决
  escalated: boolean;
  samples: Verdict[];
  tally: Record<string, number>;
}

export interface PanelOpts {
  n: number;
  judge: string; // 判官 prompt(NL)
  ground: ReturnType<typeof defineTool>[]; // 取证工具(各自可固化)
  labels?: string[]; // 允许的标签(默认从 judge 文本里靠模型自取)
  escalateLabels?: string[]; // 收敛到这些也必升级(如 版本错位 / out_of_scope)
  onWorkerEvent?: (e: WorkerEvent) => void;
}

function verdictSchema(labels?: string[]) {
  const label =
    labels && labels.length
      ? Type.Union(labels.map((l) => Type.Literal(l)) as any, { description: "结论标签" })
      : Type.String({ description: "结论标签" });
  return Type.Object({
    label,
    confidence: Type.Union([Type.Literal("high"), Type.Literal("low")]),
    evidence: Type.Array(Type.String(), { description: "每条必须引用某取证工具的实际输出" }),
  });
}

function panelPrompt(judge: string, ground: { name: string }[]): string {
  return [
    "你是一名【独立判官】,对下面的情况做判断。",
    judge,
    "",
    `可用取证工具:${ground.map((g) => g.name).join("、")}。`,
    "硬性规则:",
    "1. 必须先调用取证工具,严禁在没调用任何工具的情况下下结论;",
    "2. evidence 每条都要引用某工具的实际输出(接地,不许编造);",
    "3. 判不进给定类别 / 证据指向被测对象或环境本身的问题时,如标签集允许就选最贴切的'超范围'类,别硬塞;",
    "4. 调查清楚后调用 submit_verdict 提交 {label, confidence, evidence}。",
  ].join("\n");
}

/** 跑一组独立判官:N 路并发、各自接地取证、投票收敛,不收敛/命中升级标签 → escalate。 */
export async function panel(opts: PanelOpts, escalate: EscalationHandler): Promise<PanelResult> {
  const schema = verdictSchema(opts.labels);
  const prompt = panelPrompt(opts.judge, opts.ground);

  const r = await bestOfN<Verdict>(
    opts.n,
    () =>
      structuredWorker<Verdict>({
        prompt,
        tools: opts.ground,
        captureName: "submit_verdict",
        captureDescription: "提交结论 {label, confidence, evidence}",
        captureSchema: schema,
        onWorkerEvent: opts.onWorkerEvent,
      }),
    (v) => v.label,
  );

  const resolved = await resolveOrEscalate(r, {
    labelOf: (v) => v.label,
    handler: escalate,
    escalateLabels: opts.escalateLabels,
  });

  return { verdict: resolved.label, escalated: resolved.escalated, samples: r.samples, tally: r.tally };
}
