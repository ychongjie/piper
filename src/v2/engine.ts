// Piper v2 引擎(按 DESIGN.md):活叶子 + tools 注入 + 续会话收敛 + fanout 投票 + when 机械配 label。
// 节点 = 裸串/叶子对象 | {fanout} | 列表(=顺序)。运行期用 pi + 便宜模型,活 agent 跑。
//
// 复用:backendForModel(起 pi 会话)、defineTool(submit_result/verdict)、Type(schema)。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { backendForModel } from "../session.ts";

// ── 节点类型(plain object,从 YAML parse 来)──────────────────────────────
export interface LeafNode {
  intent?: string;
  verify?: string | { intent: string; ground?: string[]; n?: number };
  budget?: number;
  labels?: string[]; // 有 labels → 判官叶子,产出 {label,confidence,evidence}
  model?: string;
  tools?: string[]; // 自包含工具脚本名(<agent>.tools/<name>.sh)
  using?: string[];
  cwd?: string;
  when?: string; // 机械:紧邻上一步 label == 此值才跑
}
export interface FanoutNode {
  fanout: {
    when?: string;
    over: Array<{ model?: string; intent?: string }>;
    intent?: string;
    gather: { how: "vote" | "merge"; labels?: string[]; intent?: string; model?: string };
    concurrency?: number;
  };
}
export type Node = string | LeafNode | FanoutNode | Node[];

export interface NodeResult {
  label?: string; // 判官叶子 / fanout:vote 的结论(供 when 机械匹配)
  result: string; // 结果文本(verify 匹配它、下一步读它)
  status?: "done" | "blocked" | "skipped";
  raw?: any; // {label,confidence,evidence} 或 {status,result}
}

export interface RunCtx {
  cwd?: string;
  toolsDir?: string; // <agent>.tools
  onLog: (m: string) => void;
  prior: NodeResult | null; // 紧邻上一步结果(供 when + 上下文)
  history: string[]; // 累积上下文(前几步的 result),喂给后续 agent
}

const expandHome = (p?: string): string | undefined => p?.replace(/^(~|\$HOME)(?=\/|$)/, homedir());
const isFanout = (n: Node): n is FanoutNode => typeof n === "object" && !Array.isArray(n) && "fanout" in n;
const isLeaf = (n: Node): n is LeafNode => typeof n === "object" && !Array.isArray(n) && !("fanout" in n);

// ── tools 自文档:读 <agent>.tools/<name>.sh 头部注释,拼成"你可用的工具"前言 ──
function toolDoc(toolsDir: string, name: string): string {
  const f = join(toolsDir, `${name}.sh`);
  if (!existsSync(f)) return `- ${name}:(脚本缺失:${f})`;
  const head = readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("#"))
    .slice(0, 12)
    .map((l) => l.replace(/^#\s?/, ""))
    .join(" ");
  return `- ${name}(bash ${f}):${head}`;
}
function injectTools(ctx: RunCtx, tools?: string[]): string {
  if (!tools?.length || !ctx.toolsDir) return "";
  return ["你可用的工具(自包含脚本,直接 bash 调;不要自己现搭逻辑):", ...tools.map((t) => toolDoc(ctx.toolsDir as string, t))].join("\n");
}

// ── 从 pi 会话事件流抽文本 + 流进日志 ──────────────────────────────────────
const brief = (s: any, n = 400): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const textOf = (x: any): string => {
  const c = x?.content ?? x?.message?.content;
  return Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join(" ") : typeof x === "string" ? x : "";
};
function observe(session: any, log: (m: string) => void): () => void {
  if (typeof session?.subscribe !== "function") return () => {};
  return session.subscribe((ev: any) => {
    try {
      if (ev.type === "tool_execution_start") log(`    ⎯ ${ev.toolName}: ${brief(ev.args?.command ?? ev.args?.path ?? "", 220)}`);
      else if (ev.type === "tool_execution_end") log(`    ⎿ ${ev.isError ? "✗" : "✓"} ${brief(textOf(ev.result), ev.isError ? 800 : 300)}`);
      else if (ev.type === "message_end") { const t = brief(textOf(ev.message)); if (t) log(`    · ${t}`); }
    } catch {}
  });
}

// ── 活叶子:起一个 pi 会话,注入 tools 文档 + 上下文,续会话直到 verify 过 / budget ──
async function runLeaf(leaf: LeafNode, ctx: RunCtx): Promise<NodeResult> {
  const cwd = expandHome(leaf.cwd) ?? ctx.cwd;
  const isJudge = !!leaf.labels?.length;

  // capture 工具:判官 submit_verdict;干活 submit_result。
  let captured: any = null;
  const capture = isJudge
    ? defineTool({
        name: "submit_verdict",
        label: "提交结论",
        description: "调查清楚后提交 {label, confidence, evidence}。",
        parameters: Type.Object({
          label: Type.Union((leaf.labels as string[]).map((l) => Type.Literal(l)) as any),
          confidence: Type.Union([Type.Literal("high"), Type.Literal("low")]),
          evidence: Type.Array(Type.String()),
        }),
        execute: async (_id: string, p: any) => { captured = p; return { content: [{ type: "text", text: "已记录" }], details: {}, terminate: true }; },
      })
    : defineTool({
        name: "submit_result",
        label: "提交结果",
        description: "干完后提交 {status, result}。status=done(完成)/blocked(卡住需升级);result=结果文本(含关键输出)。",
        parameters: Type.Object({ status: Type.Union([Type.Literal("done"), Type.Literal("blocked")]), result: Type.String() }),
        execute: async (_id: string, p: any) => { captured = p; return { content: [{ type: "text", text: "已记录" }], details: {}, terminate: true }; },
      });

  const builtin = ["read", "bash"];
  const { session } = await backendForModel(leaf.model)({ cwd, tools: [...builtin, capture.name], customTools: [capture] });
  const unobserve = observe(session, ctx.onLog);

  const head = [
    leaf.intent ?? "",
    injectTools(ctx, leaf.tools),
    ctx.history.length ? `已知上下文(前面步骤的结果):\n${ctx.history.slice(-3).join("\n---\n")}` : "",
    isJudge
      ? `调查清楚后调用 submit_verdict 提交 {label∈[${(leaf.labels as string[]).join("/")}], confidence, evidence};evidence 每条引用实际取证输出。`
      : "干完后调用 submit_result 提交 {status, result};result 要含关键输出(供后续验收/判断)。",
  ].filter(Boolean).join("\n\n");

  const budget = isJudge ? 1 : (leaf.budget ?? 1);
  let lastVerify = "";
  try {
    for (let round = 1; round <= budget; round++) {
      captured = null;
      const prompt = round === 1 ? head : `验收未通过,输出(截尾):\n${lastVerify.slice(-1500)}\n请针对原因继续(同一环境/上下文,别重头来),再 submit_result。`;
      ctx.onLog(`  叶子第 ${round}/${budget} 轮……`);
      await session.prompt(prompt);
      if (!captured) { lastVerify = "(没 submit 结果)"; continue; }
      if (isJudge) return { label: captured.label, result: JSON.stringify(captured), status: "done", raw: captured };
      // 干活:跑 verify
      const vres = await runVerify(leaf.verify, captured.result, ctx, leaf.model);
      if (vres.ok) { ctx.onLog(`  ✓ 验收通过`); return { result: captured.result, status: captured.status, raw: captured }; }
      lastVerify = vres.output;
      ctx.onLog(`  ✗ 验收未过:${brief(vres.output, 200)}`);
      if (captured.status === "blocked") break;
    }
  } finally { unobserve(); }
  return { result: captured?.result ?? lastVerify, status: "blocked", raw: captured };
}

// ── verify:机械(正则匹配 result)或 判官(独立 agent 实地查 → pass/fail)──
async function runVerify(
  verify: LeafNode["verify"],
  result: string,
  ctx: RunCtx,
  model?: string,
): Promise<{ ok: boolean; output: string }> {
  if (!verify) return { ok: result.trim().length > 0, output: result };
  if (typeof verify === "string") {
    const ok = new RegExp(verify).test(result);
    return { ok, output: ok ? "(机械门通过)" : `result 不匹配 /${verify}/:\n${result.slice(-800)}` };
  }
  // 判官 verify:独立 agent(执行者≠判官),只读取证后判 pass/fail
  let v: any = null;
  const submit = defineTool({
    name: "submit_check",
    label: "提交验收",
    description: "实地查清后提交 {pass:bool, reason}。",
    parameters: Type.Object({ pass: Type.Boolean(), reason: Type.String() }),
    execute: async (_id: string, p: any) => { v = p; return { content: [{ type: "text", text: "已记录" }], details: {}, terminate: true }; },
  });
  const { session } = await backendForModel(model)({ cwd: ctx.cwd, tools: ["read", "bash", "submit_check"], customTools: [submit] });
  const un = observe(session, (m) => ctx.onLog(`    [verify]${m}`));
  try {
    await session.prompt([
      "你是【独立验收判官】(不是执行者)。只读取证,判断下面这步是否真达成。",
      `验收要点:${verify.intent}`,
      verify.ground?.length ? `取证手段:${verify.ground.join("、")}` : "",
      `执行者自报的结果:\n${result.slice(0, 2000)}`,
      "用 read/bash 只读核实(别改任何东西),然后 submit_check 提交 {pass, reason}。",
    ].filter(Boolean).join("\n"));
  } finally { un(); }
  return { ok: !!v?.pass, output: v?.reason ?? "(判官没提交)" };
}

// ── fanout:over 各份(并发到 concurrency)→ gather:vote 多数票 / merge ──
async function runFanout(node: FanoutNode, ctx: RunCtx): Promise<NodeResult> {
  const f = node.fanout;
  if (f.when && ctx.prior?.label !== f.when) {
    ctx.onLog(`  fanout when=${f.when} ≠ 上一步 label(${ctx.prior?.label ?? "无"})→ 跳过`);
    return { result: `(skipped: when ${f.when})`, status: "skipped" };
  }
  const branches = f.over.map((ov, i) => async (): Promise<NodeResult> => {
    const leaf: LeafNode = {
      intent: [f.intent, ov.intent].filter(Boolean).join("\n本份侧重:"),
      labels: f.gather.labels,
      model: ov.model,
    };
    ctx.onLog(`  fanout 份 ${i + 1}/${f.over.length}${ov.model ? `(${ov.model})` : ""}……`);
    return runLeaf(leaf, ctx);
  });
  // 并发上限
  const cap = f.concurrency ?? branches.length;
  const results: NodeResult[] = [];
  for (let i = 0; i < branches.length; i += cap) {
    const batch = await Promise.all(branches.slice(i, i + cap).map((b) => b().catch((e) => ({ result: `err:${(e as Error).message}`, status: "blocked" as const }))));
    results.push(...batch);
  }
  if (f.gather.how === "vote") {
    const tally: Record<string, number> = {};
    for (const r of results) if (r.label) tally[r.label] = (tally[r.label] ?? 0) + 1;
    let win = "", best = 0;
    for (const [k, v] of Object.entries(tally)) if (v > best) { best = v; win = k; }
    ctx.onLog(`  fanout vote:票数=${JSON.stringify(tally)} → ${win}`);
    return { label: win, result: `vote=${win} 票数=${JSON.stringify(tally)}\n` + results.map((r) => r.result).join("\n---\n"), status: "done" };
  }
  // merge:派一个合并者
  const merged = await runLeaf({ intent: `${f.gather.intent ?? "合并下面各份"}\n\n各份:\n${results.map((r) => r.result).join("\n---\n")}`, model: f.gather.model }, ctx);
  return merged;
}

// ── 列表 = 顺序:逐节点跑,prior/history 线程下去 ───────────────────────────
async function runList(list: Node[], ctx: RunCtx): Promise<NodeResult> {
  let last: NodeResult = { result: "", status: "done" };
  for (const n of list) {
    const r = await runNode(n, ctx);
    ctx.prior = r;
    if (r.status !== "skipped") ctx.history.push(r.result.slice(0, 2000));
    last = r;
  }
  return last;
}

export async function runNode(node: Node, ctx: RunCtx): Promise<NodeResult> {
  if (typeof node === "string") return runLeaf({ intent: node }, ctx);
  if (Array.isArray(node)) return runList(node, ctx);
  if (isFanout(node)) return runFanout(node, ctx);
  // 叶子:先看 when(对紧邻上一步)
  if (isLeaf(node) && node.when && ctx.prior?.label !== node.when) {
    ctx.onLog(`  叶子 when=${node.when} ≠ 上一步 label → 跳过`);
    return { result: `(skipped: when ${node.when})`, status: "skipped" };
  }
  return runLeaf(node as LeafNode, ctx);
}
