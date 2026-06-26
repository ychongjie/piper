// panel 单测:mock 后端(prompt 时直接调 capture 工具喂预设结论),不打网络。跑:bun test
import { expect, test } from "bun:test";
import { denyByDefault } from "./escalate.ts";
import { panel } from "./panel.ts";
import { setBackendOverride } from "./session.ts";

// 假后端:structuredWorker 把 capture 工具追加在 customTools 末尾;prompt 时直接调它喂预设 payload。
function mockBackend(payloads: any[]) {
  let i = 0;
  setBackendOverride(async (opts: any) => {
    const tools = opts?.customTools ?? [];
    const capture = tools[tools.length - 1];
    return {
      session: {
        subscribe: () => () => {},
        prompt: async () => {
          if (capture) await capture.execute("c", payloads[Math.min(i++, payloads.length - 1)]);
        },
      },
    } as any;
  });
}

const v = (label: string) => ({ label, confidence: "high", evidence: ["接地证据"] });

test("三判官一致 → 收敛,不升级", async () => {
  mockBackend([v("测试bug"), v("测试bug"), v("测试bug")]);
  const r = await panel({ n: 3, judge: "判一下", groundNl: [] }, denyByDefault());
  expect(r.verdict).toBe("测试bug");
  expect(r.escalated).toBe(false);
  expect(r.tally).toEqual({ 测试bug: 3 });
});

test("三方分歧 → 不收敛,升级", async () => {
  mockBackend([v("真回归"), v("测试bug"), v("flake")]);
  const r = await panel({ n: 3, judge: "判一下", groundNl: [] }, denyByDefault());
  expect(r.escalated).toBe(true);
});

test("收敛到 escalateLabels(版本错位)→ 仍升级,保留标签", async () => {
  mockBackend([v("版本错位"), v("版本错位"), v("版本错位")]);
  const r = await panel({ n: 3, judge: "判一下", groundNl: [], escalateLabels: ["版本错位"] }, denyByDefault());
  expect(r.verdict).toBe("版本错位");
  expect(r.escalated).toBe(true);
});
