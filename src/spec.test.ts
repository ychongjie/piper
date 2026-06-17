// spec 引擎单测:修复表重跑、归因不收敛升级、授权拒绝。合成动作,不打网络。跑:bun test
import { expect, test } from "bun:test";
import { denyByDefault } from "./escalate.ts";
import { type AgentSpec, runSpec } from "./spec.ts";

interface S {
  done: boolean;
  rec: string[];
}

function oneShotSpec(stages: AgentSpec<S>["stages"]): AgentSpec<S> {
  return {
    name: "t",
    state: { done: false, rec: [] },
    intervalMs: 0,
    maxTicks: 3,
    escalate: denyByDefault(),
    detect: async (s) => (s.done ? null : "sig1"),
    isNew: () => true,
    record: (_sig, s, r) => {
      s.done = true;
      s.rec = r.map((x) => `${x.id}:${x.ok ? "ok" : x.note}`);
    },
    stages,
  };
}

test("修复表命中 → 重跑通过", async () => {
  let fixed = false;
  const r = await runSpec(
    oneShotSpec([
      {
        id: "run-api-test",
        run: async () => ({ output: "" }),
        verify: () => ({ ok: fixed, output: fixed ? "失败 0" : "entry-access 收敛慢" }),
        onFail: [{ match: /entry-access/, remedy: "调超时", apply: async () => { fixed = true; } }],
      },
    ]),
  );
  expect(r.state.rec).toEqual(["run-api-test:ok"]);
});

test("没命中修复 + 归因不收敛 → 升级", async () => {
  const r = await runSpec(
    oneShotSpec([
      {
        id: "triage",
        run: async () => ({ output: "残留失败" }),
        verify: () => ({ ok: false, output: "残留失败" }),
        attribute: async () => ({
          winner: { label: "regression" },
          tally: { regression: 1, test_bug: 1, flake: 1 },
          converged: false,
          samples: [],
        }),
      },
    ]),
  );
  expect(r.state.rec[0]).toContain("triage");
  expect(r.state.rec[0]).toContain("uncertain"); // denyByDefault 把 no-converge 兜成 uncertain
});

test("授权闸:共享写被拒", async () => {
  const r = await runSpec(
    oneShotSpec([
      { id: "teardown", authorize: () => "共享写", run: async () => ({ output: "done" }) },
    ]),
  );
  expect(r.state.rec[0]).toContain("授权被拒");
});
