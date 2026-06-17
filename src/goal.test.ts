// goal 外环单测:mock worker,不打网络、不花钱。镜像旧 Racket goal-test 的三条核心。
// 跑:bun test

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellCheck } from "./check.ts";
import { type Dispatch, goal } from "./goal.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "piper-goal-"));
}

// mock worker:第 fixOn 次调用时创建 done.txt;记录收到的 prompt。
function mockWorker(dir: string, fixOn = Number.POSITIVE_INFINITY) {
  const prompts: string[] = [];
  let calls = 0;
  const dispatch: Dispatch = async ({ prompt }) => {
    calls += 1;
    prompts.push(prompt);
    if (calls >= fixOn) writeFileSync(join(dir, "done.txt"), "done");
    return { output: `mock run ${calls}` };
  };
  return { dispatch, prompts: () => prompts };
}

test("验收本来就过:不派 worker", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "done.txt"), "done");
  const { dispatch, prompts } = mockWorker(dir);
  const r = await goal({
    goal: "造出 done.txt",
    check: shellCheck("test -f done.txt", { cwd: dir }),
    dispatch,
  });
  expect(r.status).toBe("already-done");
  expect(r.steps).toBe(0);
  expect(prompts().length).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("第 2 轮修好 → success,且第 2 轮 prompt 带上一轮失败反馈", async () => {
  const dir = tmp();
  const { dispatch, prompts } = mockWorker(dir, 2);
  const r = await goal({
    goal: "造出 done.txt",
    check: shellCheck("test -f done.txt", { cwd: dir }),
    dispatch,
    maxSteps: 3,
  });
  expect(r.status).toBe("success");
  expect(r.steps).toBe(2);
  expect(prompts().length).toBe(2);
  expect(prompts()[0]).toContain("第 1/3 轮");
  expect(prompts()[1]).toContain("上一轮验收失败");
  rmSync(dir, { recursive: true, force: true });
});

test("修不好 → exhausted,派满 maxSteps 轮", async () => {
  const dir = tmp();
  const { dispatch, prompts } = mockWorker(dir); // 永不修好
  const r = await goal({
    goal: "造出 done.txt",
    check: shellCheck("test -f done.txt", { cwd: dir }),
    dispatch,
    maxSteps: 2,
  });
  expect(r.status).toBe("exhausted");
  expect(r.steps).toBe(2);
  expect(prompts().length).toBe(2);
  rmSync(dir, { recursive: true, force: true });
});
