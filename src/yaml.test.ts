// YAML loader 单测:纯解析,不打网络。跑:bun test
import { expect, test } from "bun:test";
import { loadAgentYaml } from "./yaml.ts";

const FULL = `
agent: t
distilled_from: { sessions: [s1, s2], skills: [sk1] }
loop:
  on: 有新构建
  every: 30m
  do:
    goal: 跑测
    using: [sk1]
    verify:
      panel:
        n: 3
        judge: 判一下
        labels: [真回归, 测试bug]
        ground: [取证1, 取证2]
        escalate_if: 分歧
guard:
  - when: 删环境
    require: 人批
`;

test("解析完整 agent(loop/goal/panel/guard/溯源)", () => {
  const a = loadAgentYaml(FULL);
  expect(a.name).toBe("t");
  expect(a.distilledFrom?.sessions).toEqual(["s1", "s2"]);
  expect(a.loop.on).toBe("有新构建");
  expect(a.loop.every).toBe("30m");
  expect(a.loop.do.nl).toBe("跑测");
  expect(a.loop.do.using).toEqual(["sk1"]);
  const v = a.loop.do.verify as any;
  expect(v.panel.n).toBe(3);
  expect(v.panel.ground).toEqual(["取证1", "取证2"]);
  expect(v.panel.labels).toEqual(["真回归", "测试bug"]);
  expect(v.panel.escalateIf).toBe("分歧");
  expect(a.guard?.[0]).toEqual({ when: "删环境", require: "人批" });
});

test("verify 的 check 变体", () => {
  const a = loadAgentYaml("agent: t\nloop:\n  on: x\n  do:\n    goal: g\n    verify: { check: 失败数为0 }");
  expect((a.loop.do.verify as any).check).toBe("失败数为0");
});

test("缺 loop.do → 抛错", () => {
  expect(() => loadAgentYaml("agent: t")).toThrow();
});
