#!/usr/bin/env bun
// piper CLI:把三阶段收口成子命令。
//   distill   起草 / 模板:蒸馏是 Claude Code 的活(读 sessions/memory/skills → YAML),这里给骨架 + 指路 skill。
//   validate  封闭词汇严格校验一份 agent.yaml(未知键/错类型即报)。
//   compile   编译阶段:把触发器 + 所有 step 固化成自包含 .sh,落进 cache(入仓 review)。
//   run       执行阶段(单 tick,严格只跑产物)。
//   watch     执行阶段(常驻哨兵:定时探构建 → 去重 → 跑 do)。
//
// run/watch 需要项目侧注入(panel 取证工具 / 待判用例 / cwd):--inject <module.ts>,默认导出 ProjectInject。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentSchemaError,
  type RunDeps,
  compileAgent,
  consoleEscalation,
  denyByDefault,
  fileCache,
  loadAgentYaml,
  runAgent,
  runSentinel,
} from "../src/index.ts";

// 项目侧注入(run/watch 用):panel ground / 待判用例 / 工作目录。全可选。
interface ProjectInject {
  resolveGround?: RunDeps["resolveGround"];
  caseForVerify?: RunDeps["caseForVerify"];
  cwd?: string;
}

const VALUE_FLAGS = ["cache", "cwd", "inject", "escalate-log", "interval", "max-ticks", "state"];

function parseArgs(args: string[]) {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (VALUE_FLAGS.includes(name)) flags[name] = args[++i];
      else bools.add(name);
    } else pos.push(a);
  }
  return { flags, bools, pos };
}

async function loadInject(p?: string): Promise<ProjectInject> {
  if (!p) return {};
  const mod = await import(resolve(process.cwd(), p));
  return (mod.default ?? mod) as ProjectInject;
}

const log = (m: string) => process.stderr.write(`${m}\n`);
const die = (m: string): never => {
  process.stderr.write(`${m}\n`);
  process.exit(1);
};

const USAGE = `piper —— 蒸馏→编译→执行 CLI

用法:
  piper distill [name]                起草一份 agent.yaml 骨架(蒸馏请用 Claude Code 的 piper-distill skill)
  piper validate <yaml>               封闭词汇严格校验
  piper compile  <yaml> [opts]        编译阶段:固化成自包含 .sh + lock.json(入仓)
  piper run      <yaml> [opts]        执行阶段:单 tick(严格只跑产物)
  piper watch    <yaml> [opts]        执行阶段:常驻哨兵

通用 opts:
  --cache <dir>          编译产物目录(默认 crystallized)
  --cwd <dir>            触发器/步骤工作目录(覆盖 --inject 的 cwd)
  --inject <module.ts>   run/watch:项目侧注入(默认导出 {resolveGround?, caseForVerify?, cwd?})
  --interactive          升级走交互式问 stdin(默认无人值守:denyByDefault)
  --escalate-log <dir>   无人值守升级落盘目录(默认 logs/escalations)
watch opts:
  --interval <sec>       探测间隔秒(默认 60)   --max-ticks <n>   跑几轮后停
  --state <path>         哨兵 last-seen 持久化(默认 logs/sentinel-state.json)`;

const DISTILL_TEMPLATE = (name: string) => `# 由 piper distill 起草的骨架;<…> 处填自然语言/正则,再 piper validate 校验。
# 词汇是封闭的:项目专属语义只能进 NL 值,不要新增关键字(piper validate 会拦)。
agent: ${name}
# distilled: sessions … · skills …   (溯源写注释即可,不是关键字)
loop:
  on: <自然语言:探什么触发器——只读查询,把构建 key 打到 stdout(去重=stdout 全等)>
  every: 5m                    # 探测节奏(watch 默认用它)
  do:
    goal: <自然语言:这一轮要达成什么>
    model: deepseek-v4-pro     # 标准模型名(piper 配置里映射到网关)
    steps:
      - id: step-1
        nl: <自然语言:这一步做什么——机械、可固化成确定脚本>
        verify: <对 stdout 的正则;缺省=非空>
        # cwd: ~/path        # 工作目录
        # danger: <非空字符串=危险写,过自管闸>
        # using: [skill-name] # 编译期可参考的 skill
        # self_contained: false  # 重活暂用仓库脚本时关掉自包含强校验
    judge:                   # do 层验收=活判断(不固化);只要机械门就删掉本段、靠 step 的 verify
      ask: <自然语言:判官判什么(可含"命中哪类则升级")>
      ground: [<取证手段1>, <取证手段2>]
      labels: [<标签1>, <标签2>, flake]
guard:
  owns: <正则:认领"本 agent 自管资源">
  budget: 2              # 预算内自管写自动放行;超预算/碰别人的 → 升级
`;

function summarize(yamlPath: string): void {
  const a = loadAgentYaml(readFileSync(yamlPath, "utf8"));
  log(`✓ ${a.name} 校验通过`);
  log(`  loop.on=${a.loop.on.slice(0, 40)}…  every=${a.loop.every ?? "-"}`);
  log(`  do.steps=${a.loop.do.steps?.map((s) => s.id).join(" → ") ?? "(单步=goal)"}`);
  const j = a.loop.do.judge;
  log(`  judge=${j ? `ask + ground=${j.ground.length} labels=${j.labels?.join("/") ?? "-"}` : "(无,只靠 step verify)"}`);
  log(`  guard=${a.guard?.owns ? `owns=${a.guard.owns.slice(0, 20)}… budget=${a.guard.budget ?? "-"}` : "(无)"}`);
}

// "30m" / "5s" / "1h" / 裸数字(秒)→ 毫秒;无法解析返回 undefined。
function everyToMs(s?: string): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = (m[2] ?? "s").toLowerCase();
  return n * (u === "h" ? 3600_000 : u === "m" ? 60_000 : 1000);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, bools, pos } = parseArgs(rest);
  const escalate = () => (bools.has("interactive") ? consoleEscalation() : denyByDefault(flags["escalate-log"] ?? "logs/escalations"));
  const cacheDir = flags.cache ?? "crystallized";

  switch (cmd) {
    case "distill": {
      process.stdout.write(DISTILL_TEMPLATE(pos[0] ?? "my-agent"));
      log("\n# 这是骨架。真正的蒸馏(读会话/记忆/技能 → 填实)是 Claude Code 的活:用 piper-distill skill,");
      log("# 边写边 `piper validate` 直到无未知键/类型错。");
      return;
    }
    case "validate": {
      if (!pos[0]) die(USAGE);
      try {
        summarize(pos[0]);
      } catch (e) {
        die(e instanceof AgentSchemaError ? `✗ ${e.message}` : `✗ ${(e as Error).message}`);
      }
      return;
    }
    case "compile": {
      if (!pos[0]) die(USAGE);
      const a = loadAgentYaml(readFileSync(pos[0], "utf8"));
      const inject = await loadInject(flags.inject);
      await compileAgent(a, { cache: fileCache(cacheDir), escalateFallback: escalate(), cwd: flags.cwd ?? inject.cwd, onLog: log });
      log(`\n编译完成 → ${cacheDir}/(.sh + lock.json)。执行:piper run ${pos[0]}`);
      return;
    }
    case "run": {
      if (!pos[0]) die(USAGE);
      const a = loadAgentYaml(readFileSync(pos[0], "utf8"));
      const inject = await loadInject(flags.inject);
      const r = await runAgent(a, {
        cache: fileCache(cacheDir),
        escalateFallback: escalate(),
        cwd: flags.cwd ?? inject.cwd,
        resolveGround: inject.resolveGround ?? (() => []),
        caseForVerify: inject.caseForVerify,
        compileMissing: bools.has("compile-missing"),
        onLog: log,
      });
      log(`\n构建信号=${r.buildId ?? "(无)"}  步骤=${r.steps.map((s) => `${s.id.split("__").pop()}:${s.ok ? s.mode : "✗"}`).join(" | ") || "(未跑)"}`);
      for (const s of r.steps.filter((x) => !x.ok)) log(`  ✗ ${s.id}: ${s.note}`);
      log(`verify=${r.verify?.verdict ?? "(未到)"}${r.verify?.escalated ? " ⚠升级" : ""}`);
      return;
    }
    case "watch": {
      if (!pos[0]) die(USAGE);
      const a = loadAgentYaml(readFileSync(pos[0], "utf8"));
      const inject = await loadInject(flags.inject);
      const r = await runSentinel(
        a,
        {
          cache: fileCache(cacheDir),
          escalateFallback: escalate(),
          cwd: flags.cwd ?? inject.cwd,
          resolveGround: inject.resolveGround ?? (() => []),
          caseForVerify: inject.caseForVerify,
          onLog: log,
        },
        {
          // 间隔优先级:--interval > loop.every > 60s 兜底
          intervalMs: flags.interval ? Number(flags.interval) * 1000 : (everyToMs(a.loop.every) ?? 60_000),
          maxTicks: flags["max-ticks"] ? Number(flags["max-ticks"]) : undefined,
          statePath: flags.state ?? "logs/sentinel-state.json",
        },
      );
      log(`\n哨兵结束:${r.reason},${r.ticks} ticks,last-seen=${r.lastSeen}`);
      return;
    }
    default:
      die(USAGE);
  }
}

main().catch((e) => die(`✗ ${(e as Error).message}`));
