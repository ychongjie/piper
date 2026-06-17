// YAML loader:把声明式 agent YAML 编译成 AgentDef(和 TS builder 等价,同一个窄腰)。
import { parse } from "yaml";
import type { AgentDef, VerifyDef } from "./agent.ts";

export function loadAgentYaml(text: string): AgentDef {
  const d: any = parse(text);
  if (!d?.agent || !d?.loop?.do) throw new Error("YAML 缺 agent / loop.do");
  const doNode = d.loop.do;
  return {
    name: d.agent,
    distilledFrom: d.distilled_from
      ? { sessions: d.distilled_from.sessions, skills: d.distilled_from.skills }
      : undefined,
    loop: {
      on: String(d.loop.on),
      every: d.loop.every ? String(d.loop.every) : undefined,
      do: { nl: String(doNode.goal), using: doNode.using, verify: parseVerify(doNode.verify) },
    },
    guard: Array.isArray(d.guard) ? d.guard.map((g: any) => ({ when: String(g.when), require: String(g.require) })) : undefined,
  };
}

function parseVerify(v: any): VerifyDef {
  if (v?.panel) {
    const p = v.panel;
    return { panel: { n: p.n, judge: String(p.judge), ground: p.ground, labels: p.labels, escalateIf: p.escalate_if } };
  }
  if (typeof v?.check === "string") return { check: v.check };
  throw new Error("verify 必须是 panel 或 check");
}
