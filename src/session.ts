// 便宜模型会话:通用机制(进程内注册自定义 provider + 起 pi 会话)+ 可注入的"当前后端"。
// 具体用哪个网关/模型由 piper 配置文件(~/.piper/config.json)定;按【标准模型名】解析(见 config.ts)。
// 引擎代码零耦合:不知道有 baizhi,只认"标准名 → 规格"。pi 固定不抽象框架。

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

// ---- 按【标准模型名】解析后端(查 piper 配置)----
import { resolveModel } from "./config.ts"; // 仅运行时;config.ts 对 session 是 type-only 引用,无循环

let _override: SessionFactory | null = null;

/** 测试用:注入假后端,绕过配置文件。 */
export function setBackendOverride(f: SessionFactory | null): void {
  _override = f;
}

/** 按标准模型名取后端工厂:查 piper 配置 → 网关+真实模型 id → 起 pi 会话。缺省用 default_model。 */
export function backendForModel(model?: string): SessionFactory {
  if (_override) return _override;
  const spec = resolveModel(model);
  return (opts) => createPiSession(spec, opts);
}
