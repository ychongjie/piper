// YAML loader:严格校验(封闭词汇)后,编译成 AgentDef(和 TS builder 同一窄腰)。
// 未知键/错类型 → AgentSchemaError(在 validateAgentYaml 里)。
import { parse } from "yaml";
import type { AgentDef, GoalDef, GuardDef, SignalKind, StepDef, VerifyDef } from "./agent.ts";
import { validateAgentYaml } from "./agent-schema.ts";

export function loadAgentYaml(text: string): AgentDef {
  const d: any = parse(text);
  validateAgentYaml(d); // 封闭词汇:未知键即报错

  const doNode = d.loop.do;
  return {
    name: d.agent,
    distilledFrom: d.distilled_from ? { sessions: d.distilled_from.sessions, skills: d.distilled_from.skills } : undefined,
    forbidRuntimeDeps: d.forbid_runtime_deps,
    loop: {
      on: String(d.loop.on),
      signal: d.loop.signal as SignalKind | undefined,
      every: d.loop.every ? String(d.loop.every) : undefined,
      do: parseDo(doNode),
    },
    guard: parseGuard(d.guard),
  };
}

function parseDo(doNode: any): GoalDef {
  return {
    nl: String(doNode.goal),
    using: doNode.using,
    model: doNode.model ? String(doNode.model) : undefined,
    steps: Array.isArray(doNode.steps) ? doNode.steps.map(parseStep) : undefined,
    verify: parseVerify(doNode.verify),
  };
}

function parseStep(s: any): StepDef {
  return {
    id: String(s.id),
    nl: String(s.nl),
    using: s.using,
    model: s.model ? String(s.model) : undefined,
    cwd: s.cwd ? String(s.cwd) : undefined,
    danger: s.danger === undefined ? null : s.danger,
    selfContained: s.self_contained,
    verify: s.verify ? String(s.verify) : undefined,
  };
}

function parseVerify(v: any): VerifyDef {
  if (v?.panel) {
    const p = v.panel;
    return { panel: { n: p.n, judge: String(p.judge), ground: p.ground, labels: p.labels, escalateIf: p.escalate_if } };
  }
  return { check: String(v.check) };
}

function parseGuard(g: any): GuardDef | undefined {
  if (!g) return undefined;
  return {
    owns: g.owns ? String(g.owns) : undefined,
    budget: g.budget,
    rules: Array.isArray(g.rules) ? g.rules.map((r: any) => ({ when: String(r.when), require: String(r.require) })) : undefined,
  };
}
