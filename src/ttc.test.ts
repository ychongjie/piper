// bestOfN 聚合逻辑单测(投票/收敛/过滤),纯合成样本,不打网络。跑:bun test
import { expect, test } from "bun:test";
import { bestOfN } from "./ttc.ts";

const runner = (labels: (string | null)[]) => {
  let i = 0;
  return async () => {
    const l = labels[i++];
    return l == null ? null : { label: l };
  };
};

test("过半多数 → 收敛,winner 是多数", async () => {
  const r = await bestOfN(3, runner(["regression", "regression", "test_bug"]), (v: any) => v.label);
  expect(r.winner?.label).toBe("regression");
  expect(r.tally).toEqual({ regression: 2, test_bug: 1 });
  expect(r.converged).toBe(true);
  expect(r.samples.length).toBe(3);
});

test("三方分歧、无过半 → 不收敛(=该升级信号)", async () => {
  const r = await bestOfN(3, runner(["regression", "test_bug", "flake"]), (v: any) => v.label);
  expect(r.converged).toBe(false);
});

test("null 样本被过滤,不计票", async () => {
  const r = await bestOfN(3, runner(["x", null, "x"]), (v: any) => v.label);
  expect(r.samples.length).toBe(2);
  expect(r.winner?.label).toBe("x");
  expect(r.converged).toBe(true); // 2 > 2/2
});
