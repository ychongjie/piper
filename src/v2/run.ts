// v2 运行入口:load YAML → 跑一个 tick(可选先跑触发器,再跑 do 树)。
import { parse } from "yaml";
import { type Node, type NodeResult, type RunCtx, runNode } from "./engine.ts";

export interface AgentV2 {
  name: string;
  loop: { on: string; every?: string; do: Node };
}

export function loadAgentV2(text: string): AgentV2 {
  const d: any = parse(text);
  if (!d?.agent || !d?.loop?.do) throw new Error("v2 YAML 缺 agent / loop.do");
  return { name: String(d.agent), loop: { on: String(d.loop.on), every: d.loop.every, do: d.loop.do } };
}

export async function runOnce(
  a: AgentV2,
  opts: { cwd?: string; toolsDir?: string; onLog?: (m: string) => void; runTrigger?: boolean },
): Promise<NodeResult> {
  const onLog = opts.onLog ?? (() => {});
  const mkCtx = (): RunCtx => ({ cwd: opts.cwd, toolsDir: opts.toolsDir, onLog, prior: null, history: [] });

  if (opts.runTrigger) {
    onLog(`[${a.name}] 触发器……`);
    const sig = await runNode(a.loop.on, mkCtx());
    onLog(`[${a.name}] 构建信号 = ${sig.result.trim().slice(0, 48)}`);
  }
  onLog(`[${a.name}] 跑 do……`);
  return runNode(a.loop.do, mkCtx());
}
