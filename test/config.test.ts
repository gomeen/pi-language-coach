import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Environment } from "../src/config.ts";

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
    apiKey: "test-only", model: "MiniMax-M3.1-Flash", thinking: "medium",
    endpoint: "https://api.minimaxi.com/anthropic/v1/messages",
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
    { TIMEOUT_MS: "NaN" },
  ];
  for (const override of bad) {
    const env: Record<string, string> = { PI_LANGUAGE_COACH_API_KEY: "test-only-secret" };
    for (const [key, value] of Object.entries(override)) env["PI_LANGUAGE_COACH_" + key] = value;
    const result = loadConfig(env);
    assert.equal(result.kind, "disabled", JSON.stringify(override));
    assert.doesNotMatch(JSON.stringify(result), /test-only-secret|password|secret=value|header/);
  }
});
