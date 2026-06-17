// 通用验证器:git_diff_touches —— 某次构建/分支的 diff 是否动了某路径。
// 确定性、只读(只跑 git diff,不改目标仓库任何东西)。repoDir 由调用方传入。
// 通常跑在目标仓库的隔离克隆上,treeless 克隆即可(--name-only 不需要 blob)。

import { sh } from "../sh.ts";

export interface GitDiffTouchesResult {
  touched: boolean;
  matched: string[]; // 命中 pattern 的改动文件
  changedCount: number; // 总改动文件数
  base: string;
  head: string;
  pattern: string;
  output: string; // 给归因 agent 当 evidence 的人类可读结论
}

function matchPath(file: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(file);
  }
  return file.includes(pattern); // 无通配=子串匹配(路径前缀很自然)
}

/** 在 repoDir 跑 git diff --name-only base...head,判断是否动了匹配 pattern 的路径。 */
export async function gitDiffTouches(opts: {
  repoDir: string;
  base: string; // 如 "origin/master" 或上次测过的 tag
  head: string; // 如 "HEAD" 或当前 tag
  pattern: string; // 路径子串或带 * 的通配
}): Promise<GitDiffTouchesResult> {
  const { repoDir, base, head, pattern } = opts;
  const r = await sh(`git diff --name-only ${base}...${head}`, { cwd: repoDir });
  if (!r.ok) {
    return { touched: false, matched: [], changedCount: 0, base, head, pattern, output: `git diff 失败:${r.output.trim()}` };
  }
  const changed = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const matched = changed.filter((f) => matchPath(f, pattern));
  const touched = matched.length > 0;
  const output = touched
    ? `diff(${base}...${head}) 动了 ${matched.length}/${changed.length} 个匹配 "${pattern}" 的文件:${matched.slice(0, 5).join(", ")}${matched.length > 5 ? " …" : ""}`
    : `diff(${base}...${head}) 共 ${changed.length} 个文件改动,但【没有】匹配 "${pattern}" 的 → 行为变化不太可能由本次代码引起`;
  return { touched, matched, changedCount: changed.length, base, head, pattern, output };
}
