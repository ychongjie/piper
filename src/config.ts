// piper 的【部署配置】:网关(URL / api 类型 / api-key 环境变量)+ 标准模型名→网关模型 id 的映射。
// 这是数据,不是代码——引擎代码仍零耦合;具体网关(baizhi 等)只在这份配置里。
// agent YAML 只引用【标准模型名】,避免不同网关对同一模型命名不一致。
// 配置文件位置:$PIPER_CONFIG,否则 ~/.piper/config.json。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheapModelSpec } from "./session.ts";

export interface GatewayConfig {
  base_url: string;
  api: string; // pi 的 api 类型(如 anthropic-messages)
  api_key_env: string; // 鉴权 key 的环境变量名(不写明文)
  models: Record<string, string>; // 标准模型名 → 该网关的真实模型 id
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
}
export interface PiperConfig {
  default_model: string;
  gateways: Record<string, GatewayConfig>;
}

let _cfg: PiperConfig | null = null;

function configPath(): string {
  return process.env.PIPER_CONFIG ?? join(homedir(), ".piper", "config.json");
}

export function loadPiperConfig(): PiperConfig {
  if (_cfg) return _cfg;
  const p = configPath();
  if (!existsSync(p)) throw new Error(`缺 piper 配置文件:${p}(配网关 + 标准模型名映射;见 PiperConfig)`);
  _cfg = JSON.parse(readFileSync(p, "utf8")) as PiperConfig;
  return _cfg;
}

/** 测试用:直接注入配置,绕过文件。 */
export function setPiperConfig(cfg: PiperConfig | null): void {
  _cfg = cfg;
}

/** 标准模型名 →(查配置网关)→ 便宜模型接入规格。缺省用 default_model。未知模型 → 报错。 */
export function resolveModel(standardName?: string): CheapModelSpec {
  const cfg = loadPiperConfig();
  const name = standardName ?? cfg.default_model;
  for (const [provider, g] of Object.entries(cfg.gateways)) {
    const modelId = g.models[name];
    if (!modelId) continue;
    const apiKey = process.env[g.api_key_env];
    if (!apiKey) throw new Error(`网关 ${provider} 的 key 环境变量 ${g.api_key_env} 未设`);
    return {
      provider,
      baseUrl: g.base_url,
      apiKey,
      api: g.api,
      modelId,
      modelName: name,
      contextWindow: g.context_window,
      maxTokens: g.max_tokens,
      reasoning: g.reasoning ?? true,
    };
  }
  const known = Object.values(cfg.gateways).flatMap((g) => Object.keys(g.models));
  throw new Error(`未知模型 '${name}'(piper 配置里没有)。已配的标准模型名:${[...new Set(known)].join(", ")}`);
}
