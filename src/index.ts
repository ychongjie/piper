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
  goal,
  piDispatch,
  subscribeWorkerEvents,
} from "./goal.ts";
export { type LoopOptions, type LoopResult, type TickContext, type TickResult, loop } from "./loop.ts";

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
} from "./escalate.ts";

// 观测
export { type Observer, consoleObserver, fileObserver, makeRunDir, mergeObservers } from "./observe.ts";

// spec 引擎
export { type AgentSpec, type Stage, type StageResult, type Remediation, runSpec } from "./spec.ts";

// 通用验证器
export { type GitDiffTouchesResult, gitDiffTouches } from "./verifiers/git.ts";

// 通用 GitLab 只读访问
export { type GitlabReader, type Job, type Pipeline, gitlabReader } from "./ci/gitlab.ts";
