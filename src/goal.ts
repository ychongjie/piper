// goal:客观验收外环 —— Piper 厚层的地基。
// 验收 → 失败就派 worker(便宜模型)→ 再客观验收 → 失败带反馈重派,直到通过或步数用尽。
// worker 能力外包给 pi;goal 只做控制平面:循环、反馈、预算、不信自报。
//
// worker 派发(dispatch)可注入:默认用当前后端(便宜模型),测试注入 mock 不花钱。

import type { Check } from "./check.ts";
import { backendForModel } from "./session.ts";

export type GoalStatus = "already-done" | "success" | "exhausted";

export interface GoalResult {
  status: GoalStatus;
  steps: number; // 实际派出的 worker 轮数
  checkOutput: string; // 末次验收输出
}

// worker 工作过程的归一化事件(piDispatch 从 pi 事件流映射而来,供观测层消费)。
export type WorkerEvent =
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; isError: boolean; resultText: string }
  | { type: "usage"; input: number; output: number; cost: number };

// goal 外环自身的事件(派发/验收/收尾),供观测层消费。
export type GoalEvent =
  | { type: "check"; phase: "initial" | "after-step"; step: number; ok: boolean; output: string }
  | { type: "dispatch-start"; step: number; max: number; prompt: string }
  | { type: "dispatch-end"; step: number; workerText: string }
  | { type: "done"; status: GoalStatus; steps: number };

export interface DispatchInput {
  prompt: string;
  step: number;
  cwd?: string;
  tools?: string[];
  onWorkerEvent?: (e: WorkerEvent) => void;
}

export interface DispatchResult {
  output: string; // worker 的最终文本(仅供日志,不用于验收)
}

export type Dispatch = (input: DispatchInput) => Promise<DispatchResult>;

export interface GoalOptions {
  goal: string; // 目标描述
  check: Check; // 客观验收
  checkLabel?: string; // 写进 prompt 的验收描述(默认取 check.label)
  maxSteps?: number; // 预算,默认 5
  cwd?: string; // worker 工作目录
  tools?: string[]; // worker 可用 pi 工具
  dispatch?: Dispatch; // 可注入 worker;默认按配置默认模型(backendForModel)起 pi 会话
  onLog?: (msg: string) => void;
  onEvent?: (e: GoalEvent) => void; // goal 外环事件(观测层用)
  onWorkerEvent?: (e: WorkerEvent) => void; // worker 工作过程事件(透传给 dispatch)
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** 把一个 pi 会话的事件流映射成 WorkerEvent(piDispatch 与 ttc 的 structuredWorker 共用)。 */
export function subscribeWorkerEvents(session: any, emit: (e: WorkerEvent) => void): void {
  session.subscribe((e: any) => {
    switch (e.type) {
      case "message_update": {
        const a = e.assistantMessageEvent;
        if (a.type === "text_delta") emit({ type: "text_delta", delta: a.delta });
        else if (a.type === "thinking_delta") emit({ type: "thinking_delta", delta: a.delta });
        break;
      }
      case "tool_execution_start":
        emit({ type: "tool_start", id: e.toolCallId, name: e.toolName, args: e.args });
        break;
      case "tool_execution_end": {
        const resultText = (e.result?.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        emit({ type: "tool_end", id: e.toolCallId, name: e.toolName, isError: !!e.isError, resultText });
        break;
      }
      case "message_end": {
        const m = e.message;
        if (m?.role === "assistant" && m.usage) {
          emit({ type: "usage", input: m.usage.input ?? 0, output: m.usage.output ?? 0, cost: m.usage.cost?.total ?? 0 });
        }
        break;
      }
    }
  });
}

/** 默认 worker:用当前注入的后端起一个 pi 会话干活,并把 pi 事件流映射成 WorkerEvent。 */
export const piDispatch: Dispatch = async ({ prompt, cwd, tools, onWorkerEvent }) => {
  const { session } = await backendForModel()({ cwd, tools: tools ?? DEFAULT_TOOLS });
  let text = "";
  subscribeWorkerEvents(session, (e) => {
    if (e.type === "text_delta") text += e.delta;
    onWorkerEvent?.(e);
  });
  await session.prompt(prompt);
  return { output: text };
};

function tail(s: string, n: number): string {
  return s.length <= n ? s : `……(前略)\n${s.slice(-n)}`;
}

function renderPrompt(o: {
  goal: string;
  checkLabel: string;
  step: number;
  max: number;
  lastOutput?: string;
}): string {
  // 重试轮(step>1)一定带上一轮失败反馈;首轮只在初始验收有输出时带(test -f 这类无输出就不带)。
  const hasOutput = (o.lastOutput?.trim().length ?? 0) > 0;
  const showFeedback = o.step > 1 || hasOutput;
  const feedbackBody = hasOutput ? tail(o.lastOutput as string, 4000) : "(验收命令无输出)";
  return [
    "你是被派来达成目标的编码 agent,在当前目录直接动手干活。",
    `目标:${o.goal}`,
    `客观验收:运行 \`${o.checkLabel}\`,退出码必须为 0(不靠你自报,我会自己独立验)。`,
    `本次是第 ${o.step}/${o.max} 轮尝试。`,
    showFeedback
      ? `上一轮验收失败,输出(截尾)如下:\n\`\`\`\n${feedbackBody}\n\`\`\`\n请针对失败原因修复。`
      : "",
    // 便宜模型需要把"用工具落地"说死,否则会读完+思考就停手、不真正改文件。
    "怎么做:",
    "1. 用 read 看相关文件;",
    `2. **必须用 edit 或 write 工具把修改实际写入文件**——只描述改动不算,不写就等于没做;`,
    `3. 用 bash 跑 \`${o.checkLabel}\` 自检;`,
    "4. 只改与目标相关的部分;在验收命令退出码为 0 之前不要结束。",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function goal(opts: GoalOptions): Promise<GoalResult> {
  const max = opts.maxSteps ?? 5;
  const dispatch = opts.dispatch ?? piDispatch;
  const checkLabel = opts.checkLabel ?? opts.check.label ?? "验收命令";
  const log = opts.onLog ?? (() => {});
  const emit = opts.onEvent ?? (() => {});

  // 先客观验收:本来就过就别派 worker。
  const first = await opts.check();
  emit({ type: "check", phase: "initial", step: 0, ok: first.ok, output: first.output });
  if (first.ok) {
    log("验收本来就通过,无需派 worker。");
    emit({ type: "done", status: "already-done", steps: 0 });
    return { status: "already-done", steps: 0, checkOutput: first.output };
  }

  let lastOutput = first.output;
  for (let step = 1; step <= max; step++) {
    log(`第 ${step}/${max} 轮:派 worker……`);
    const prompt = renderPrompt({ goal: opts.goal, checkLabel, step, max, lastOutput });
    emit({ type: "dispatch-start", step, max, prompt });
    const r = await dispatch({ prompt, step, cwd: opts.cwd, tools: opts.tools, onWorkerEvent: opts.onWorkerEvent });
    emit({ type: "dispatch-end", step, workerText: r.output });
    log(`  worker 返回 ${r.output.length} 字,开始客观验收……`);

    const res = await opts.check(); // 不信 worker 自报,自己再验一遍
    emit({ type: "check", phase: "after-step", step, ok: res.ok, output: res.output });
    if (res.ok) {
      log(`✓ 第 ${step} 轮后验收通过。`);
      emit({ type: "done", status: "success", steps: step });
      return { status: "success", steps: step, checkOutput: res.output };
    }
    lastOutput = res.output;
    log(`  验收未通过,带反馈进入下一轮。`);
  }

  log(`✗ 步数用尽(${max} 轮),未达成。`);
  emit({ type: "done", status: "exhausted", steps: max });
  return { status: "exhausted", steps: max, checkOutput: lastOutput };
}
