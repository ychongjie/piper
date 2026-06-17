// 便宜模型会话:通用机制(进程内注册自定义 provider + 起 pi 会话)+ 可注入的"当前后端"。
// 引擎只认这个抽象;具体用哪个网关/模型(baizhi 等)由调用方(piper-agents)通过 setBackend 注入。
// 形如旧 Racket 的 current-agent:厚层不绑死后端。

import {
  AuthStorage,
  type CreateAgentSessionOptions,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

// 一个便宜模型的接入规格(provider/网关/模型),值由部署方提供。
export interface CheapModelSpec {
  provider: string; // 进程内 provider 名(如 "baizhi")
  baseUrl: string; // 网关根
  apiKey: string; // 鉴权 key
  api: string; // pi 的 api 类型(如 "anthropic-messages")
  modelId: string; // 模型 id
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export type SessionOpts = Omit<CreateAgentSessionOptions, "model" | "authStorage" | "modelRegistry">;
export type SessionFactory = (opts?: SessionOpts) => Promise<{ session: any }>;

/** 通用:把一个便宜模型规格注册到【进程内】ModelRegistry(不碰全局),起一个 pi 会话。 */
export async function createPiSession(spec: CheapModelSpec, opts: SessionOpts = {}) {
  const authStorage = AuthStorage.create(); // 读全局 auth/models 只读
  const modelRegistry = ModelRegistry.create(authStorage);
  modelRegistry.registerProvider(spec.provider, {
    name: spec.modelName ?? spec.provider,
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    api: spec.api as any,
    models: [
      {
        id: spec.modelId,
        name: spec.modelName ?? spec.modelId,
        reasoning: spec.reasoning ?? true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: spec.contextWindow ?? 128_000,
        maxTokens: spec.maxTokens ?? 8192,
      },
    ],
  });
  const model = modelRegistry.find(spec.provider, spec.modelId);
  if (!model) throw new Error(`注册后找不到模型 ${spec.provider}/${spec.modelId}`);
  return createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: opts.sessionManager ?? SessionManager.inMemory(),
    ...opts,
  });
}

// ---- 可注入的"当前后端" ----
let _backend: SessionFactory | null = null;

/** 注入便宜模型后端(piper-agents 启动时调一次,如 setBackend(createBaizhiSession))。 */
export function setBackend(f: SessionFactory): void {
  _backend = f;
}

/** 取当前后端(goal/ttc 派 worker 用)。没注入就报错——引擎不替你决定用哪个模型。 */
export function getBackend(): SessionFactory {
  if (!_backend) throw new Error("未注入后端:先调用 setBackend(...)(如 piper-agents 的 createBaizhiSession)");
  return _backend;
}
