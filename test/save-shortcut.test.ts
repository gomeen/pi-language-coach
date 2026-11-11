import { test } from "node:test";
import assert from "node:assert/strict";
import { CoachController } from "../src/controller.ts";
import type { Generation } from "../src/generate.ts";

const settings = { kind: "configured", config: {
  api: "anthropic-messages", apiKey: "synthetic", model: "synthetic", thinking: "adaptive", endpoint: "http://localhost/v1/messages",
  systemPrompt: "synthetic", showOriginal: true, showPractice: true, autoSave: false, timeoutMs: 1000,
} } as const;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const generation: Generation = { kind: "ready", english: "Hello.", grammar: {
  excerpt: "Hello", pattern: "greeting", explanation: "问候语。",
} };

test("lesson snapshots match only the visible completed submission and do not expose key or draft", async () => {
  const controller = new CoachController(settings, () => {}, async () => generation);
  assert.equal(controller.lesson(), undefined);
  controller.submit("你好");
  assert.equal(controller.lesson(), undefined);
  await tick();
  const snapshot = controller.lesson();
  assert.deepEqual(snapshot, { original: "你好", english: "Hello.", grammar: generation.grammar });
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic|apiKey|endpoint/);
  snapshot!.grammar!.explanation = "mutated";
  assert.equal(controller.lesson()!.grammar!.explanation, "问候语。");
  controller.submit("!skip");
  assert.equal(controller.lesson(), undefined);
  controller.command("retry"); await tick();
  assert.equal(controller.lesson()!.original, "你好", "retry keeps correct source/result pairing");
  controller.command("off"); assert.equal(controller.lesson(), undefined);
  controller.command("on"); assert.equal(controller.lesson(), undefined);
  controller.submit("再次问候"); await tick();
  controller.command("clear"); assert.equal(controller.lesson(), undefined);
  controller.submit("再见"); await tick();
  controller.dispose(); assert.equal(controller.lesson(), undefined);
});
