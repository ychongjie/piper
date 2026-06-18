// agent YAML 的【唯一权威词汇】—— 封闭 schema,每层 additionalProperties:false。
// 写 YAML 时新增/拼错任何键 → 加载即报错。项目专属语义只能进【NL 值】(被 crystallize 固化),
// 永远进不了关键字。要加通用新能力,必须先改这里(刻意、可审)。
import { Type } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false };

// do 的一步(声明式)。verify 是对 stdout 的正则契约(机械门);厚判断走 panel。
const Step = Type.Object(
  {
    id: Type.String(),
    nl: Type.String(),
    using: Type.Optional(Type.Array(Type.String())),
    model: Type.Optional(Type.String()), // 标准模型名(查 piper 配置;覆盖 do.model)
    cwd: Type.Optional(Type.String()),
    danger: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    self_contained: Type.Optional(Type.Boolean()),
    verify: Type.Optional(Type.String()), // 对 stdout 的正则;缺省=非空
  },
  closed,
);

const Panel = Type.Object(
  {
    n: Type.Integer({ minimum: 1 }),
    judge: Type.String(),
    ground: Type.Array(Type.String()),
    labels: Type.Optional(Type.Array(Type.String())),
    escalate_if: Type.Optional(Type.String()),
  },
  closed,
);

const Verify = Type.Union([
  Type.Object({ check: Type.String() }, closed),
  Type.Object({ panel: Panel }, closed),
]);

const Do = Type.Object(
  {
    goal: Type.String(),
    using: Type.Optional(Type.Array(Type.String())),
    model: Type.Optional(Type.String()), // 默认标准模型名(触发器 + 各 step 缺省用它)
    steps: Type.Optional(Type.Array(Step)), // 声明式多步;缺省=把 goal 当单步
    verify: Verify,
  },
  closed,
);

// 自管闸(声明式):owns=认领"本 agent 自管资源"的正则;budget=预算内自动放行次数。
const Guard = Type.Object(
  {
    owns: Type.Optional(Type.String()),
    budget: Type.Optional(Type.Integer({ minimum: 0 })),
    rules: Type.Optional(Type.Array(Type.Object({ when: Type.String(), require: Type.String() }, closed))),
  },
  closed,
);

const Loop = Type.Object(
  {
    on: Type.String(),
    // 触发器输出 → build id 的契约(封闭枚举);缺省=非空。
    signal: Type.Optional(Type.Union([Type.Literal("commit-sha"), Type.Literal("package-version"), Type.Literal("nonempty")])),
    every: Type.Optional(Type.String()),
    do: Do,
  },
  closed,
);

export const AgentYamlSchema = Type.Object(
  {
    agent: Type.String(),
    distilled_from: Type.Optional(
      Type.Object({ sessions: Type.Optional(Type.Array(Type.String())), skills: Type.Optional(Type.Array(Type.String())) }, closed),
    ),
    forbid_runtime_deps: Type.Optional(Type.Array(Type.String())), // 自包含禁则(正则字符串)
    loop: Loop,
    guard: Type.Optional(Guard),
  },
  closed,
);

export class AgentSchemaError extends Error {}

// 精确定位未知键(typebox 对 additionalProperties 违规只报到父层,这里走 schema 树报到具体键)。
function findUnknownKey(schema: any, value: any, path: string): { path: string; allowed: string[] } | null {
  if (!schema || value === null || typeof value !== "object") return null;
  if (schema.anyOf) {
    for (const v of schema.anyOf) if (Value.Check(v, value)) return null; // 干净命中某变体
    return null; // 没干净命中 → 交给 typebox 报类型错
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const sub = findUnknownKey(schema.items, value[i], `${path}[${i}]`);
      if (sub) return sub;
    }
    return null;
  }
  if (schema.type === "object" && schema.properties) {
    const allowed = Object.keys(schema.properties);
    for (const k of Object.keys(value)) if (!allowed.includes(k)) return { path: path ? `${path}.${k}` : k, allowed };
    for (const k of allowed) {
      if (value[k] !== undefined) {
        const sub = findUnknownKey(schema.properties[k], value[k], path ? `${path}.${k}` : k);
        if (sub) return sub;
      }
    }
  }
  return null;
}

/** 严格校验已 parse 的 YAML 对象。未知键/错类型/缺必填 → 抛 AgentSchemaError(含精确路径)。 */
export function validateAgentYaml(parsed: unknown): void {
  if (Value.Check(AgentYamlSchema, parsed)) return;
  const unknown = findUnknownKey(AgentYamlSchema, parsed, "");
  if (unknown) {
    throw new AgentSchemaError(
      `agent YAML 不合法:未知键 '${unknown.path}'(词汇是封闭的——项目专属语义请写进 NL 值,不要新增关键字)。\n  该层允许的键:${unknown.allowed.join(", ")}`,
    );
  }
  const lines = [...Value.Errors(AgentYamlSchema, parsed)].slice(0, 6).map((e) => `  ${e.path || "(根)"}: ${e.message}`);
  throw new AgentSchemaError(`agent YAML 不合法(类型/必填错):\n${lines.join("\n")}`);
}
