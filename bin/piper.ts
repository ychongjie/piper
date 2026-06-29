#!/usr/bin/env bun
// piper —— 跑一份 v2 agent YAML(单 tick)。项目专属 runner(设 cwd/toolsDir/监控循环)住 piper-agents。
// 用法:piper run <agent.yaml> [--cwd DIR] [--tools DIR] [--no-trigger]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgentV2, runOnce } from "../src/v2/run.ts";

const [cmd, file, ...rest] = process.argv.slice(2);
if (cmd !== "run" || !file) {
  console.error("用法:piper run <agent.yaml> [--cwd DIR] [--tools DIR] [--no-trigger]");
  process.exit(1);
}
const flag = (n: string): string | undefined => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : undefined;
};

const a = loadAgentV2(readFileSync(file, "utf8"));
const toolsDir = flag("--tools");
const r = await runOnce(a, {
  cwd: flag("--cwd"),
  toolsDir: toolsDir ? resolve(toolsDir) : undefined,
  runTrigger: !rest.includes("--no-trigger"),
  onLog: (m) => console.error(m),
});
console.error(`\n归因 label=${r.label ?? "(无)"}  status=${r.status}`);
