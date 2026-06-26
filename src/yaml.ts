// YAML loader:严格校验(封闭词汇)后,编译成 AgentDef(和 TS builder 同一窄腰)。
// 未知键/错类型 → AgentSchemaError(在 validateAgentYaml 里)。
import { parse } from "yaml";
import type { AgentDef, GoalDef, GuardDef, JudgeDef, StepDef } from "./agent.ts";
import { validateAgentYaml } from "./agent-schema.ts";

export function loadAgentYaml(text: string): AgentDef {
  const d: any = parse(text);
  validateAgentYaml(d); // 封闭词汇:未知键即报错

  return {
    name: d.agent,
    loop: {
      on: String(d.loop.on),
      every: d.loop.every ? String(d.loop.every) : undefined,
      do: parseDo(d.loop.do),
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
    judge: doNode.judge ? parseJudge(doNode.judge) : undefined,
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

function parseJudge(j: any): JudgeDef {
  return { ask: String(j.ask), ground: j.ground, labels: j.labels };
}

function parseGuard(g: any): GuardDef | undefined {
  if (!g) return undefined;
  return { owns: g.owns ? String(g.owns) : undefined, budget: g.budget };
}
