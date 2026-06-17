// 观测层:消费 goal/worker 事件 —— 实时看 agent 工作过程 + 落盘复盘(失败好定位)。
// 与 goal.ts 解耦:goal/piDispatch 只负责"发事件",这里负责"看/存"。不传观测器时零开销。

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalEvent, WorkerEvent } from "./goal.ts";

export interface Observer {
  onEvent: (e: GoalEvent) => void;
  onWorkerEvent: (e: WorkerEvent) => void;
}

/** 把多个观测器合并成一个(控制台 + 文件同时挂)。 */
export function mergeObservers(...obs: Observer[]): Observer {
  return {
    onEvent: (e) => { for (const o of obs) o.onEvent(e); },
    onWorkerEvent: (e) => { for (const o of obs) o.onWorkerEvent(e); },
  };
}

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 建一次 run 的日志目录 logs/<label>-<时间戳>/。 */
export function makeRunDir(root = "logs", label = "goal"): string {
  const dir = join(root, `${label}-${ts()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const brief = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
};

/** 控制台实时观测:重点看工具调用 + 验收结果(调试最有用的两样)。 */
export function consoleObserver(): Observer {
  let acc = { text: 0, think: 0 };
  return {
    onEvent: (e) => {
      switch (e.type) {
        case "check":
          if (e.phase === "initial") console.error(`[goal] 初始验收:${e.ok ? "✓ 已达成" : "✗ 未达成,开派 worker"}`);
          else console.error(`[goal] 第 ${e.step} 轮验收:${e.ok ? "✓ 通过" : "✗ 未过"}${e.ok ? "" : "  " + brief(e.output, 80)}`);
          break;
        case "dispatch-start":
          acc = { text: 0, think: 0 };
          console.error(`\n[goal] ── 第 ${e.step}/${e.max} 轮:派 worker ──`);
          break;
        case "dispatch-end":
          console.error(`[goal]   worker 完成(思考 ${acc.think} 字 / 输出 ${acc.text} 字):${brief(e.workerText, 100)}`);
          break;
        case "done":
          console.error(`\n[goal] ══ ${e.status}(${e.steps} 轮)══`);
          break;
      }
    },
    onWorkerEvent: (e) => {
      switch (e.type) {
        case "thinking_delta": acc.think += e.delta.length; break;
        case "text_delta": acc.text += e.delta.length; break;
        case "tool_start": console.error(`[worker]   ⚙ ${e.name}(${brief(JSON.stringify(e.args), 80)})`); break;
        case "tool_end": console.error(`[worker]   ${e.isError ? "✗" : "→"} ${e.name}: ${brief(e.resultText, 100)}`); break;
        case "usage": console.error(`[worker]   tokens in=${e.input} out=${e.output} cost=$${e.cost.toFixed(4)}`); break;
      }
    },
  };
}

/** 文件观测:每步落一份 step-<n>.md(prompt / 思考 / 工具时间线 / 最终输出 / 验收),meta.json 收尾。 */
export function fileObserver(dir: string, meta: { goal: string; checkLabel: string }): Observer {
  let step = 0;
  let prompt = "";
  let timeline: string[] = [];
  let text = "";
  let thinking = "";
  let usage: { input: number; output: number; cost: number } | undefined;

  writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, startedAt: new Date().toISOString() }, null, 2));

  const flush = (checkOk: boolean, checkOut: string) => {
    if (step === 0) return;
    const md = [
      `# step ${step}`,
      `\n## 派给 worker 的 prompt\n\n\`\`\`\n${prompt}\n\`\`\``,
      thinking ? `\n## worker 思考\n\n\`\`\`\n${thinking.trim()}\n\`\`\`` : "",
      `\n## worker 工具时间线\n\n${timeline.length ? timeline.join("\n") : "(没调用工具)"}`,
      `\n## worker 最终输出\n\n${text.trim() || "(空)"}`,
      usage ? `\n## 用量\n\nin=${usage.input} out=${usage.output} cost=$${usage.cost.toFixed(4)}` : "",
      `\n## 客观验收\n\n${checkOk ? "✓ 通过" : "✗ 未过"}\n\n\`\`\`\n${checkOut.trim() || "(无输出)"}\n\`\`\``,
    ].filter(Boolean).join("\n");
    writeFileSync(join(dir, `step-${step}.md`), md);
  };

  return {
    onEvent: (e) => {
      switch (e.type) {
        case "dispatch-start":
          step = e.step; prompt = e.prompt; timeline = []; text = ""; thinking = ""; usage = undefined;
          break;
        case "check":
          if (e.phase === "after-step") flush(e.ok, e.output);
          break;
        case "done":
          appendFileSync(join(dir, "meta.json"), `\n`); // touch; 结果写单独文件,避免重写
          writeFileSync(join(dir, "result.json"), JSON.stringify({ status: e.status, steps: e.steps, endedAt: new Date().toISOString() }, null, 2));
          break;
      }
    },
    onWorkerEvent: (e) => {
      switch (e.type) {
        case "thinking_delta": thinking += e.delta; break;
        case "text_delta": text += e.delta; break;
        case "tool_start": timeline.push(`- ⚙ **${e.name}**(\`${brief(JSON.stringify(e.args), 200)}\`)`); break;
        case "tool_end": timeline.push(`  - ${e.isError ? "✗ 失败" : "→"}:\`${brief(e.resultText, 200)}\``); break;
        case "usage": usage = { input: e.input, output: e.output, cost: e.cost }; break;
      }
    },
  };
}
