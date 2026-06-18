// piper 配置 + 标准模型名解析单测(注入配置,不读文件、不打网络)。跑:bun test
import { afterAll, expect, test } from "bun:test";
import { resolveModel, setPiperConfig } from "./config.ts";

setPiperConfig({
  default_model: "deepseek-v4-pro",
  gateways: {
    baizhi: { base_url: "https://gw/api/anthropic", api: "anthropic-messages", api_key_env: "TEST_KEY_BAIZHI", models: { "deepseek-v4-pro": "vip/deepseek-v4-pro" } },
    other: { base_url: "https://other", api: "anthropic-messages", api_key_env: "TEST_KEY_OTHER", models: { "deepseek-v4-pro": "ds-v4-0701", "fast-cheap": "mini-1" } },
  },
});
process.env.TEST_KEY_BAIZHI = "k1";
process.env.TEST_KEY_OTHER = "k2";
afterAll(() => setPiperConfig(null));

test("标准名 → 网关真实模型 id(取第一个有此模型的网关)", () => {
  const s = resolveModel("deepseek-v4-pro");
  expect(s.provider).toBe("baizhi");
  expect(s.modelId).toBe("vip/deepseek-v4-pro"); // baizhi 的命名
  expect(s.apiKey).toBe("k1");
});

test("缺省用 default_model", () => {
  expect(resolveModel().modelName).toBe("deepseek-v4-pro");
});

test("只在某网关存在的标准名 → 落到那个网关(命名不同)", () => {
  const s = resolveModel("fast-cheap");
  expect(s.provider).toBe("other");
  expect(s.modelId).toBe("mini-1"); // other 的命名
});

test("未知模型 → 报错(列出已配标准名)", () => {
  expect(() => resolveModel("nope")).toThrow(/未知模型/);
});

test("key 环境变量未设 → 报错", () => {
  setPiperConfig({ default_model: "m", gateways: { g: { base_url: "u", api: "anthropic-messages", api_key_env: "TEST_KEY_MISSING", models: { m: "mid" } } } });
  expect(() => resolveModel("m")).toThrow(/环境变量.*未设/);
});
