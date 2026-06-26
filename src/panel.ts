// panel:一组【独立】判官做主观判断(执行者≠判官)。N 个 agent 各自【在自己的上下文里活取证】
// (只读 read/bash,scoped cwd,ground 是取证指引)、提交结构化结论,按 label 投票收敛;
// 不收敛 / 命中升级标签 → escalate。这是"活的判断"原语(不固化)。debate 是它的对抗变体。
//
// 为什么取证不拆成独立子 agent:归因要带着完整案情边探边判,拆出去会有有损的上下文交接
// (判官→调查员压成一句 query,调查员→判官只回压缩 findings),恰好砍在最需要全上下文的环节。

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
  groundNl: string[]; // 取证手段(NL,进判官提示词;判官用只读 read/bash 自己去查)
  cwd?: string; // 判官只读取证的工作目录
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

function panelPrompt(judge: string, groundNl: string[]): string {
  return [
    "你是一名【独立判官】,对下面的情况做判断。",
    judge,
    "",
    "你有 read / bash 两个工具,可在当前目录【自己动手活取证】。建议的取证手段:",
    ...groundNl.map((g, i) => `  ${i + 1}. ${g}`),
    "",
    "【只读纪律】只许查、不许改:不准 edit/write/删改文件,不准重启/部署/删环境,",
    "ssh 进测试环境也只跑只读命令(看日志/进程/配置/回源);任何会改变状态的操作一律禁止。",
    "硬性规则:",
    "1. 必须先用工具实地取证,严禁在没跑任何工具的情况下下结论;",
    "2. evidence 每条都要引用某次工具调用的【实际输出】(接地,不许编造);",
    "3. 判不进给定类别 / 证据指向被测对象或环境本身的问题时,如标签集允许就选最贴切的'超范围'类,别硬塞;",
    "4. 调查清楚后调用 submit_verdict 提交 {label, confidence, evidence}。",
  ].join("\n");
}

/** 跑一组独立判官:N 路并发、各自接地取证、投票收敛,不收敛/命中升级标签 → escalate。 */
export async function panel(opts: PanelOpts, escalate: EscalationHandler): Promise<PanelResult> {
  const schema = verdictSchema(opts.labels);
  const prompt = panelPrompt(opts.judge, opts.groundNl);

  const r = await bestOfN<Verdict>(
    opts.n,
    () =>
      structuredWorker<Verdict>({
        prompt,
        tools: [], // 不再注入项目侧取证工具;判官用内置只读 read/bash 自己取证
        builtinTools: ["read", "bash"],
        cwd: opts.cwd,
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
