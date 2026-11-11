import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { registerLanguageCoach, type Dependencies } from "../src/index.ts";
import type { CoachConfig, Environment } from "../src/config.ts";
import type { Generation } from "../src/generate.ts";
import type { Lesson } from "../src/storage.ts";
import { ReviewOpenError } from "../src/review.ts";

type Host = Pick<ExtensionAPI, "on" | "registerCommand" | "registerShortcut">;
type WidgetFactory = Exclude<Parameters<ExtensionContext["ui"]["setWidget"]>[1], undefined>;
const AGENT_DIR = mkdtempSync(join(tmpdir(), "coach-lifecycle-"));
type HarnessContext = Pick<ExtensionContext, "mode" | "hasUI"> & {
  ui: Pick<ExtensionContext["ui"], "setWidget" | "notify" | "getEditorComponent" | "setEditorComponent">;
};
type HarnessEvent = InputEvent | { type: "session_start" | "session_shutdown" | "session_tree" };
type Handler = (event: HarnessEvent, ctx: HarnessContext) => unknown;

function forbidden<T extends object>(target: T): T {
  return new Proxy(target, { get(object, key, receiver) {
    if (!(key in object)) throw new Error(`Forbidden host API access: ${String(key)}`);
    return Reflect.get(object, key, receiver);
  } });
}

/** Registration, widget/notification and editor-factory APIs only; context/messages/session access throws. */
function harness(dependencies: Dependencies = {}, mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, (ctx: HarnessContext) => unknown>();
  const saved: Lesson[] = [];
  const notifications: string[] = [];
  let command: ((args: string, ctx: HarnessContext) => unknown) | undefined;
  const components: Component[] = [];
  let current: Component | undefined;
  let widgetWrites = 0;
  const ui: HarnessContext["ui"] = forbidden({
    getEditorComponent() { return undefined; },
    setEditorComponent() {}, // Editor behavior is covered by practice.test.ts and the real-Pi smoke.
    notify(message: string) { notifications.push(message); },
    setWidget(_key: string, content: string[] | WidgetFactory | undefined) {
      widgetWrites++;
      assert.ok(typeof content !== "object", "custom component factory only, never text arrays");
      current = typeof content === "function" ? content(
        forbidden({ requestRender() {} }) as unknown as Parameters<WidgetFactory>[0],
        forbidden({ fg: (_color: string, text: string) => text }) as unknown as Parameters<WidgetFactory>[1],
      ) : undefined;
      if (current) components.push(current);
    },
  });
  const context: HarnessContext = forbidden({ mode, hasUI: mode === "tui" || mode === "rpc", ui });
  const host: Host = forbidden({
    // Erase the host's many event overloads once at the boundary; runtime context stays minimal.
    on: ((name: string, callback: Handler) => { handlers.set(name, callback); }) as Host["on"],
    registerCommand(name, options) {
      assert.equal(name, "coach");
      command = options.handler as unknown as typeof command;
    },
    registerShortcut(key, options) {
      shortcuts.set(key, options.handler as unknown as (ctx: HarnessContext) => unknown);
    },
  });
  registerLanguageCoach(host, {
    environment: () => ({ PI_CODING_AGENT_DIR: AGENT_DIR, PI_LANGUAGE_COACH_API_KEY: "fake-only", PI_LANGUAGE_COACH_AUTO_SAVE: "false" }),
    save: async lesson => { saved.push(lesson); return "saved"; },
    ...dependencies,
  });
  return {
    context, handlers, components, shortcuts, saved, notifications,
    async save() {
      assert.deepEqual([...shortcuts.keys()], ["f8"], "only the save shortcut: no paging keys, and F2 stays free for other extensions");
      await shortcuts.get("f8")!(context);
    },
    emit(event: HarnessEvent, ctx = context) { return handlers.get(event.type)?.(event, ctx); },
    input(text: string, extras: Partial<InputEvent> = {}) {
      const event: InputEvent = { type: "input", text, source: "interactive", ...extras };
      const before = structuredClone(event);
      const result = handlers.get("input")?.(event, context);
      assert.deepEqual(result, { action: "continue" }, "must be synchronous and unchanged, never transform/handled");
      assert.deepEqual(event, before, "must not mutate original input/images");
      return result;
    },
    async command(args: string) { await command?.(args, context); },
    lines(width = 200) { return current?.render(width) ?? []; },
    get writes() { return widgetWrites; },
    get mounted() { return current !== undefined; },
  };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function ready(english: string): Generation {
  return { kind: "ready", english, grammar: { excerpt: english, pattern: "短句", explanation: "保留原意的短句。" } };
}
function deferredGenerator() {
  const calls: Array<{
    config: CoachConfig; prompt: string; signal: AbortSignal;
    resolve: (result: Generation) => void; reject: (error: unknown) => void;
  }> = [];
  const generate = (config: CoachConfig, prompt: string, signal: AbortSignal) => new Promise<Generation>((resolve, reject) => {
    calls.push({ config, prompt, signal, resolve, reject });
  });
  return { calls, generate };
}

test("registration is isolated; TUI interactive input passes immediately while coaching runs", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  assert.deepEqual([...h.handlers.keys()], ["session_start", "session_tree", "session_shutdown", "input"]);
  h.emit({ type: "session_start" });
  assert.deepEqual(h.lines(), []);
  h.input("I has a bug. Keep src/index.ts and do not use --force.");
  assert.deepEqual(h.lines(), []);
  assert.equal(h.mounted, false);
  await tick();
  assert.equal(work.calls.length, 1);
  assert.equal(work.calls[0]!.prompt, "I has a bug. Keep 「文件」 and do not use --force.");
  work.calls[0]!.resolve(ready("I have a bug."));
  await tick();
  assert.equal(h.lines()[0], "原文：I has a bug. Keep src/index.ts and do not use --force.", "the typed input leads for comparison");
  assert.equal(h.lines()[1], "I have a bug.");
  assert.equal(h.lines().length, 3);
});

test("attached images never enter coaching; accompanying text still translates unchanged for the host", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  const images: NonNullable<InputEvent["images"]> = [{ type: "image", data: "PRIVATE_IMAGE_DATA", mimeType: "image/png" }];
  h.input("请检查 /Users/me/PRIVATE_FILE.heic 和 [PRIVATE_LINK](https://example.com/private)，先别改。 ![PRIVATE_ALT](data:image/png;base64,PRIVATE_INLINE_IMAGE)", { images });
  await tick();
  assert.equal(work.calls.length, 1, "translate the remaining text instead of skipping all image-plus-text submissions");
  assert.equal(work.calls[0]!.prompt, "请检查 「图片」 和 「链接」，先别改。 「图片」");
  assert.doesNotMatch(work.calls[0]!.prompt, /PRIVATE|example/);
  assert.equal(images[0]!.data, "PRIVATE_IMAGE_DATA", "main image data must stay untouched");
  await h.command("retry"); await tick();
  assert.equal(work.calls[1]!.prompt, work.calls[0]!.prompt, "retry uses the same filtering");
  h.input("![PRIVATE_ALT](/Users/me/PRIVATE_IMAGE.png)", { images }); await tick();
  assert.equal(work.calls.length, 2, "image-only references never send a request");
  h.input("![PRIVATE_ALT](/Users/me/PRIVATE_IMAGE.png) 请检查这个界面", { images }); await tick();
  assert.equal(work.calls.length, 3, "a leading Markdown image is not a Bash command");
  assert.equal(work.calls[2]!.prompt, "「图片」 请检查这个界面");
});

test("only results mount a widget; loading, failure and skip remove it entirely", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  h.emit({ type: "session_start" });
  assert.equal(h.mounted, false);
  h.input("first"); await tick();
  assert.equal(h.mounted, false);
  work.calls[0]!.resolve(ready("First.")); await tick();
  assert.equal(h.mounted, true);
  assert.equal(h.lines().length, 3);
  h.input("second"); await tick();
  assert.equal(h.mounted, false, "remove old result while waiting, not an empty component");
  work.calls[1]!.reject(new Error("synthetic failure")); await tick();
  assert.equal(h.mounted, false);
  await h.command("retry"); await tick();
  work.calls[2]!.resolve({ kind: "partial", english: "Second." }); await tick();
  assert.equal(h.mounted, true, "valid English without grammar is still a result");
  assert.equal(h.lines().length, 3);
  h.input("!skip");
  assert.equal(h.mounted, false, "skip removes an existing result");
  await h.command("on");
  assert.equal(h.mounted, false);
});

test("latest request wins even when transport ignores abort; skipped input cancels pending work", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  h.input("first"); await tick();
  h.input("second"); await tick();
  assert.equal(work.calls[0]!.signal.aborted, true);
  work.calls[1]!.resolve(ready("Second.")); await tick();
  work.calls[0]!.resolve(ready("STALE FIRST SECRET")); await tick();
  assert.deepEqual(h.lines(), ["原文：second", "Second.", "语法：保留原意的短句。"]);
  h.input("third"); await tick();
  h.input("/skill:skip");
  assert.equal(work.calls[2]!.signal.aborted, true);
  work.calls[2]!.resolve(ready("STALE THIRD SECRET")); await tick();
  assert.deepEqual(h.lines(), []);
  assert.equal(h.mounted, false);
  assert.doesNotMatch(h.lines().join(""), /SECRET/);
});

test("skips stay hidden, long Unicode inputs are sent intact, English is eligible", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate, environment: () => ({
    PI_CODING_AGENT_DIR: AGENT_DIR, PI_LANGUAGE_COACH_API_KEY: "fake", PI_LANGUAGE_COACH_AUTO_SAVE: "false",
  }) });
  for (const [text, extras] of [
    ["", {}], [" \n ", {}], ["/command", {}], ["  !echo hi", {}],
    ["```ts\na()\n```", {}], ["~~~\na()\n~~~", {}],
    ["", { images: [{ type: "image", data: "not-real", mimeType: "image/png" }] }],
  ] satisfies Array<[string, Partial<InputEvent>]>) {
    h.input(text, extras);
    assert.deepEqual(h.lines(), []);
    assert.equal(h.mounted, false);
  }
  await tick();
  assert.equal(work.calls.length, 0);
  h.input("😀".repeat(10)); await tick();
  assert.equal(work.calls[0]!.prompt, "😀".repeat(10));
  h.input("a".repeat(25000)); await tick();
  assert.equal(work.calls[1]!.prompt, "a".repeat(25000));
  h.input("I has bug"); await tick();
  assert.equal(work.calls.length, 3);
  h.emit({ type: "session_shutdown" });
});

test("location filtering affects coaching and retry only, not main input or saved original", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  const original = "/Users/me/private.ts 请检查 https://internal.example.com/secret，先别改。";
  h.input(original); await tick();
  assert.equal(work.calls[0]!.prompt, "「文件」 请检查 「链接」，先别改。");
  work.calls[0]!.reject(new Error("synthetic")); await tick();
  await h.command("retry"); await tick();
  assert.equal(work.calls[1]!.prompt, "「文件」 请检查 「链接」，先别改。");
  work.calls[1]!.resolve(ready("Check it, but don't change it yet.")); await tick();
  await h.save();
  assert.equal(h.saved[0]!.original, original);
  h.input("https://internal.example.com/secret"); await tick();
  h.input("`/Users/me/private.ts`"); await tick();
  h.input("[src/a.ts](https://example.com/a)"); await tick();
  assert.equal(work.calls.length, 2, "location-only input is skipped");
  assert.equal(h.mounted, false);
});

test("headless/RPC/extension sources never read environment or request coaching", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const h = harness({
      environment: () => { throw new Error("must not read config"); },
      generate: async () => { throw new Error("must not send request"); },
    }, mode);
    h.emit({ type: "session_start" });
    h.input("hello");
    await h.command("on"); await h.command("retry"); await h.command("save"); await h.save();
    h.emit({ type: "session_tree" }); h.emit({ type: "session_shutdown" });
    assert.equal(h.writes, 0);
  }
  const h = harness({ environment: () => { throw new Error("must not read config"); } });
  h.input("hello", { source: "rpc" });
  h.input("hello", { source: "extension" });
  assert.equal(h.writes, 0);
});

test("missing/invalid config stays unmounted on input and /coach", async () => {
  for (const environment of [
    { PI_CODING_AGENT_DIR: AGENT_DIR, ANTHROPIC_API_KEY: "SECRET-FALLBACK" },
    { PI_CODING_AGENT_DIR: AGENT_DIR, PI_LANGUAGE_COACH_API_KEY: "fake", PI_LANGUAGE_COACH_BASE_URL: "https://u:SECRET@host.invalid" },
  ] satisfies Environment[]) {
    let calls = 0;
    const h = harness({ environment: () => environment, generate: async () => { calls++; return ready("wrong"); } });
    h.emit({ type: "session_start" });
    assert.deepEqual(h.lines(), []);
    h.input("hello");
    assert.deepEqual(h.lines(), []);
    assert.equal(h.mounted, false);
    assert.doesNotMatch(h.lines().join(""), /SECRET|host.invalid/);
    await h.command("clear"); assert.deepEqual(h.lines(), []);
    await h.command(""); assert.deepEqual(h.lines(), []);
    await h.command("on"); assert.equal(h.mounted, false);
    await tick(); assert.equal(calls, 0);
  }
});

test("retry resends only last eligible submission, not draft/skipped/main prompt", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  await h.command("retry"); assert.deepEqual(h.lines(), []);
  h.input("eligible"); await tick();
  work.calls[0]!.reject(new Error("SECRET raw URL/key")); await tick();
  assert.deepEqual(h.lines(), []);
  assert.equal(h.mounted, false);
  assert.doesNotMatch(h.lines().join(""), /SECRET/);
  h.input("!skip");
  await h.command("retry"); await tick();
  assert.equal(work.calls.length, 2);
  assert.equal(work.calls[1]!.prompt, "eligible");
  work.calls[1]!.resolve(ready("Retried.")); await tick();
  assert.equal(h.lines()[0], "原文：eligible");
  assert.equal(h.lines()[1], "Retried.");
  await h.command("clear");
  assert.deepEqual(h.lines(), []);
  await h.command("retry"); await tick();
  assert.equal(work.calls.length, 2);
  assert.deepEqual(h.lines(), []);
});

test("off cancels/hides/forgets, on does not resend; clear cancels pending work", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  h.input("forget after off"); await tick();
  await h.command("off");
  assert.equal(work.calls[0]!.signal.aborted, true);
  assert.deepEqual(h.lines(), []);
  work.calls[0]!.resolve(ready("STALE SECRET")); await tick();
  h.input("never retain while off"); await h.command("retry"); await tick();
  assert.deepEqual(h.lines(), []);
  assert.equal(work.calls.length, 1);
  await h.command("on"); await h.command("retry"); await tick();
  assert.equal(work.calls.length, 1);
  assert.deepEqual(h.lines(), []);
  h.input("forget after clear"); await tick();
  await h.command("clear");
  assert.equal(work.calls[1]!.signal.aborted, true);
  work.calls[1]!.reject(new Error("STALE SECRET")); await tick();
  assert.deepEqual(h.lines(), []);
  await h.command("retry"); await tick();
  assert.equal(work.calls.length, 2);
});

test("session start/tree/shutdown invalidate old owners, forget prompts and reject stale completions", async () => {
  for (const event of ["session_start", "session_tree", "session_shutdown"] as const) {
    const work = deferredGenerator();
    let environmentReads = 0;
    const h = harness({ generate: work.generate, environment: () => {
      environmentReads++;
      return { PI_CODING_AGENT_DIR: AGENT_DIR, PI_LANGUAGE_COACH_API_KEY: "fake" };
    } });
    h.emit({ type: "session_start" });
    h.input("old session SECRET"); await tick();
    const oldWrites = h.writes;
    h.emit({ type: event });
    assert.equal(work.calls[0]!.signal.aborted, true);
    assert.ok(h.writes > oldWrites);
    const resetWrites = h.writes;
    work.calls[0]!.resolve(ready("STALE SECRET")); await tick();
    assert.equal(h.writes, resetWrites, "late result must not touch old or new UI");
    assert.deepEqual(h.lines(), []);
    if (event !== "session_shutdown") {
      await h.command("retry"); await tick();
      assert.equal(work.calls.length, 1);
      assert.equal(environmentReads, event === "session_start" ? 2 : 1);
    }
  }
});

test("off remains off across tree navigation within the same session", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  h.emit({ type: "session_start" });
  await h.command("off");
  h.emit({ type: "session_tree" });
  h.input("must not send after tree");
  await h.command("retry"); await tick();
  assert.equal(work.calls.length, 0);
  assert.deepEqual(h.lines(), []);
  h.emit({ type: "session_start" });
  h.input("new session may default on"); await tick();
  assert.equal(work.calls.length, 1);
  h.emit({ type: "session_shutdown" });
});

test("shortcut saves full current result only on explicit request, command is equivalent", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate });
  h.emit({ type: "session_start" });
  await h.save(); assert.equal(h.saved.length, 0);
  h.input("只收藏这条原文"); await tick();
  await h.save(); assert.equal(h.saved.length, 0, "no pending result is saved");
  const english = "Full translated content. ".repeat(30);
  work.calls[0]!.resolve(ready(english)); await tick();
  assert.equal(h.saved.length, 0, "generation alone never writes to disk");
  assert.ok(h.lines().length > 2, "long English wraps; the full text is still what gets saved");
  await h.save();
  assert.deepEqual(h.saved[0], { original: "只收藏这条原文", english,
    grammar: { excerpt: english, pattern: "短句", explanation: "保留原意的短句。" } });
  assert.ok(h.lines().some(line => /^已收藏/.test(line)), "save notice is shown at the start of the notes");
  assert.equal(work.calls.length, 1, "save never calls the model");
  await h.command("save"); assert.equal(h.saved.length, 2);
  assert.equal(h.mounted, true, "save command must not clear the result");
  h.input("!skip"); await h.save(); assert.equal(h.saved.length, 2);
  await h.command("clear"); await h.save(); assert.equal(h.saved.length, 2);
  h.emit({ type: "session_shutdown" });
});

test("save duplicate/failure feedback shares the notes row and never echoes raw errors", async () => {
  for (const result of ["duplicate", "error"] as const) {
    const h = harness({ generate: async () => ready("Hello."), save: async () => {
      if (result === "error") throw new Error("SECRET /private/path");
      return result;
    } });
    h.input("你好"); await tick();
    await h.save();
    assert.equal(h.lines().length, 3);
    assert.equal(h.lines()[0], "原文：你好");
    assert.match(h.lines()[2]!, result === "duplicate" ? /已收藏过/ : /收藏失败/);
    assert.doesNotMatch(h.lines().join(""), /SECRET|private/);
    h.emit({ type: "session_shutdown" });
  }
});

test("late save completion cannot resurrect UI after clear, new input or session changes", async () => {
  for (const action of ["clear", "input", "session_start", "session_shutdown", "session_tree"] as const) {
    let finish: ((result: "saved") => void) | undefined;
    const h = harness({ generate: async () => ready("Hello."),
      save: () => new Promise(resolve => { finish = resolve; }) });
    h.input("收藏旧输入"); await tick();
    const saving = h.save();
    if (action === "clear") await h.command("clear");
    else if (action === "input") { h.input("!skip"); }
    else h.emit({ type: action });
    const writes = h.writes;
    finish!("saved"); await saving;
    assert.equal(h.writes, writes, "old save must not update a new UI owner");
    assert.equal(h.mounted, false);
    h.emit({ type: "session_shutdown" });
  }
});

test("default autosave persists only completed visible lessons; duplicate, skip and stale results add nothing", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate,
    environment: () => ({ PI_CODING_AGENT_DIR: AGENT_DIR, PI_LANGUAGE_COACH_API_KEY: "fake" }) });
  h.input("自动收藏的中文原文"); await tick();
  assert.equal(h.saved.length, 0);
  work.calls[0]!.resolve(ready("Complete English.")); await tick();
  assert.deepEqual(h.saved, [{ original: "自动收藏的中文原文", english: "Complete English.", grammar: {
    excerpt: "Complete English.", pattern: "短句", explanation: "保留原意的短句。",
  } }]);
  h.input("old"); await tick();
  h.input("new"); await tick();
  work.calls[1]!.resolve(ready("Old stale.")); await tick();
  assert.equal(h.saved.length, 1);
  work.calls[2]!.resolve({ kind: "partial", english: "Full English, grammar unavailable.",
    words: [{ word: "unavailable", meaning: "暂时没有" }] }); await tick();
  assert.deepEqual(h.saved[1], { original: "new", english: "Full English, grammar unavailable.",
    words: [{ word: "unavailable", meaning: "暂时没有" }] }, "word notes are saved even without grammar");
  h.input("!command"); await tick();
  assert.equal(h.saved.length, 2);
  h.emit({ type: "session_shutdown" });
});

test("autosave off remains manual-saveable; on applies to later completions without retranslation", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate, environment: () => ({ PI_CODING_AGENT_DIR: AGENT_DIR, PI_LANGUAGE_COACH_API_KEY: "fake" }) });
  await h.command("autosave off");
  h.input("private"); await tick();
  work.calls[0]!.resolve(ready("Private.")); await tick();
  assert.equal(h.saved.length, 0);
  await h.save();
  assert.equal(h.saved.length, 1);
  const before = h.lines();
  await h.command("autosave on");
  assert.deepEqual(h.lines(), before, "toggle does not erase the current lesson");
  assert.equal(h.saved.length, 1, "turning on does not retroactively save");
  h.input("next"); await tick();
  work.calls[1]!.resolve(ready("Next.")); await tick();
  assert.equal(h.saved.length, 2);
  assert.equal(work.calls.length, 2, "toggle/save never call model");
  h.emit({ type: "session_shutdown" });
  const disabled = harness({ generate: async () => ready("Hello."),
    environment: () => ({ PI_LANGUAGE_COACH_API_KEY: "fake", PI_LANGUAGE_COACH_AUTO_SAVE: "0" }) });
  disabled.input("environment off"); await tick();
  assert.equal(disabled.saved.length, 0);
  await disabled.command("save");
  assert.equal(disabled.saved.length, 1);
  disabled.emit({ type: "session_shutdown" });
});

test("autosave toggle survives session_start until the extension runtime is reloaded", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate, environment: () => ({ PI_LANGUAGE_COACH_API_KEY: "fake" }) });
  h.emit({ type: "session_start" });
  await h.command("autosave off");
  h.emit({ type: "session_start" });
  h.input("new session is still private"); await tick();
  work.calls[0]!.resolve(ready("No autosave.")); await tick();
  assert.equal(h.saved.length, 0);
  await h.save();
  assert.equal(h.saved.length, 1, "manual save still works in next session");
  await h.command("autosave on");
  h.emit({ type: "session_start" });
  h.input("autosave enabled across sessions"); await tick();
  work.calls[1]!.resolve(ready("Saved.")); await tick();
  assert.equal(h.saved.length, 2);
  h.emit({ type: "session_shutdown" });
  const offByEnv = harness({ generate: async () => ready("Enabled by command."),
    environment: () => ({ PI_LANGUAGE_COACH_API_KEY: "fake", PI_LANGUAGE_COACH_AUTO_SAVE: "false" }) });
  await offByEnv.command("autosave on");
  offByEnv.emit({ type: "session_start" });
  offByEnv.input("override remains on"); await tick();
  assert.equal(offByEnv.saved.length, 1);
  offByEnv.emit({ type: "session_shutdown" });
});

test("bare /coach cancels an in-flight request and prevents later publication/autosave", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate, environment: () => ({ PI_LANGUAGE_COACH_API_KEY: "fake" }) });
  h.input("should be cleared"); await tick();
  await h.command("");
  assert.ok(work.calls[0]!.signal.aborted);
  work.calls[0]!.resolve(ready("STALE RESULT")); await tick();
  assert.deepEqual(h.lines(), []);
  assert.equal(h.saved.length, 0);
  await h.command("retry"); await tick();
  assert.equal(work.calls.length, 1, "cleared prompt cannot be retried");
  h.emit({ type: "session_shutdown" });
});

test("turning autosave off while a request is pending prevents its later save; manual still works", async () => {
  const work = deferredGenerator();
  const h = harness({ generate: work.generate, environment: () => ({ PI_LANGUAGE_COACH_API_KEY: "fake" }) });
  h.input("pending"); await tick();
  await h.command("autosave off");
  work.calls[0]!.resolve(ready("Pending complete.")); await tick();
  assert.equal(h.saved.length, 0);
  assert.equal(h.lines()[0], "原文：pending");
  assert.equal(h.lines()[1], "Pending complete.");
  await h.save();
  assert.equal(h.saved.length, 1);
  h.emit({ type: "session_shutdown" });
});

test("automatic save failures are reported without leaking errors or saving after shutdown", async () => {
  const h = harness({ generate: async () => ready("Hello."),
    environment: () => ({ PI_LANGUAGE_COACH_API_KEY: "fake" }),
    save: async () => { throw new Error("SECRET /private/file"); } });
  h.input("你好"); await tick();
  assert.match(h.notifications.at(-1)!, /自动收藏失败/);
  assert.doesNotMatch(h.notifications.join(""), /SECRET|private/);
  h.emit({ type: "session_shutdown" });
  const work = deferredGenerator();
  const stale = harness({ generate: work.generate, environment: () => ({ PI_LANGUAGE_COACH_API_KEY: "fake" }) });
  stale.input("before shutdown"); await tick();
  stale.emit({ type: "session_shutdown" });
  work.calls[0]!.resolve(ready("Late.")); await tick();
  assert.equal(stale.saved.length, 0);
});

test("long results wrap in the widget, keep the draft and show the next result from its start", async () => {
  const long = "A long expression " + "word ".repeat(30) + "END";
  let english = long;
  const h = harness({ generate: async () => ready(english) });
  h.input("长提示词"); await tick();
  const lines = h.lines(30);
  assert.ok(lines.length > 2, "wraps instead of paging");
  assert.ok(lines.every(line => line.length <= 30));
  assert.match(lines.join(" "), /END/, "the whole English is visible without paging");
  english = "Next.";
  h.input("新的一条"); await tick();
  assert.equal(h.lines(30)[1], "Next.");
  assert.equal(h.lines(30)[0], "原文：新的一条");
  assert.equal(h.saved.length, 0, "rendering does not save");
  h.emit({ type: "session_shutdown" });
});

test("review reads independently without configuring or calling a model, changing widget or enabling coaching", async () => {
  let reviews = 0;
  let environmentReads = 0;
  const h = harness({ review: async () => { reviews++; }, environment: () => {
    environmentReads++;
    return {};
  } });
  await h.command(" review ");
  assert.equal(reviews, 1);
  assert.equal(environmentReads, 0, "reading saved lessons needs no API key or controller");
  assert.equal(h.writes, 0);
  assert.deepEqual(h.notifications, []);
  const work = deferredGenerator();
  const active = harness({ generate: work.generate, review: async () => { reviews++; } });
  active.input("保留当前表达"); await tick();
  work.calls[0]!.resolve(ready("Keep the current expression.")); await tick();
  const before = active.lines();
  const writes = active.writes;
  await active.command("review");
  assert.deepEqual(active.lines(), before);
  assert.equal(active.writes, writes);
  assert.equal(work.calls.length, 1);
  await active.command("off");
  await active.command("review");
  active.input("仍然关闭"); await tick();
  assert.equal(work.calls.length, 1, "review must not re-enable coaching");
  assert.equal(reviews, 3);
  active.emit({ type: "session_shutdown" });
});

test("review is inert outside TUI; failures notify without raw errors or clearing current lesson", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const h = harness({ review: async () => { assert.fail("must not open browser outside TUI"); } }, mode);
    await h.command("review");
    assert.equal(h.writes, 0);
    assert.deepEqual(h.notifications, []);
  }
  for (const error of [new Error("SECRET internal stderr"), new ReviewOpenError("/tmp/saved/review.html")]) {
    const h = harness({ generate: async () => ready("Hello."), review: async () => { throw error; } });
    h.input("你好"); await tick();
    const before = h.lines();
    await h.command("review");
    assert.deepEqual(h.lines(), before);
    assert.equal(h.notifications.length, 1);
    assert.doesNotMatch(h.notifications[0]!, /SECRET|internal/);
    assert.match(h.notifications[0]!, error instanceof ReviewOpenError ? /手动打开：\/tmp\/saved\/review.html/ : /生成失败/);
    h.emit({ type: "session_shutdown" });
  }
});

test("configuration validated once per session; commands without results remove the widget", async () => {
  let reads = 0;
  const h = harness({ environment: () => { reads++; return { PI_LANGUAGE_COACH_API_KEY: "fake" }; }, generate: async () => ready("Done.") });
  h.emit({ type: "session_start" });
  h.input("hello"); await tick();
  await h.command("");
  assert.deepEqual(h.lines(), []);
  assert.equal(h.mounted, false);
  await h.command("unknown SECRET");
  assert.doesNotMatch(h.lines().join(""), /SECRET/);
  await h.command("retry"); await tick();
  h.emit({ type: "session_tree" });
  assert.equal(reads, 1);
  h.emit({ type: "session_start" });
  assert.equal(reads, 2);
});
