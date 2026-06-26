// 编译阶段:把"机械意图"(自然语言 + 验收契约)固化成【自包含确定性脚本】。
// 离线由编译模型驱动:读 skill + 用 bash 实地试 → 提交脚本 →【独立验收】(执行者≠判官)
//   → 自包含静态检查(逻辑必须内联,运行期不依赖 skill/外部仓库脚本)→ 版本化落盘。
// 运行期的"结构性自修"也复用本阶段(compileAction 带 prior=旧脚本+报错)。
//
// 这是三阶段里的【编译】:产物可入仓、可 review、换机即跑。执行阶段(execute.ts)只跑产物,不在这。

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  selfContained?: boolean; // 覆盖 agent 级 policy:本步产物是否强制自包含
  model?: string; // 编译用的标准模型名(查 piper 配置);缺省=配置 default_model
}

export interface CompiledScript {
  script: string;
  version: number;
  nl: string;
}

export interface CrystalCache {
  load(id: string): CompiledScript | null;
  save(id: string, script: string, version: number, nl: string): void;
}

// 磁盘格式:每个动作一个真 .sh 文件(可 diff/review/直接跑)+ 一份 lock.json(锁:id → 版本/意图/脚本文件)。
// 这样编译产物是仓库里的一等公民,换机即跑、可版本化。
export interface LockEntry {
  nl: string; // 编译时的意图(变了即作废重编)
  version: number;
  script: string; // 脚本文件名(相对 dir)
  verifiedAt: string;
}
export interface Lock {
  version: 1;
  actions: Record<string, LockEntry>;
}

const LOCK_FILE = "lock.json";
// id → 文件名:CJK/连字符/__ 都保留(可读);只把路径不安全字符压成下划线。
const scriptFileName = (id: string): string => `${id.replace(/[/\\\s]+/g, "_")}.sh`;

function readLockFile(dir: string): Lock {
  const f = join(dir, LOCK_FILE);
  if (!existsSync(f)) return { version: 1, actions: {} };
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return { version: 1, actions: j.actions ?? {} };
  } catch {
    return { version: 1, actions: {} };
  }
}

/** 读一份编译产物锁(供 review / 工具用)。 */
export function readLock(dir: string): Lock {
  return readLockFile(dir);
}

export function fileCache(dir: string): CrystalCache {
  return {
    load(id) {
      const lock = readLockFile(dir);
      const e = lock.actions[id];
      if (e) {
        const sf = join(dir, e.script);
        if (existsSync(sf)) return { script: readFileSync(sf, "utf8"), version: e.version, nl: e.nl };
      }
      // 过渡:旧格式 <id>.json(脚本内联在 json)。读到照常返回;下次 save 自动迁到 .sh + lock。
      const legacy = join(dir, `${id}.json`);
      if (existsSync(legacy)) {
        try {
          const j = JSON.parse(readFileSync(legacy, "utf8"));
          return { script: j.script, version: j.version, nl: j.nl ?? "" };
        } catch {}
      }
      return null;
    },
    save(id, script, version, nl) {
      mkdirSync(dir, { recursive: true });
      const file = scriptFileName(id);
      writeFileSync(join(dir, file), script); // 逐字写,load 逐字读 → 无损往返
      try {
        chmodSync(join(dir, file), 0o755);
      } catch {}
      const lock = readLockFile(dir);
      lock.actions[id] = { nl, version, script: file, verifiedAt: new Date().toISOString() };
      writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
      // 迁移:同名旧格式 json 已搬进 .sh + lock,删掉避免双份。
      const legacy = join(dir, `${id}.json`);
      if (existsSync(legacy)) {
        try {
          rmSync(legacy);
        } catch {}
      }
    },
  };
}

/** 把一个目录里的旧格式 <id>.json 全部迁成新格式(.sh + lock.json),返回迁移的 id 列表。 */
export function migrateCache(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const cache = fileCache(dir);
  const migrated: string[] = [];
  for (const f of readdirSync(dir)) {
    if (f === LOCK_FILE || !f.endsWith(".json")) continue;
    const id = f.slice(0, -".json".length);
    const got = cache.load(id); // 读旧格式
    if (got) {
      cache.save(id, got.script, got.version, got.nl); // 写新格式 + 删旧
      migrated.push(id);
    }
  }
  return migrated;
}

// ---- 自包含检查:编译产物运行时不得依赖"知识来源"(skill 提示词 / 外部仓库脚本)----
// 能依赖的只有系统工具(curl/jq/ssh/glab/docker…)+ 活的基础设施。skill/仓库脚本里的逻辑
// 必须在编译期【内联/抄进】脚本本身(钉成快照),换机/换版本即跑、可入仓版本化。
const SKILL_DEP = /\.claude\/skills/; // skill 提示词永不该是运行时依赖
// 通用禁则(取代逐 agent 的 forbid_runtime_deps):shell-out 到【带路径分隔符的 .sh 文件】
// (源码检出里的操作脚本,相对或绝对)= 不自包含。PATH 上的裸命令(无目录、无 .sh)不算。
// 编译期应把这些脚本的逻辑内联进产物。
const LOCAL_SCRIPT_DEP = /\b(?:bash|sh|source|\.)\s+["']?[^\s"';|&]*\/[^\s"';|&]*\.sh\b/;

export function containmentViolations(script: string, forbid: readonly RegExp[] = []): string[] {
  const out: string[] = [];
  if (SKILL_DEP.test(script)) out.push("运行时 read 了 ~/.claude/skills(skill 提示词应在编译期内联,运行时不该读)");
  if (LOCAL_SCRIPT_DEP.test(script)) out.push("运行时 shell-out 到本机路径下的 .sh 脚本(源码检出里的操作脚本应在编译期内联)");
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

// 订阅 pi 会话事件 → 把编译模型的实地试(bash/read/提交 + 输出 + 文本)流进日志。
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

// 让编译模型读 skill + 用 bash 实地试,最后提交一个脚本。
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

export interface CompileOpts {
  cache: CrystalCache;
  escalate: EscalationHandler;
  selfContained?: boolean; // 要求产物自包含(运行时不依赖 skill/外部仓库脚本)
  forbidRuntimeDeps?: readonly RegExp[]; // 项目侧额外禁止的运行时依赖(如外部仓库脚本路径)
  maxAttempts?: number; // 自包含/验收 自修轮数上限,默认 3
  onLog?: (m: string) => void;
  skipDangerGate?: boolean; // 调用方(runAction)已过闸时跳过,避免双重授权
  prior?: { script: string; error: string }; // 运行期结构性失效带入:旧脚本 + 报错
  baseVersion?: number; // 旧版本号(自修时递增);缺省查缓存
}

export interface CompileResult {
  script: string;
  version: number;
  output: string;
  signal: string;
  mode: "compiled" | "repaired";
}

/**
 * 编译一个动作:实地试 → 独立验收 → 自包含检查 → 落盘版本化。
 * 离线 authoring 与 运行期结构性自修 共用此函数(后者传 prior)。
 */
export async function compileAction(action: CrystallizableAction, opts: CompileOpts): Promise<CompileResult> {
  const log = opts.onLog ?? (() => {});
  const max = opts.maxAttempts ?? 3;
  const selfContained = action.selfContained ?? opts.selfContained;

  // 危险写:编译期"实地试"会真跑危险命令 → 过授权闸(除非调用方已过)。
  if (action.danger && !opts.skipDangerGate) {
    const res = await opts.escalate({ kind: "authorization", reason: `固化/运行危险动作:${action.danger}`, options: ["approve", "deny"] });
    if (res.decision !== "approve") throw new Error(`compile ${action.id} 授权被拒:${action.danger}`);
  }

  // 自包含违规 → 当作一次"验收失败",逼自修把逻辑内联(静态属性,查到就不必跑)。
  const containMsg = (script: string): string | null => {
    if (!selfContained) return null;
    const v = containmentViolations(script, opts.forbidRuntimeDeps ?? []);
    return v.length ? `脚本不自包含:${v.join(";")}。把需要的逻辑【内联/抄进】脚本,运行时别依赖 skill 或外部仓库脚本。` : null;
  };

  const baseVersion = opts.baseVersion ?? opts.cache.load(action.id)?.version ?? 0;
  let prior = opts.prior ?? null;
  const wasRepair = !!opts.prior; // 带 prior 进来 = 运行期结构性自修

  for (let attempt = 1; attempt <= max; attempt++) {
    log(`[compile:${action.id}] ${prior ? `自修第 ${attempt}/${max} 轮` : "首次编译"}……`);
    const script = await writeScript({
      nl: action.nl,
      skills: action.skills,
      cwd: action.cwd,
      selfContained,
      model: action.model,
      log,
      prior: prior ?? undefined,
    });
    if (!script) throw new Error(`compile ${action.id} 失败:编译模型没产出脚本`);

    const cv = containMsg(script);
    if (cv) {
      log(`[compile:${action.id}] ${cv} → 继续自修内联`);
      prior = { script, error: cv }; // 静态违规,不必跑,直接再修
      continue;
    }

    const out = await sh(script, { cwd: action.cwd });
    if (await action.verify(out.output)) {
      const version = baseVersion + 1;
      opts.cache.save(action.id, script, version, action.nl);
      const mode = wasRepair || attempt > 1 ? "repaired" : "compiled";
      log(`[compile:${action.id}] 独立验收通过 → 缓存 v${version}(${mode})`);
      return { script, version, output: out.output, signal: out.stdout.trim(), mode };
    }
    prior = { script, error: out.output };
  }

  const res = await opts.escalate({ kind: "error", reason: `${action.id} 编译 ${max} 次仍未过验收,升级`, payload: prior?.error.slice(0, 500) });
  throw new Error(`compile ${action.id} 失败,已升级(${res.decision})`);
}
