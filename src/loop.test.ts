// loop 调度 + 状态持久化单测,不打网络。跑:bun test
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loop } from "./loop.ts";

test("跑到 done 停,state 累加", async () => {
  const r = await loop<{ n: number }>({
    name: "t",
    state: { n: 0 },
    intervalMs: 0,
    tick: async ({ state }) => {
      state.n += 1;
      return state.n >= 3 ? { done: true, reason: "到 3" } : undefined;
    },
  });
  expect(r.reason).toBe("done");
  expect(r.ticks).toBe(3);
  expect(r.state.n).toBe(3);
});

test("maxTicks 兜底", async () => {
  const r = await loop<{ n: number }>({
    name: "t",
    state: { n: 0 },
    intervalMs: 0,
    maxTicks: 2,
    tick: async ({ state }) => {
      state.n += 1; // 永不 done
    },
  });
  expect(r.reason).toBe("max-ticks");
  expect(r.ticks).toBe(2);
});

test("状态落盘 + 重启续跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piper-loop-"));
  const statePath = join(dir, "state.json");
  // 第一段:跑 2 tick 后停(maxTicks),state.n=2 落盘
  await loop<{ n: number }>({
    name: "t", state: { n: 0 }, intervalMs: 0, maxTicks: 2, statePath,
    tick: async ({ state }) => { state.n += 1; },
  });
  expect(JSON.parse(readFileSync(statePath, "utf8")).n).toBe(2);
  // 第二段:同 statePath 重启,应从 n=2 续,再跑 1 tick → n=3
  const r2 = await loop<{ n: number }>({
    name: "t", state: { n: 0 }, intervalMs: 0, maxTicks: 1, statePath,
    tick: async ({ state }) => { state.n += 1; },
  });
  expect(r2.state.n).toBe(3); // 续跑,不是从 0
  rmSync(dir, { recursive: true, force: true });
});

test("abort 停止", async () => {
  const ac = new AbortController();
  const r = await loop<{ n: number }>({
    name: "t", state: { n: 0 }, intervalMs: 0, signal: ac.signal,
    tick: async ({ state }) => { state.n += 1; if (state.n === 2) ac.abort(); },
  });
  expect(r.reason).toBe("aborted");
  expect(r.state.n).toBe(2);
});
