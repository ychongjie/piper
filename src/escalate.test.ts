// escalate 单测(授权闸 + 收敛兜底),mock handler,不打网络。跑:bun test
import { expect, test } from "bun:test";
import { authorizationGate, denyByDefault, resolveOrEscalate } from "./escalate.ts";
import type { BestOfNResult } from "./ttc.ts";

const approve = async () => ({ decision: "approve", resolvedBy: "human" as const });
const deny = async () => ({ decision: "deny", resolvedBy: "human" as const });
const isDanger = (tc: { name: string }) => (tc.name === "bash" ? "可能动共享资源" : null);

test("授权闸:安全操作放行", async () => {
  const gate = authorizationGate({ isDangerous: isDanger, handler: deny });
  expect(await gate({ toolCall: { name: "read" } })).toBeUndefined();
});

test("授权闸:危险操作 + 批准 → 放行", async () => {
  const gate = authorizationGate({ isDangerous: isDanger, handler: approve });
  expect(await gate({ toolCall: { name: "bash" } })).toBeUndefined();
});

test("授权闸:危险操作 + 拒绝 → block", async () => {
  const gate = authorizationGate({ isDangerous: isDanger, handler: deny });
  const r = await gate({ toolCall: { name: "bash" } });
  expect(r?.block).toBe(true);
});

test("收敛兜底:收敛 → 直接用 winner,不升级", async () => {
  const conv: BestOfNResult<{ label: string }> = {
    winner: { label: "test_bug" }, tally: { test_bug: 3 }, converged: true, samples: [],
  };
  let escalated = false;
  const r = await resolveOrEscalate(conv, {
    labelOf: (v) => v.label,
    handler: async () => { escalated = true; return { decision: "x", resolvedBy: "default" }; },
  });
  expect(r.label).toBe("test_bug");
  expect(r.escalated).toBe(false);
  expect(escalated).toBe(false);
});

test("收敛兜底:不收敛 → 升级,用升级决定", async () => {
  const split: BestOfNResult<{ label: string }> = {
    winner: { label: "regression" }, tally: { regression: 1, test_bug: 1, flake: 1 }, converged: false, samples: [],
  };
  const r = await resolveOrEscalate(split, { labelOf: (v) => v.label, handler: deny });
  expect(r.escalated).toBe(true);
  expect(r.label).toBe("deny");
});

test("收敛到 escalateLabels 标签(out_of_scope)→ 仍升级,保留标签", async () => {
  const conv: BestOfNResult<{ label: string }> = {
    winner: { label: "out_of_scope" }, tally: { out_of_scope: 3 }, converged: true, samples: [],
  };
  let escalated = false;
  const r = await resolveOrEscalate(conv, {
    labelOf: (v) => v.label,
    handler: async () => { escalated = true; return { decision: "out_of_scope", resolvedBy: "default" }; },
    escalateLabels: ["out_of_scope"],
  });
  expect(r.escalated).toBe(true);
  expect(r.label).toBe("out_of_scope"); // 保留模型判断,不覆盖成 uncertain
  expect(escalated).toBe(true);
});

test("收敛到普通标签 + 配了 escalateLabels → 不升级", async () => {
  const conv: BestOfNResult<{ label: string }> = {
    winner: { label: "test_bug" }, tally: { test_bug: 3 }, converged: true, samples: [],
  };
  const r = await resolveOrEscalate(conv, {
    labelOf: (v) => v.label, handler: deny, escalateLabels: ["out_of_scope"],
  });
  expect(r.escalated).toBe(false);
  expect(r.label).toBe("test_bug");
});

test("denyByDefault:授权→deny,判断类→uncertain", async () => {
  const h = denyByDefault();
  expect((await h({ kind: "authorization", reason: "x" })).decision).toBe("deny");
  expect((await h({ kind: "no-converge", reason: "x" })).decision).toBe("uncertain");
});
