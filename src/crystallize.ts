// crystallize:把"机械意图"从自然语言固化成可复用脚本。
// 首次:agent 读 skill + 用 bash 实地试 → 提交脚本 → 【独立验收】(执行者≠判官)→ 缓存。
// 之后:直接跑缓存脚本(便宜、确定)。坏了:分瞬态(重试)/ 结构性(自修,版本可回滚),
// 自修超限 → 升级。危险写(danger)固化/运行前过授权闸。
//
// 这是"运行时的微观蒸馏":判断不固化(那是 panel),机械的才固化。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EscalationHandler } from "./escalate.ts";
import { backendForModel } from "./session.ts";
import { sh } from "./sh.ts";

export interface CrystallizableAction {
  id: string; // 缓存键
  nl: string; // 自然语言意图
  verify: (output: string) => boolean | Promise<boolean>; // 独立验收契约
  skills?: string[]; // 编译时可参考的 skill 名(~/.claude/skills/<name>)
  cwd?: string;
  danger?: string | null; // 非空=危险写,固化/运行前过授权闸
  selfContained?: boolean; // 覆盖 agent 级 policy:本步产物是否强制自包含(如重活步骤暂用仓库脚本→false)
  model?: string; // 标准模型名(查 piper 配置);缺省=配置 default_model
}

export interface CrystallizeResult {
  output: string;
  signal: string; // 脚本 stdout(trim)
  mode: "cached" | "compiled" | "repaired";
}

export interface CrystalCache {
  load(id: string): { script: string; version: number; nl: string } | null;
  save(id: string, script: string, version: number, nl: string): void;
}

export function fileCache(dir: string): CrystalCache {
  return {
    load(id) {
      const f = join(dir, `${id}.json`);
      if (!existsSync(f)) return null;
      try {
        const j = JSON.parse(readFileSync(f, "utf8"));
        return { script: j.script, version: j.version, nl: j.nl ?? "" };
      } catch {
        return null;
      }
    },
    save(id, script, version, nl) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({ id, nl, script, version, verifiedAt: new Date().toISOString() }, null, 2),
      );
    },
  };
}

// ---- 自包含检查:编译产物运行时不得依赖"知识来源"(skill 提示词 / 外部仓库脚本)----
// 能依赖的只有系统工具(curl/jq/ssh/glab/docker…)+ 活的基础设施。skill/仓库脚本里的逻辑
// 必须在编译期【内联/抄进】脚本本身(钉成快照),换机/换版本即跑、可入仓版本化。
const SKILL_DEP = /\.claude\/skills/; // skill 提示词永不该是运行时依赖

export function containmentViolations(script: string, forbid: readonly RegExp[] = []): string[] {
  const out: string[] = [];
  if (SKILL_DEP.test(script)) out.push("运行时 read 了 ~/.claude/skills(skill 提示词应在编译期内联,运行时不该读)");
  for (const re of forbid) if (re.test(script)) out.push(`运行时依赖了外部仓库脚本(应内联):${re.source}`);
  return out;
}

const brief = (s: string, n = 200): string => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
};
// 从 pi 工具结果 / 消息里抽文本(形状不一,防御性取 content[].text)。
const textOf = (x: any): string => {
  if (!x) return "";
  if (typeof x === "string") return x;
  const c = x.content ?? x.message?.content;
  if (Array.isArray(c)) return c.map((p: any) => p?.text ?? "").join(" ");
  return "";
};

// 订阅 pi 会话事件 → 把便宜模型的实地试(bash/read/提交 + 输出 + 文本)流进日志。
function observeSession(session: any, log: (m: string) => void): () => void {
  if (typeof session?.subscribe !== "function") return () => {};
  return session.subscribe((ev: any) => {
    try {
      if (ev.type === "tool_execution_start") {
        const a = ev.args ?? {};
        const d =
          ev.toolName === "bash" ? `: ${brief(String(a.command ?? ""), 220)}` :
          ev.toolName === "read" ? `: ${a.path ?? a.file ?? ""}` :
          ev.toolName === "submit_script" ? " (提交最终脚本)" : "";
        log(`    ⎯ ${ev.toolName}${d}`);
      } else if (ev.type === "tool_execution_end") {
        const t = brief(textOf(ev.result), 200);
        log(`    ⎿ ${ev.isError ? "✗" : "✓"}${t ? " " + t : ""}`);
      } else if (ev.type === "message_end") {
        const t = brief(textOf(ev.message), 220);
        if (t) log(`    · ${t}`);
      }
    } catch {}
  });
}

// 让 agent 读 skill + 用 bash 实地试,最后提交一个脚本。
async function writeScript(o: {
  nl: string;
  skills?: string[];
  cwd?: string;
  selfContained?: boolean;
  model?: string;
  log?: (m: string) => void;
  prior?: { script: string; error: string };
}): Promise<string | null> {
  let captured: string | null = null;
  const submit = defineTool({
    name: "submit_script",
    label: "提交脚本",
    description: "提交一个【已实地试通过】的可复用 shell 脚本;它会被缓存、之后直接运行。",
    parameters: Type.Object({
      script: Type.String({ description: "完整 shell 脚本(把结果打到 stdout)" }),
      note: Type.Optional(Type.String()),
    }),
    execute: async (_id: string, p: any) => {
      captured = String(p.script);
      return { content: [{ type: "text", text: "已收到脚本" }], details: {}, terminate: true };
    },
  });

  const { session } = await backendForModel(o.model)({
    cwd: o.cwd,
    tools: ["read", "bash", "submit_script"],
    customTools: [submit],
  });
  const unobserve = o.log ? observeSession(session, o.log) : () => {};

  const prompt = [
    o.prior ? "下面这个脚本坏了,请诊断并修好它。" : "请实现下面这个意图,产出一个【可复用的 shell 脚本】。",
    `意图:${o.nl}`,
    o.skills?.length ? `相关 skill / 仓库脚本(编译期可 read 参考,把需要的逻辑【抄进】产物):${o.skills.map((s) => `~/.claude/skills/${s}/SKILL.md`).join("、")}` : "",
    o.prior ? `旧脚本:\n\`\`\`\n${o.prior.script}\n\`\`\`\n报错/异常输出:\n\`\`\`\n${o.prior.error.slice(0, 1500)}\n\`\`\`` : "",
    "要求:",
    "1. 用 bash 工具【实地试】到脚本能跑出正确结果(读 skill、试命令、看输出);",
    "2. 脚本要幂等、尽量只读,把结果打到 stdout;",
    o.selfContained
      ? "3. 【自包含硬要求】产物必须自包含:运行时【只能】用系统工具(curl/jq/ssh/glab/git/docker 等)和活的基础设施(平台/测试机)。" +
        "运行时【禁止】read ~/.claude/skills、【禁止】shell-out 到某个本机仓库检出里的脚本(如 …/scripts/*.sh)。" +
        "需要 skill 或仓库脚本里的逻辑,就在编译期把它【内联/抄进】本脚本(钉成快照),让脚本脱离 skill/仓库也能跑;"
      : "3. 脚本尽量自包含;",
    "4. 实地试通过后再调用 submit_script 提交最终脚本——不要提交没试过的脚本。",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await session.prompt(prompt);
  } finally {
    unobserve();
  }
  return captured;
}

const TRANSIENT = /timeout|timed out|5\d\d\b|connection reset|temporarily|又 try again/i;

export async function crystallize(
  action: CrystallizableAction,
  opts: {
    cache: CrystalCache;
    escalate: EscalationHandler;
    maxRepairs?: number;
    onLog?: (m: string) => void;
    selfContained?: boolean; // 要求产物自包含(运行时不依赖 skill/外部仓库脚本)
    forbidRuntimeDeps?: readonly RegExp[]; // 项目侧额外禁止的运行时依赖(如外部仓库脚本路径)
  },
): Promise<CrystallizeResult> {
  const log = opts.onLog ?? (() => {});
  const max = opts.maxRepairs ?? 2;
  // 自包含 policy:步骤级覆盖优先于 agent 级(重活步骤可设 false 暂用仓库脚本)。
  const selfContained = action.selfContained ?? opts.selfContained;
  // 自包含违规 → 当作一次"验收失败",逼自修把逻辑内联(静态属性,查到就不必跑)。
  const containMsg = (script: string): string | null => {
    if (!selfContained) return null;
    const v = containmentViolations(script, opts.forbidRuntimeDeps ?? []);
    return v.length ? `脚本不自包含:${v.join(";")}。把需要的逻辑【内联/抄进】脚本,运行时别依赖 skill 或外部仓库脚本。` : null;
  };

  // 危险写:固化/运行前过授权闸。
  if (action.danger) {
    const res = await opts.escalate({ kind: "authorization", reason: `固化/运行危险动作:${action.danger}`, options: ["approve", "deny"] });
    if (res.decision !== "approve") throw new Error(`crystallize ${action.id} 授权被拒:${action.danger}`);
  }

  const stored = opts.cache.load(action.id);
  // NL 改了就重编译(缓存按 id+NL 失效;否则会用旧意图的脚本)。
  const cached = stored && stored.nl === action.nl ? stored : null;
  if (stored && !cached) log(`[crystallize:${action.id}] 意图变了 → 弃旧脚本,重新编译`);
  let prev: { script: string; version: number } | null = cached;
  let failOut = "";

  if (cached) {
    const out = await sh(cached.script, { cwd: action.cwd });
    if (await action.verify(out.output)) {
      log(`[crystallize:${action.id}] 缓存命中(v${cached.version})`);
      return { output: out.output, signal: out.stdout.trim(), mode: "cached" };
    }
    log(`[crystallize:${action.id}] 缓存脚本没过验收 → 进入自修`);
    failOut = out.output;
  } else {
    log(`[crystallize:${action.id}] 首次编译……`);
    const script = await writeScript({ nl: action.nl, skills: action.skills, cwd: action.cwd, selfContained, model: action.model, log });
    if (!script) throw new Error(`crystallize ${action.id} 编译失败:没产出脚本`);
    const cv = containMsg(script);
    if (cv) {
      log(`[crystallize:${action.id}] ${cv} → 自修内联`);
      prev = { script, version: 0 };
      failOut = cv;
    } else {
      const out = await sh(script, { cwd: action.cwd });
      if (await action.verify(out.output)) {
        opts.cache.save(action.id, script, 1, action.nl);
        log(`[crystallize:${action.id}] 编译+独立验收通过,缓存 v1`);
        return { output: out.output, signal: out.stdout.trim(), mode: "compiled" };
      }
      prev = { script, version: 0 };
      failOut = out.output;
    }
  }

  // 自修循环(有界)。
  for (let i = 1; i <= max; i++) {
    if (TRANSIENT.test(failOut) && prev) {
      const retry = await sh(prev.script, { cwd: action.cwd });
      if (await action.verify(retry.output)) {
        log(`[crystallize:${action.id}] 瞬态,重试旧脚本即过`);
        return { output: retry.output, signal: retry.stdout.trim(), mode: "cached" };
      }
    }
    log(`[crystallize:${action.id}] 自修第 ${i}/${max} 轮……`);
    const script = await writeScript({ nl: action.nl, skills: action.skills, cwd: action.cwd, selfContained, model: action.model, log, prior: { script: prev?.script ?? "", error: failOut } });
    if (!script) break;
    const cv = containMsg(script);
    if (cv) {
      log(`[crystallize:${action.id}] 仍不自包含 → 继续自修`);
      prev = { script, version: prev?.version ?? 0 };
      failOut = cv;
      continue; // 静态违规,不必跑,直接再修
    }
    const out = await sh(script, { cwd: action.cwd });
    if (await action.verify(out.output)) {
      const ver = (prev?.version ?? 0) + 1;
      opts.cache.save(action.id, script, ver, action.nl);
      log(`[crystallize:${action.id}] 自修成功 → 缓存 v${ver}`);
      return { output: out.output, signal: out.stdout.trim(), mode: "repaired" };
    }
    prev = { script, version: prev?.version ?? 0 };
    failOut = out.output;
  }

  const res = await opts.escalate({ kind: "error", reason: `${action.id} 自修 ${max} 次仍失败,升级`, payload: failOut.slice(0, 500) });
  throw new Error(`crystallize ${action.id} 自修失败,已升级(${res.decision})`);
}
