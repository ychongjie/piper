// Piper 引擎公开导出面(piper-agents 通过 `import { ... } from "piper"` 用)。
// 只导出通用厚层 + 通用机制;不含任何项目专属薄层(那些住 piper-agents)。

// 执行与会话
export { sh, type ShResult } from "./sh.ts";
export {
  type CheapModelSpec,
  type SessionFactory,
  type SessionOpts,
  backendForModel,
  createPiSession,
  setBackendOverride,
} from "./session.ts";
// 部署配置:网关 + 标准模型名映射(数据,不是代码)
export { type GatewayConfig, type PiperConfig, loadPiperConfig, resolveModel, setPiperConfig } from "./config.ts";

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
// 编译阶段:把机械意图固化成自包含脚本(离线 / 运行期结构性自修共用)
export {
  type CrystallizableAction,
  type CrystalCache,
  type CompiledScript,
  type CompileOpts,
  type CompileResult,
  type Lock,
  type LockEntry,
  compileAction,
  containmentViolations,
  fileCache,
  migrateCache,
  readLock,
} from "./compile.ts";
// 执行阶段:跑已编译产物(命中=0 大模型调用)+ 瞬态重试 + 结构性自修
export {
  type RunResult,
  type RunOpts,
  type CrystallizeResult,
  NeedsCompileError,
  runAction,
  crystallize, // 惰性一体路径(dev/测试):= runAction({compileIfMissing:true})
} from "./execute.ts";
// agent 节点模型 + TS builder + 运行时
export {
  type AgentDef,
  type GoalDef,
  type GuardDef,
  type JudgeDef,
  type RunDeps,
  type StepDef,
  type TickResult,
  agent,
  compileAgent,
  goal,
  judgeOf,
  loop,
  runAgent,
  runSentinel,
} from "./agent.ts";
// YAML loader(与 TS builder 等价)+ 封闭词汇 schema
export { loadAgentYaml } from "./yaml.ts";
export { AgentSchemaError, AgentYamlSchema, validateAgentYaml } from "./agent-schema.ts";
