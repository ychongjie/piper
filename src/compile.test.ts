// fileCache 磁盘格式单测:.sh 文件 + lock.json;旧格式 <id>.json 读回退 + 迁移。跑:bun test
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fileCache, migrateCache, readLock } from "./compile.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "piper-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("save → 写真 .sh 文件 + lock.json,load 读回", () => {
  const c = fileCache(dir);
  c.save("agent__step-build", "echo built", 2, "编译二进制");

  // .sh 是真文件(可 review/直接跑),lock 记录版本+意图
  expect(existsSync(join(dir, "agent__step-build.sh"))).toBe(true);
  expect(readFileSync(join(dir, "agent__step-build.sh"), "utf8")).toBe("echo built");
  const lock = readLock(dir);
  expect(lock.actions["agent__step-build"].version).toBe(2);
  expect(lock.actions["agent__step-build"].nl).toBe("编译二进制");
  expect(lock.actions["agent__step-build"].script).toBe("agent__step-build.sh");

  const got = c.load("agent__step-build");
  expect(got).toEqual({ script: "echo built", version: 2, nl: "编译二进制" });
});

test("多动作共用一份 lock.json(可一处 review 全部版本)", () => {
  const c = fileCache(dir);
  c.save("a__x", "echo 1", 1, "x");
  c.save("a__y", "echo 2", 3, "y");
  const lock = readLock(dir);
  expect(Object.keys(lock.actions).sort()).toEqual(["a__x", "a__y"]);
  expect(lock.actions["a__y"].version).toBe(3);
});

test("缺脚本文件 → load 返回 null(锁有项但 .sh 丢了)", () => {
  const c = fileCache(dir);
  c.save("a__z", "echo z", 1, "z");
  rmSync(join(dir, "a__z.sh"));
  expect(c.load("a__z")).toBeNull();
});

test("旧格式 <id>.json:load 读回退,save 后自动迁成 .sh + 删旧", () => {
  // 手写一个旧格式产物
  writeFileSync(join(dir, "old__t.json"), JSON.stringify({ id: "old__t", nl: "n", script: "echo legacy", version: 5 }));
  const c = fileCache(dir);
  // load 仍能读到(过渡兼容)
  expect(c.load("old__t")).toEqual({ script: "echo legacy", version: 5, nl: "n" });
  // 再 save 触发迁移
  c.save("old__t", "echo legacy", 5, "n");
  expect(existsSync(join(dir, "old__t.json"))).toBe(false); // 旧的删了
  expect(existsSync(join(dir, "old__t.sh"))).toBe(true); // 新的在
  expect(readLock(dir).actions["old__t"].version).toBe(5);
});

test("migrateCache:批量把旧格式迁成新格式", () => {
  writeFileSync(join(dir, "a__1.json"), JSON.stringify({ nl: "n1", script: "echo 1", version: 1 }));
  writeFileSync(join(dir, "a__2.json"), JSON.stringify({ nl: "n2", script: "echo 2", version: 2 }));
  const ids = migrateCache(dir).sort();
  expect(ids).toEqual(["a__1", "a__2"]);
  expect(existsSync(join(dir, "a__1.sh"))).toBe(true);
  expect(existsSync(join(dir, "a__2.json"))).toBe(false);
  expect(Object.keys(readLock(dir).actions).sort()).toEqual(["a__1", "a__2"]);
});
