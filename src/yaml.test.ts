// YAML loader 单测:严格校验(封闭词汇)+ 解析。纯解析,不打网络。跑:bun test
import { expect, test } from "bun:test";
import { AgentSchemaError } from "./agent-schema.ts";
import { loadAgentYaml } from "./yaml.ts";

const FULL = `
agent: t
distilled_from: { sessions: [s1, s2], skills: [sk1] }
loop:
  on: 查最新 commit sha
  signal: commit-sha
  every: 30m
  do:
    goal: 跑测
    using: [sk1]
    steps:
      - id: reconcile
        nl: 确保环境
        danger: 建本 agent 专用环境
        self_contained: false
        verify: PLATFORM_ENV_ID=\\d+
      - id: run-test
        nl: 跑 api-test
    verify:
      panel:
        n: 3
        judge: 判一下
        labels: [真回归, 测试bug]
        ground: [取证1, 取证2]
        escalate_if: 分歧
guard:
  owns: piper-watchdog
  budget: 2
`;

test("解析完整 agent(loop/signal/steps/panel/guard/溯源)", () => {
  const a = loadAgentYaml(FULL);
  expect(a.name).toBe("t");
  expect(a.distilledFrom?.sessions).toEqual(["s1", "s2"]);
  expect(a.loop.signal).toBe("commit-sha");
  expect(a.loop.do.nl).toBe("跑测");
  expect(a.loop.do.steps?.length).toBe(2);
  expect(a.loop.do.steps?.[0]).toMatchObject({ id: "reconcile", danger: "建本 agent 专用环境", selfContained: false, verify: "PLATFORM_ENV_ID=\\d+" });
  expect(a.loop.do.steps?.[1].danger).toBe(null); // 缺省 danger = null
  const v = a.loop.do.verify as any;
  expect(v.panel.n).toBe(3);
  expect(v.panel.escalateIf).toBe("分歧");
  expect(a.guard?.owns).toBe("piper-watchdog");
  expect(a.guard?.budget).toBe(2);
});

test("verify 的 check 变体", () => {
  const a = loadAgentYaml("agent: t\nloop:\n  on: x\n  do:\n    goal: g\n    verify: { check: 失败数为0 }");
  expect((a.loop.do.verify as any).check).toBe("失败数为0");
});

test("缺 loop.do → 抛错", () => {
  expect(() => loadAgentYaml("agent: t")).toThrow();
});

// ── 封闭词汇:防"写 YAML 时随便新增关键字" ──
test("未知顶层键 → 拒绝", () => {
  expect(() => loadAgentYaml("agent: t\nfrobnicate: 1\nloop:\n  on: x\n  do:\n    goal: g\n    verify: { check: c }")).toThrow(AgentSchemaError);
});

test("step 里未知键 → 拒绝(项目专属语义只能进 nl)", () => {
  const y =
    "agent: t\nloop:\n  on: x\n  do:\n    goal: g\n    steps:\n      - id: a\n        nl: do a\n        provision_topology: piper-watchdog\n    verify: { check: c }";
  expect(() => loadAgentYaml(y)).toThrow(AgentSchemaError);
});

test("signal 非枚举值 → 拒绝", () => {
  expect(() => loadAgentYaml("agent: t\nloop:\n  on: x\n  signal: whatever\n  do:\n    goal: g\n    verify: { check: c }")).toThrow(AgentSchemaError);
});
