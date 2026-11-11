import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Environment } from "../src/config.ts";
import { SYSTEM_PROMPT } from "../src/generate.ts";

test("dedicated namespace only, exact defaults and no authentication fallback", () => {
  const read: string[] = [];
  const env: Environment = new Proxy({ PI_LANGUAGE_COACH_API_KEY: "test-only" }, {
    get(target, key: string) {
      read.push(key);
      return target[key as keyof typeof target];
    },
  });
  const result = loadConfig(env);
  assert.equal(result.kind, "configured");
  if (result.kind !== "configured") return;
  assert.deepEqual(result.config, {
    api: "anthropic-messages",
    apiKey: "test-only", model: "MiniMax-M3.1-Flash", thinking: "medium",
    endpoint: "https://api.minimaxi.com/anthropic/v1/messages",
    systemPrompt: SYSTEM_PROMPT, showOriginal: true, showPractice: true,
    autoSave: true, timeoutMs: 30000,
  });
  assert.ok(read.every((key) => key.startsWith("PI_LANGUAGE_COACH_")));
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "must-not-use", MINIMAX_API_KEY: "must-not-use" }).kind, "disabled");
});

test("valid overrides and localhost HTTP; no silent model fallback", () => {
  const result = loadConfig({
    PI_LANGUAGE_COACH_API_KEY: "fake",
    PI_LANGUAGE_COACH_MODEL: "custom-deployment",
    PI_LANGUAGE_COACH_THINKING: "disabled",
    PI_LANGUAGE_COACH_BASE_URL: "http://[::1]:5555/anthropic/",
    PI_LANGUAGE_COACH_AUTO_SAVE: "false",
    PI_LANGUAGE_COACH_TIMEOUT_MS: "50",
  });
  assert.equal(result.kind, "configured");
  if (result.kind === "configured") {
    assert.equal(result.config.model, "custom-deployment");
    assert.equal(result.config.thinking, "disabled");
    assert.equal(result.config.endpoint, "http://[::1]:5555/anthropic/v1/messages");
    assert.equal(result.config.timeoutMs, 50);
    assert.equal(result.config.autoSave, false);
  }
  for (const thinking of ["adaptive", "low", "medium", "high"] as const) {
    const result = loadConfig({ PI_LANGUAGE_COACH_API_KEY: "fake", PI_LANGUAGE_COACH_THINKING: thinking });
    assert.equal(result.kind === "configured" ? result.config.thinking : result.kind, thinking);
  }
});

test("invalid environment is disabled without echoing values", () => {
  const bad: Array<Record<string, string>> = [
    { API_KEY: "secret\nheader" }, { API_KEY: "secret value" },
    ...["http://remote.invalid", "ftp://localhost", "https://u:password@example.com", "https://example.com?secret=value",
      "https://example.com#secret", "https://example.com?", "https://example.com#", "not-a-url"].map(BASE_URL => ({ BASE_URL })),
    { MODEL: "bad\x1bmodel" }, { MODEL: "" },
    ...["yes", "on", "", "TRUE", "enabled", "xhigh", "max"].map(THINKING => ({ THINKING })),
    ...["yes", "on", "", "TRUE"].map(AUTO_SAVE => ({ AUTO_SAVE })),
    ...["yes", "on", "", "TRUE"].map(SHOW_ORIGINAL => ({ SHOW_ORIGINAL })),
    ...["yes", "on", "", "TRUE"].map(SHOW_PRACTICE => ({ SHOW_PRACTICE })),
    { PROMPT: "   \n  " }, { PROMPT_FILE: "/nonexistent/coach-prompt.md" },
    { TIMEOUT_MS: "NaN" },
    ...["openai", "h self", "", "MINIMAX"].map(PROVIDER => ({ PROVIDER })),
    { PROVIDER: "deepseek", DEEPSEEK_API_KEY: "test-only-secret", DEEPSEEK_BASE_URL: "https://evil.example.com?secret=value" },
    { PROVIDER: "h-self", H_SELF_API_KEY: "test-only-secret", H_SELF_MODEL: "bad\x1bmodel" },
  ];
  for (const override of bad) {
    const env: Record<string, string> = { PI_LANGUAGE_COACH_API_KEY: "test-only-secret" };
    for (const [key, value] of Object.entries(override)) env["PI_LANGUAGE_COACH_" + key] = value;
    const result = loadConfig(env);
    assert.equal(result.kind, "disabled", JSON.stringify(override));
    assert.doesNotMatch(JSON.stringify(result), /test-only-secret|password|secret=value|header/);
  }
});

test("deepseek and h-self presets resolve scoped keys, preset endpoints and models", () => {
  const deepseek = loadConfig({ PI_LANGUAGE_COACH_PROVIDER: "deepseek", PI_LANGUAGE_COACH_DEEPSEEK_API_KEY: "test-only" });
  assert.equal(deepseek.kind, "configured");
  if (deepseek.kind === "configured") {
    assert.deepEqual(deepseek.config, {
      api: "openai-completions", apiKey: "test-only", model: "deepseek-flash", thinking: "medium",
      endpoint: "https://api.deepseek.com/chat/completions",
      systemPrompt: SYSTEM_PROMPT, showOriginal: true, showPractice: true,
      autoSave: true, timeoutMs: 30000,
    });
  }
  const relay = loadConfig({ PI_LANGUAGE_COACH_PROVIDER: "h-self", PI_LANGUAGE_COACH_H_SELF_API_KEY: "test-only" });
  assert.equal(relay.kind, "configured");
  if (relay.kind === "configured") {
    assert.equal(relay.config.api, "openai-responses");
    assert.equal(relay.config.model, "gpt-5.6-luna");
    assert.equal(relay.config.endpoint, "https://ai.yuchuantest.com/v1/responses");
  }
  // Scoped overrides cover any other relay endpoint, including plain localhost HTTP.
  const custom = loadConfig({
    PI_LANGUAGE_COACH_PROVIDER: "h-self", PI_LANGUAGE_COACH_H_SELF_API_KEY: "test-only",
    PI_LANGUAGE_COACH_H_SELF_BASE_URL: "http://127.0.0.1:9999/relay/", PI_LANGUAGE_COACH_H_SELF_MODEL: "relay-model",
  });
  assert.equal(custom.kind === "configured" ? custom.config.endpoint : custom.kind, "http://127.0.0.1:9999/relay/responses");
  assert.equal(custom.kind === "configured" ? custom.config.model : custom.kind, "relay-model");
  // A stale minimax key never satisfies another provider, and vice versa.
  assert.equal(loadConfig({ PI_LANGUAGE_COACH_PROVIDER: "deepseek", PI_LANGUAGE_COACH_API_KEY: "minimax-key" }).kind, "disabled");
  const missing = loadConfig({ PI_LANGUAGE_COACH_PROVIDER: "deepseek", PI_LANGUAGE_COACH_H_SELF_API_KEY: "other" });
  assert.equal(missing.kind, "disabled");
  if (missing.kind === "disabled") assert.match(missing.reason, /PI_LANGUAGE_COACH_DEEPSEEK_API_KEY/);
  const legacy = loadConfig({ PI_LANGUAGE_COACH_API_KEY: "minimax-key" });
  assert.equal(legacy.kind === "configured" ? legacy.config.model : legacy.kind, "MiniMax-M3.1-Flash",
    "unprefixed names stay the minimax provider so old setups keep working");
});

test("display toggles and a custom teaching prompt resolve with the documented precedence", async () => {
  const off = loadConfig({
    PI_LANGUAGE_COACH_API_KEY: "test-only",
    PI_LANGUAGE_COACH_SHOW_ORIGINAL: "false", PI_LANGUAGE_COACH_SHOW_PRACTICE: "0",
    PI_LANGUAGE_COACH_PROMPT: "  自定义教学提示词，必须仍要求返回 JSON。\n",
  });
  assert.equal(off.kind, "configured");
  if (off.kind === "configured") {
    assert.equal(off.config.showOriginal, false);
    assert.equal(off.config.showPractice, false);
    assert.equal(off.config.systemPrompt, "自定义教学提示词，必须仍要求返回 JSON。");
  }
  const root = await mkdtemp(join(tmpdir(), "coach-prompt-test-"));
  try {
    const file = join(root, "prompt.md");
    await writeFile(file, "\n文件提示词，覆盖内联文本。\n");
    const fromFile = loadConfig({
      PI_LANGUAGE_COACH_API_KEY: "test-only",
      PI_LANGUAGE_COACH_PROMPT: "inline loses",
      PI_LANGUAGE_COACH_PROMPT_FILE: file,
    });
    assert.equal(fromFile.kind === "configured" ? fromFile.config.systemPrompt : fromFile.kind,
      "文件提示词，覆盖内联文本。", "PROMPT_FILE wins over PROMPT");
    const fromInline = loadConfig({ PI_LANGUAGE_COACH_API_KEY: "test-only", PI_LANGUAGE_COACH_PROMPT: "内联提示词" });
    assert.equal(fromInline.kind === "configured" ? fromInline.config.systemPrompt : fromInline.kind, "内联提示词");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
