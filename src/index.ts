// Piper 引擎公开导出面(piper-agents 通过 `import { ... } from "piper"` 用)。
// 只导出通用厚层 + 通用机制;不含任何项目专属薄层(那些住 piper-agents)。

// 执行与会话
export { sh, type ShResult } from "./sh.ts";
export {
  type CheapModelSpec,
  type SessionFactory,
  type SessionOpts,
  createPiSession,
  getBackend,
  setBackend,
} from "./session.ts";

// 客观验收
export { type Check, type CheckResult, shellCheck, fnCheck } from "./check.ts";

// 控制流原语
export {
  type GoalOptions,
  type GoalResult,
  type GoalStatus,
  type GoalEvent,
  type WorkerEvent,
  type Dispatch,
  type DispatchInput,
  type DispatchResult,
  goal as goalLoop, // 运行时外环原语(声明式 builder goal 见下)
  piDispatch,
  subscribeWorkerEvents,
} from "./goal.ts";
export {
  type LoopOptions,
  type LoopResult,
  type TickContext,
  type TickResult as LoopTickResult,
  loop as scheduleLoop, // 运行时定时调度(声明式 builder loop 见下)
} from "./loop.ts";

// test-time compute
export {
  type BestOfNResult,
  type DebateResult,
  type StructuredWorkerOpts,
  structuredWorker,
  bestOfN,
  debate,
} from "./ttc.ts";

// 升级
export {
  type Escalation,
  type EscalationHandler,
  type EscalationKind,
  type EscalationResolution,
  authorizationGate,
  consoleEscalation,
  denyByDefault,
  resolveOrEscalate,
  selfManagedGate,
} from "./escalate.ts";

// 观测
export { type Observer, consoleObserver, fileObserver, makeRunDir, mergeObservers } from "./observe.ts";

// spec 引擎
export { type AgentSpec, type Stage, type StageResult, type Remediation, runSpec } from "./spec.ts";

// 通用验证器
export { type GitDiffTouchesResult, gitDiffTouches } from "./verifiers/git.ts";

// 通用 GitLab 只读访问
export { type GitlabReader, type Job, type Pipeline, gitlabReader } from "./ci/gitlab.ts";

// ===== 蒸馏式 agent 原语面(loop/goal/panel/guard + 固化 + YAML)=====
// panel:一组独立判官(活的判断)
export { type PanelOpts, type PanelResult, type Verdict, panel } from "./panel.ts";
// crystallize:把机械意图固化成可复用脚本 + 自修
export {
  type CrystallizableAction,
  type CrystalCache,
  type CrystallizeResult,
  containmentViolations,
  crystallize,
  fileCache,
} from "./crystallize.ts";
// agent 节点模型 + TS builder + 运行时
export {
  type AgentDef,
  type GoalDef,
  type GuardRule,
  type PanelDef,
  type RunDeps,
  type TickResult,
  type VerifyDef,
  agent,
  check,
  goal,
  loop,
  panelOf,
  runAgent,
  runSentinel,
} from "./agent.ts";
// YAML loader(与 TS builder 等价)
export { loadAgentYaml } from "./yaml.ts";
