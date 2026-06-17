// crystallize 单测:mock 编译(假后端喂脚本)+ 本地 echo 当"跑脚本",不打网络。跑:bun test
import { expect, test } from "bun:test";
import { type CrystalCache, crystallize } from "./crystallize.ts";
import { denyByDefault } from "./escalate.ts";
import { setBackend } from "./session.ts";

function memCache(): CrystalCache {
  const m = new Map<string, { script: string; version: number }>();
  return { load: (id) => m.get(id) ?? null, save: (id, script, version) => m.set(id, { script, version }) };
}

// 假后端:writeScript 的 submit_script 工具在 customTools 末尾;prompt 时直接喂预设脚本。
function mockScript(scripts: string[]) {
  let i = 0;
  setBackend(async (opts: any) => {
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
  cache.save("a", "echo hi", 1, "nl");
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
  cache.save("c", "echo bad", 1, "nl");
  const r = await crystallize({ id: "c", nl: "n", verify: (o) => o.includes("good") }, { cache, escalate: esc });
  expect(r.mode).toBe("repaired");
  expect(cache.load("c")?.script).toBe("echo good");
  expect(cache.load("c")?.version).toBe(2);
});

test("危险写授权被拒 → 抛错(不执行)", async () => {
  const cache = memCache();
  cache.save("d", "echo x", 1, "nl");
  await expect(
    crystallize({ id: "d", nl: "n", danger: "删测试环境", verify: () => true }, { cache, escalate: esc }),
  ).rejects.toThrow(/授权被拒/);
});
