// YAML loader 单测:严格校验(封闭词汇)+ 解析。纯解析,不打网络。跑:bun test
import { expect, test } from "bun:test";
import { AgentSchemaError } from "./agent-schema.ts";
import { loadAgentYaml } from "./yaml.ts";

const FULL = `
agent: t
loop:
  on: 查最新 commit sha
  every: 30m
  do:
    goal: 跑测
    using: [sk1]
    model: deepseek-v4-pro
    steps:
      - id: reconcile
        nl: 确保环境
        danger: 建本 agent 专用环境
        self_contained: false
        verify: PLATFORM_ENV_ID=\\d+
      - id: run-test
        nl: 跑 api-test
        model: fast-cheap
    judge:
      ask: 判一下;分歧则升级
      labels: [真回归, 测试bug]
      ground: [取证1, 取证2]
guard:
  owns: piper-watchdog
  budget: 2
`;

test("解析完整 agent(loop/every/steps/judge/guard)", () => {
  const a = loadAgentYaml(FULL);
  expect(a.name).toBe("t");
  expect(a.loop.every).toBe("30m");
  expect(a.loop.do.nl).toBe("跑测");
  expect(a.loop.do.model).toBe("deepseek-v4-pro"); // do 默认模型
  expect(a.loop.do.steps?.length).toBe(2);
  expect(a.loop.do.steps?.[0]).toMatchObject({ id: "reconcile", danger: "建本 agent 专用环境", selfContained: false, verify: "PLATFORM_ENV_ID=\\d+" });
  expect(a.loop.do.steps?.[1].danger).toBe(null); // 缺省 danger = null
  expect(a.loop.do.steps?.[1].model).toBe("fast-cheap"); // step 覆盖模型
  expect(a.loop.do.judge?.ask).toBe("判一下;分歧则升级");
  expect(a.loop.do.judge?.ground).toEqual(["取证1", "取证2"]);
  expect(a.guard?.owns).toBe("piper-watchdog");
  expect(a.guard?.budget).toBe(2);
});

test("judge 可缺省(只靠 step verify 的机械门)", () => {
  const a = loadAgentYaml("agent: t\nloop:\n  on: x\n  do:\n    goal: g\n    steps:\n      - id: a\n        nl: do a\n        verify: ok");
  expect(a.loop.do.judge).toBeUndefined();
  expect(a.loop.do.steps?.[0].verify).toBe("ok");
});

test("缺 loop.do → 抛错", () => {
  expect(() => loadAgentYaml("agent: t")).toThrow();
});

// ── 封闭词汇:防"写 YAML 时随便新增关键字" ──
test("未知顶层键 → 拒绝", () => {
  expect(() => loadAgentYaml("agent: t\nfrobnicate: 1\nloop:\n  on: x\n  do:\n    goal: g")).toThrow(AgentSchemaError);
});

test("step 里未知键 → 拒绝(项目专属语义只能进 nl)", () => {
  const y = "agent: t\nloop:\n  on: x\n  do:\n    goal: g\n    steps:\n      - id: a\n        nl: do a\n        provision_topology: piper-watchdog";
  expect(() => loadAgentYaml(y)).toThrow(AgentSchemaError);
});

test("废弃关键字 signal → 拒绝(已移除,去重=stdout 全等)", () => {
  expect(() => loadAgentYaml("agent: t\nloop:\n  on: x\n  signal: commit-sha\n  do:\n    goal: g")).toThrow(AgentSchemaError);
});
