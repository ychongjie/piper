// loop:定时/轮询守望(pi 没有调度器,这是纯 Piper 的控制平面)。
// 每 tick 干一次活(查新构建→跑回归守望),tick 间 sleep,状态落盘以便重启续跑
// (形如 babysit-ci 的 per-MR 状态文件:last_tested_tag 等跨 tick 存活)。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TickContext<S> {
  tick: number;
  state: S; // 可变,每 tick 后落盘
  log: (m: string) => void;
}

export interface TickResult {
  done?: boolean; // 返回 done 则结束 loop
  reason?: string;
}

export interface LoopOptions<S extends object> {
  name: string;
  state: S; // 初始状态(若 statePath 有存档则合并覆盖)
  tick: (ctx: TickContext<S>) => Promise<TickResult | void>;
  intervalMs: number; // tick 间隔
  maxTicks?: number; // 安全预算
  statePath?: string; // 状态持久化路径(重启续跑)
  signal?: AbortSignal; // 外部停止
  onLog?: (m: string) => void;
}

export interface LoopResult<S> {
  ticks: number;
  state: S;
  reason: "done" | "max-ticks" | "aborted";
}

function loadState<S extends object>(path: string | undefined, initial: S): S {
  if (path && existsSync(path)) {
    try {
      return { ...initial, ...JSON.parse(readFileSync(path, "utf8")) };
    } catch {
      /* 存档损坏就用初始值 */
    }
  }
  return initial;
}

function saveState(path: string | undefined, state: object): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

export async function loop<S extends object>(opts: LoopOptions<S>): Promise<LoopResult<S>> {
  const log = opts.onLog ?? (() => {});
  const state = loadState(opts.statePath, opts.state);
  const max = opts.maxTicks ?? Number.POSITIVE_INFINITY;
  let tick = 0;

  while (true) {
    if (opts.signal?.aborted) return { ticks: tick, state, reason: "aborted" };
    if (tick >= max) return { ticks: tick, state, reason: "max-ticks" };
    tick += 1;
    log(`[loop:${opts.name}] tick ${tick}`);
    const r = (await opts.tick({ tick, state, log })) ?? {};
    saveState(opts.statePath, state); // 每 tick 后落盘 → 崩了重启能续
    if (r.done) {
      log(`[loop:${opts.name}] 结束:${r.reason ?? "done"}`);
      return { ticks: tick, state, reason: "done" };
    }
    await sleep(opts.intervalMs, opts.signal);
  }
}
