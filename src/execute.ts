// 执行阶段:由 piper 框架 + 便宜模型 跑【已编译产物】。这一阶段【不调强模型首次编译】——
// 缓存里没有该步的脚本 = 你跳过了编译阶段(NeedsCompile)。便宜模型只在两处出现:
//   - 结构性自修(已编译脚本因接口变动失效 → 复用编译阶段重编,版本化、可回滚);
//   - 上层 verify 的判官 panel(见 agent.ts;不在本文件)。
// 缓存命中就直接跑脚本,0 次大模型调用——这是"降算力"的本体。

import { type CompileResult, type CrystallizableAction, type CrystalCache, compileAction } from "./compile.ts";
import type { EscalationHandler } from "./escalate.ts";
import { sh } from "./sh.ts";

export interface RunResult {
  output: string;
  signal: string; // 脚本 stdout(trim)
  mode: "cached" | "repaired" | "compiled";
  version: number;
}

/** 执行期遇到"从没编译过的步骤":这是缺编译阶段,不该就地拿便宜模型现编。 */
export class NeedsCompileError extends Error {
  constructor(public readonly actionId: string) {
    super(`步骤 ${actionId} 没有编译产物。先跑编译阶段(piper compile)再执行。`);
    this.name = "NeedsCompileError";
  }
}

const TRANSIENT = /timeout|timed out|5\d\d\b|connection reset|temporarily|try again/i;

export interface RunOpts {
  cache: CrystalCache;
  escalate: EscalationHandler;
  onLog?: (m: string) => void;
  // —— 自修 / 兜底(传给 compileAction)——
  selfContained?: boolean;
  forbidRuntimeDeps?: readonly RegExp[];
  maxRepairs?: number; // 结构性自修轮数,默认 2
  compileIfMissing?: boolean; // 缺产物时就地编译(dev/惰性路径);默认 false=严格,抛 NeedsCompile
  allowRecompile?: boolean; // 已编译脚本结构性失效时自修重编;默认 true
}

/**
 * 跑一个已编译动作:载入缓存脚本 → sh → 独立验收。
 * 命中即返回(0 大模型调用);瞬态失败重试原脚本;结构性失败→(允许时)复用编译阶段自修。
 */
export async function runAction(action: CrystallizableAction, opts: RunOpts): Promise<RunResult> {
  const log = opts.onLog ?? (() => {});
  const max = opts.maxRepairs ?? 2;
  const compileIfMissing = opts.compileIfMissing ?? false;
  const allowRecompile = opts.allowRecompile ?? true;

  // 危险写:运行真跑前过授权闸(只在此过一次;自修重编时告诉 compileAction 别再过)。
  if (action.danger) {
    const res = await opts.escalate({ kind: "authorization", reason: `运行危险动作:${action.danger}`, options: ["approve", "deny"] });
    if (res.decision !== "approve") throw new Error(`run ${action.id} 授权被拒:${action.danger}`);
  }

  const recompile = (prior?: { script: string; error: string }): Promise<CompileResult> =>
    compileAction(action, {
      cache: opts.cache,
      escalate: opts.escalate,
      selfContained: opts.selfContained,
      forbidRuntimeDeps: opts.forbidRuntimeDeps,
      onLog: log,
      skipDangerGate: true, // 上面已过闸
      prior,
    });

  const stored = opts.cache.load(action.id);
  // NL 改了 → 旧脚本作废。严格执行期应已离线重编;运行期允许就地自修重编。
  const cached = stored && stored.nl === action.nl ? stored : null;
  if (stored && !cached) log(`[run:${action.id}] 意图已变 → 旧脚本作废`);

  if (!cached) {
    if (!compileIfMissing && !(stored && allowRecompile)) throw new NeedsCompileError(action.id);
    log(`[run:${action.id}] ${stored ? "意图变,重编" : "无产物,就地编译"}……`);
    const c = await recompile(stored ? { script: stored.script, error: "意图已变,需按新意图重编" } : undefined);
    return { output: c.output, signal: c.signal, mode: c.mode, version: c.version };
  }

  // 跑缓存脚本(命中路径:0 大模型调用)。
  const out = await sh(cached.script, { cwd: action.cwd });
  if (await action.verify(out.output)) {
    log(`[run:${action.id}] 缓存命中(v${cached.version})`);
    return { output: out.output, signal: out.stdout.trim(), mode: "cached", version: cached.version };
  }

  log(`[run:${action.id}] 缓存脚本没过验收 → 分类失败`);
  let failOut = out.output;
  let priorScript = cached.script;

  for (let i = 1; i <= max; i++) {
    // 瞬态:重试原脚本即可。
    if (TRANSIENT.test(failOut)) {
      const retry = await sh(priorScript, { cwd: action.cwd });
      if (await action.verify(retry.output)) {
        log(`[run:${action.id}] 瞬态,重试旧脚本即过`);
        return { output: retry.output, signal: retry.stdout.trim(), mode: "cached", version: cached.version };
      }
      failOut = retry.output;
    }
    // 结构性:复用编译阶段自修重编(版本化、可回滚)。
    if (!allowRecompile) break;
    log(`[run:${action.id}] 结构性失效 → 自修重编第 ${i}/${max} 轮`);
    try {
      const c = await recompile({ script: priorScript, error: failOut });
      return { output: c.output, signal: c.signal, mode: "repaired", version: c.version };
    } catch (e) {
      failOut = (e as Error).message;
      priorScript = opts.cache.load(action.id)?.script ?? priorScript;
    }
  }

  const res = await opts.escalate({ kind: "error", reason: `${action.id} 执行失败且自修无果,升级`, payload: failOut.slice(0, 500) });
  throw new Error(`run ${action.id} 失败,已升级(${res.decision})`);
}

export interface CrystallizeResult {
  output: string;
  signal: string;
  mode: "cached" | "compiled" | "repaired";
}

/**
 * 惰性一体路径(dev / 测试 / 单跑):缺产物就地编译 + 结构性自修。
 * = runAction({compileIfMissing:true})。生产 agent 执行走严格 runAction,首次编译在离线阶段。
 */
export async function crystallize(
  action: CrystallizableAction,
  opts: {
    cache: CrystalCache;
    escalate: EscalationHandler;
    maxRepairs?: number;
    onLog?: (m: string) => void;
    selfContained?: boolean;
    forbidRuntimeDeps?: readonly RegExp[];
  },
): Promise<CrystallizeResult> {
  const r = await runAction(action, { ...opts, compileIfMissing: true, allowRecompile: true });
  return { output: r.output, signal: r.signal, mode: r.mode };
}
