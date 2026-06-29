// Piper 公开导出面 —— v2 活引擎 + 共享基础设施(会话/模型配置)。
// agent 编排词汇与执行语义见 DESIGN.md;蒸馏出 YAML 跑在 pi + 便宜模型上。

// ── v2 引擎(YAML 活解释:loop/do/list/fanout/verify/intent/tools/labels/when)──
export { type AgentV2, loadAgentV2, runOnce } from "./v2/run.ts";
export {
  type FanoutNode,
  type LeafNode,
  type Node,
  type NodeResult,
  type RunCtx,
  runNode,
} from "./v2/engine.ts";

// ── 会话后端(进程内注册便宜模型 provider,不碰全局 pi 配置)──
export {
  type CheapModelSpec,
  type SessionFactory,
  type SessionOpts,
  backendForModel,
  createPiSession,
  setBackendOverride,
} from "./session.ts";

// ── 模型/网关配置(标准模型名 → 网关 modelId)──
export {
  type GatewayConfig,
  type PiperConfig,
  loadPiperConfig,
  resolveModel,
  setPiperConfig,
} from "./config.ts";
