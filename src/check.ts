// 客观验收抽象。Piper 的命门:不信 worker 自报,跑一个独立的客观检查。
// Check 是个返回 {ok, output} 的函数 —— 既能是 shell 退出码,也能是"解析 trace 失败数==0"
// 这类自定义判定(对应 watchdog spec §3 的真验收铁律)。

import { execFile } from "node:child_process";

export interface CheckResult {
  ok: boolean;
  output: string;
}

/** 可带一个人类可读 label(派 worker 时写进 prompt)。 */
export type Check = (() => Promise<CheckResult>) & { label?: string };

/** 最常见的 check:在 cwd 跑一条 shell 命令,退出码 0 = 通过。 */
export function shellCheck(cmd: string, opts: { cwd?: string; timeoutMs?: number } = {}): Check {
  const check = (() =>
    new Promise<CheckResult>((resolve) => {
      execFile(
        "sh",
        ["-c", cmd],
        { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = (stdout ?? "") + (stderr ? `\n[stderr]\n${stderr}` : "");
          resolve({ ok: !err, output: out });
        },
      );
    })) as Check;
  check.label = cmd;
  return check;
}

/** 把任意 async 判定包成 Check(例:解析测试报告,失败数==0 才 ok)。 */
export function fnCheck(fn: () => Promise<CheckResult>, label: string): Check {
  const check = fn as Check;
  check.label = label;
  return check;
}
