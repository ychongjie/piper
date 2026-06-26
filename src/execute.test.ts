// execute 单测:mock 编译(假后端喂脚本)+ 本地 echo 当"跑脚本",不打网络。跑:bun test
import { expect, test } from "bun:test";
import { type CrystalCache, containmentViolations } from "./compile.ts";
import { crystallize, runAction, NeedsCompileError } from "./execute.ts";
import { denyByDefault } from "./escalate.ts";
import { sh } from "./sh.ts";
import { setBackendOverride } from "./session.ts";

function memCache(): CrystalCache {
  const m = new Map<string, { script: string; version: number; nl: string }>();
  return { load: (id) => m.get(id) ?? null, save: (id, script, version, nl) => m.set(id, { script, version, nl }) };
}

// 假后端:writeScript 的 submit_script 工具在 customTools 末尾;prompt 时直接喂预设脚本。
function mockScript(scripts: string[]) {
  let i = 0;
  setBackendOverride(async (opts: any) => {
    const tools = opts?.customTools ?? [];
    const submit = tools[tools.length - 1];
    return {
      session: {
        subscribe: () => () => {},
        prompt: async () => {
          if (submit) await submit.execute("c", { script: scripts[Math.min(i++, scripts.length - 1)] });
        },
      },
    } as any;
  });
}

const esc = denyByDefault();

test("缓存命中 → 直接跑缓存脚本", async () => {
  const cache = memCache();
  cache.save("a", "echo hi", 1, "n");
  const r = await crystallize({ id: "a", nl: "n", verify: (o) => o.includes("hi") }, { cache, escalate: esc });
  expect(r.mode).toBe("cached");
  expect(r.signal).toBe("hi");
});

test("首次编译 → 独立验收 → 缓存", async () => {
  mockScript(["echo compiled"]);
  const cache = memCache();
  const r = await crystallize({ id: "b", nl: "n", verify: (o) => o.includes("compiled") }, { cache, escalate: esc });
  expect(r.mode).toBe("compiled");
  expect(cache.load("b")?.script).toBe("echo compiled");
});

test("缓存脚本没过验收 → 自修 → 重新缓存", async () => {
  mockScript(["echo good"]);
  const cache = memCache();
  cache.save("c", "echo bad", 1, "n");
  const r = await crystallize({ id: "c", nl: "n", verify: (o) => o.includes("good") }, { cache, escalate: esc });
  expect(r.mode).toBe("repaired");
  expect(cache.load("c")?.script).toBe("echo good");
  expect(cache.load("c")?.version).toBe(2);
});

test("危险写授权被拒 → 抛错(不执行)", async () => {
  const cache = memCache();
  cache.save("d", "echo x", 1, "n");
  await expect(
    crystallize({ id: "d", nl: "n", danger: "删测试环境", verify: () => true }, { cache, escalate: esc }),
  ).rejects.toThrow(/授权被拒/);
});

// ---- 严格执行:缺产物 → NeedsCompile(不就地编译)----
test("runAction 严格:缓存里没有 → 抛 NeedsCompile", async () => {
  const cache = memCache();
  await expect(
    runAction({ id: "miss", nl: "n", verify: () => true }, { cache, escalate: esc }),
  ).rejects.toBeInstanceOf(NeedsCompileError);
});

test("runAction 严格:命中缓存 → 跑脚本(不编译)", async () => {
  const cache = memCache();
  cache.save("hit", "echo ok", 3, "n");
  const r = await runAction({ id: "hit", nl: "n", verify: (o) => o.includes("ok") }, { cache, escalate: esc });
  expect(r.mode).toBe("cached");
  expect(r.version).toBe(3);
});

// ---- 可观测性:危险播报 / 执行输出 / 超时 ----
const approve = async () => ({ decision: "approve", resolvedBy: "human" as const });

test("危险动作:高声播报 + 打印闸结论", async () => {
  const cache = memCache();
  cache.save("d2", "echo done", 1, "n");
  const logs: string[] = [];
  await runAction({ id: "d2", nl: "n", danger: "重建本 agent 专用环境", verify: () => true }, { cache, escalate: approve, onLog: (m) => logs.push(m) });
  const joined = logs.join("\n");
  expect(joined).toMatch(/⚠ 危险动作.*重建本 agent 专用环境/);
  expect(joined).toMatch(/闸结论:approve/);
});

test("执行期落脚本输出尾部(可盯 deploy/build 实际打了什么)", async () => {
  const cache = memCache();
  cache.save("o1", "echo HELLO_FROM_SCRIPT", 1, "n");
  const logs: string[] = [];
  await runAction({ id: "o1", nl: "n", verify: (o) => o.includes("HELLO") }, { cache, escalate: esc, onLog: (m) => logs.push(m) });
  expect(logs.join("\n")).toContain("HELLO_FROM_SCRIPT");
});

test("sh 尊重 timeoutMs(重活超时即失败,不再卡死 60s)", async () => {
  const r = await sh("sleep 0.5", { timeoutMs: 60 });
  expect(r.ok).toBe(false);
});

// ---- 自包含:静态检查(纯函数)----
const REPO_SCRIPT = /(?:bash|sh|source)\s+\S*tester\/api-test\/scripts\/[\w-]+\.sh/;

test("自包含检查:read ~/.claude/skills → 违规", () => {
  const v = containmentViolations("cat ~/.claude/skills/safeline-apitest-env/SKILL.md");
  expect(v[0]).toMatch(/\.claude\/skills/);
});

test("自包含检查:shell-out 到本机 .sh(绝对路径)→ 违规(内置,无需 forbid)", () => {
  const v = containmentViolations("bash $HOME/Code/gitlab/safeline-3/tester/api-test/scripts/provision-env.sh");
  expect(v.some((x) => /\.sh/.test(x))).toBe(true);
});

test("自包含检查:shell-out 到本机 .sh(相对路径)→ 违规", () => {
  const v = containmentViolations("bash tester/api-test/scripts/provision-env.sh");
  expect(v.some((x) => /\.sh/.test(x))).toBe(true);
});

test("自包含检查:只用系统工具 + 内联逻辑 → 干净", () => {
  const s = "set -e\ncd $REPO && go build ./...\ncurl -s http://10.2.39.2/api | jq .\nglab variable get TOKEN";
  expect(containmentViolations(s, [REPO_SCRIPT]).length).toBe(0);
});

// ---- 自包含:开关关 → 不拦(旧行为不变)----
test("selfContained 关:引用 skill 的缓存脚本照样命中", async () => {
  const cache = memCache();
  cache.save("e", "cat ~/.claude/skills/foo/SKILL.md; echo ok", 1, "n");
  const r = await crystallize({ id: "e", nl: "n", verify: (o) => o.includes("ok") }, { cache, escalate: esc });
  expect(r.mode).toBe("cached"); // 没开 selfContained → 不查
});

// ---- 自包含:开关开 → 违规脚本被拒、自修产出内联脚本才入缓存 ----
test("selfContained 开:违规→自修内联→缓存自包含脚本", async () => {
  // 首版 shell-out 仓库脚本(违规)→ 自修给出内联版(只 echo,自包含)
  mockScript(["bash $HOME/Code/gitlab/safeline-3/tester/api-test/scripts/provision-env.sh", "echo env_id=piper-watchdog-1 running"]);
  const cache = memCache();
  const r = await crystallize(
    { id: "f", nl: "起本 agent 专用环境", verify: (o) => /env_id|running/.test(o) },
    { cache, escalate: esc, selfContained: true, forbidRuntimeDeps: [REPO_SCRIPT] },
  );
  expect(r.mode).toBe("repaired"); // 第一版被自包含检查拦 → 自修
  expect(containmentViolations(cache.load("f")!.script, [REPO_SCRIPT]).length).toBe(0); // 入缓存的是自包含版
});
