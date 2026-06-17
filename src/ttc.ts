// test-time compute 原语:用便宜模型 + 多次推理 + 接地验证逼近强模型单次。
// 这是 pi 不做、Piper 独有的那一层(pi 是单 agent;这里编排多 agent + 投票/对抗)。
//
// - structuredWorker:一个 worker,只能用给定的"验证器工具"取证,最后调 capture 工具提交结构化结论。
//   不给 read/bash 等内置工具 → 强制它靠验证器接地,不能凭空乱来。
// - bestOfN:同一问题并发跑 N 份,按 key 投票 + 收敛检验(发散即"该升级"信号)。
// - debate:控方 / 辩方各自取证,仲裁者复核裁决(对抗验证,比裸投票更抗偏见)。

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { type WorkerEvent, subscribeWorkerEvents } from "./goal.ts";
import { getBackend } from "./session.ts";

export interface StructuredWorkerOpts {
  prompt: string;
  tools: ReturnType<typeof defineTool>[]; // 验证器工具
  captureName: string; // 提交结论的工具名
  captureDescription: string;
  captureSchema: TSchema; // 结论的形状
  onWorkerEvent?: (e: WorkerEvent) => void;
}

/** 跑一个 worker:用验证器工具取证 → 调 capture 工具提交结构化结论。返回结论(没提交则 null)。 */
export async function structuredWorker<T>(o: StructuredWorkerOpts): Promise<T | null> {
  let captured: T | null = null;
  const capture = defineTool({
    name: o.captureName,
    label: "提交结论",
    description: o.captureDescription,
    parameters: o.captureSchema as any,
    execute: async (_id: string, params: any) => {
      captured = params as T;
      return { content: [{ type: "text", text: "已记录结论,可以结束。" }], details: {}, terminate: true };
    },
  });
  const allTools = [...o.tools, capture];
  const { session } = await getBackend()({
    tools: allTools.map((t) => t.name), // 只给验证器 + capture,不给内置工具
    customTools: allTools,
  });
  if (o.onWorkerEvent) subscribeWorkerEvents(session, o.onWorkerEvent);
  await session.prompt(o.prompt);
  return captured;
}

export interface BestOfNResult<V> {
  winner: V | null; // 得票最多的样本
  tally: Record<string, number>; // 各 key 的票数
  converged: boolean; // 是否有过半多数(否则=该升级的信号)
  samples: V[]; // 所有非空样本
}

/** 并发跑 N 份,按 keyOf 投票。收敛=存在过半多数。 */
export async function bestOfN<V>(
  n: number,
  run: (i: number) => Promise<V | null>,
  keyOf: (v: V) => string,
): Promise<BestOfNResult<V>> {
  const raw = await Promise.all(Array.from({ length: n }, (_, i) => run(i).catch(() => null)));
  const samples = raw.filter((v): v is V => v != null);
  const tally: Record<string, number> = {};
  for (const v of samples) {
    const k = keyOf(v);
    tally[k] = (tally[k] ?? 0) + 1;
  }
  let winner: V | null = null;
  let best = 0;
  for (const v of samples) {
    const c = tally[keyOf(v)];
    if (c > best) {
      best = c;
      winner = v;
    }
  }
  const converged = winner != null && best > samples.length / 2;
  return { winner, tally, converged, samples };
}

export interface DebateResult<V> {
  pro: V | null; // 控方结论
  def: V | null; // 辩方结论
  verdict: V | null; // 仲裁结论
}

/** 对抗验证:控方/辩方并发取证,仲裁者复核裁决。 */
export async function debate<V>(o: {
  prosecute: () => Promise<V | null>;
  defend: () => Promise<V | null>;
  arbitrate: (pro: V | null, def: V | null) => Promise<V | null>;
}): Promise<DebateResult<V>> {
  const [pro, def] = await Promise.all([o.prosecute(), o.defend()]);
  const verdict = await o.arbitrate(pro, def);
  return { pro, def, verdict };
}
