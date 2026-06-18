// runAgent 的 do-步骤流水线单测:预置缓存(零 LLM)+ 自管闸。验证步骤按序跑、自管放行、
// 碰别人的资源升级deny→中止 do。跑:bun test
import { expect, test } from "bun:test";
import type { AgentDef, RunDeps } from "./agent.ts";
import { runAgent } from "./agent.ts";
import type { CrystalCache } from "./crystallize.ts";
import { denyByDefault, selfManagedGate } from "./escalate.ts";

function memCache(): CrystalCache {
  const m = new Map<string, { script: string; version: number; nl: string }>();
  return { load: (id) => m.get(id) ?? null, save: (id, script, version, nl) => m.set(id, { script, version, nl }) };
}

test("do 步骤:自管放行、build 无闸、碰别人的环境→升级deny→中止", async () => {
  const a: AgentDef = {
    name: "t",
    loop: { on: "有新提交", do: { nl: "对账→编译→部署", verify: { check: "失败0" } } }, // check 验收 → 不起 panel
  };
  const cache = memCache();
  // 预置脚本(全 echo,本地跑,零 LLM、零网络;nl 要与 action 一致否则会重编译)
  cache.save("t__trigger", "echo sha-abc123", 1, "有新提交");
  cache.save("step-reconcile", "echo reconciled", 1, "对账本 agent 专用环境");
  cache.save("step-build", "echo built", 1, "编译二进制");
  // step-deploy 不预置——它会在授权闸被拒、不会跑到脚本

  const gate = selfManagedGate({ owns: (r) => /本 agent 专用/.test(r), budget: { max: 2, used: { n: 0 } }, fallback: denyByDefault() });

  const deps: RunDeps = {
    cache,
    escalate: gate,
    resolveGround: () => [],
    triggerVerify: () => true,
    doSteps: () => [
      { id: "step-reconcile", nl: "对账本 agent 专用环境", danger: "重建本 agent 专用环境", verify: (o) => o.includes("reconciled") },
      { id: "step-build", nl: "编译二进制", verify: (o) => o.includes("built") },
      { id: "step-deploy", nl: "部署到别人的共享环境", danger: "部署到【别人的】共享环境", verify: () => true },
    ],
  };

  const r = await runAgent(a, deps);

  expect(r.buildId).toBe("sha-abc123");
  expect(r.steps.length).toBe(3);
  expect(r.steps[0].ok).toBe(true); // 对账:自管 → 放行
  expect(r.steps[1].ok).toBe(true); // 编译:无闸
  expect(r.steps[2].ok).toBe(false); // 部署别人的环境 → 升级被拒 → 中止
  expect(r.steps[2].note).toMatch(/授权被拒/);
});
