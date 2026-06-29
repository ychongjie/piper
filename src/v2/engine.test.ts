// v2 引擎单测:mock pi 会话(prompt 时直接调 capture 工具喂预设),不打网络。跑:bun test
import { expect, test } from "bun:test";
import { setBackendOverride } from "../session.ts";
import { type NodeResult, type RunCtx, runNode } from "./engine.ts";

function mock(responder: (toolName: string) => any) {
  setBackendOverride(async (opts: any) => {
    const tools = opts?.customTools ?? [];
    const capture = tools[tools.length - 1];
    return {
      session: { subscribe: () => () => {}, prompt: async () => { if (capture) await capture.execute("c", responder(capture.name)); } },
    } as any;
  });
}
const ctx = (prior: NodeResult | null = null): RunCtx => ({ onLog: () => {}, prior, history: [] });

test("活叶子:submit_result + 机械 verify 过", async () => {
  mock((name) => (name === "submit_result" ? { status: "done", result: "integration: 115 passed / 0 failed" } : {}));
  const r = await runNode({ intent: "跑测", verify: "\\d+\\s*passed", budget: 2 }, ctx());
  expect(r.result).toContain("115 passed");
  expect(r.status).toBe("done");
});

test("判官叶子 → 出 label", async () => {
  mock(() => ({ label: "确定性失败", confidence: "high", evidence: ["复跑确定性复现"] }));
  const r = await runNode({ intent: "分诊", labels: ["测试通过", "flaky", "确定性失败"] }, ctx());
  expect(r.label).toBe("确定性失败");
});

test("fanout vote:多数票胜出", async () => {
  let i = 0;
  const seq = ["真回归", "真回归", "测试bug"];
  mock(() => ({ label: seq[i++ % 3], confidence: "high", evidence: ["e"] }));
  const r = await runNode({ fanout: { over: [{}, {}, {}], gather: { how: "vote", labels: ["真回归", "测试bug"] } } }, ctx());
  expect(r.label).toBe("真回归");
});

test("when ≠ 上一步 label → 跳过整个 fanout", async () => {
  mock(() => ({ label: "x", confidence: "high", evidence: [] }));
  const r = await runNode({ fanout: { when: "确定性失败", over: [{}], gather: { how: "vote", labels: ["x"] } } }, ctx({ label: "测试通过", result: "" }));
  expect(r.status).toBe("skipped");
});

test("when == 上一步 label → 跑", async () => {
  mock(() => ({ label: "真回归", confidence: "high", evidence: ["e"] }));
  const r = await runNode({ fanout: { when: "确定性失败", over: [{}], gather: { how: "vote", labels: ["真回归"] } } }, ctx({ label: "确定性失败", result: "" }));
  expect(r.label).toBe("真回归");
});

test("列表=顺序:prior/label 串下去,末步 when 命中", async () => {
  // 第一片判官出"确定性失败",第二片 fanout when 命中
  let phase = 0;
  mock((name) => {
    if (name === "submit_verdict") return phase++ === 0 ? { label: "确定性失败", confidence: "high", evidence: ["e"] } : { label: "真回归", confidence: "high", evidence: ["e"] };
    return {};
  });
  const list = [
    { intent: "分诊", labels: ["测试通过", "flaky", "确定性失败"] },
    { fanout: { when: "确定性失败", over: [{}], gather: { how: "vote" as const, labels: ["真回归", "测试bug"] } } },
  ];
  const r = await runNode(list, ctx());
  expect(r.label).toBe("真回归");
});
