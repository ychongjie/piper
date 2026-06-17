// 跑一条 shell 命令并收集结果(确定性 action / 真实验证器用)。
import { execFile } from "node:child_process";

export interface ShResult {
  ok: boolean; // 退出码 0
  code: number | null;
  stdout: string;
  stderr: string;
  output: string; // stdout(+stderr),给验收/接地用
}

export function sh(cmd: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ShResult> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", cmd],
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        const out = (stdout ?? "") + (stderr ? `\n[stderr]\n${stderr}` : "");
        resolve({ ok: !err, code, stdout: stdout ?? "", stderr: stderr ?? "", output: out });
      },
    );
  });
}
