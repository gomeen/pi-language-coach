import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { CURSOR_MARKER, visibleWidth, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { CoachEditor, enhanceWithPractice, PracticeInput } from "../src/practice.ts";
import { registerLanguageCoach, type Dependencies } from "../src/index.ts";
import type { Environment } from "../src/config.ts";
import type { Generation } from "../src/generate.ts";
import type { Lesson } from "../src/storage.ts";

const generation: Generation = { kind: "ready", english: "Outline the goals first.", grammar: {
  excerpt: "Outline", pattern: "动词开头", explanation: "祈使句用动词原形开头。" } };
const flush = async (times = 3) => { for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve)); };

const tuiStub = { terminal: { rows: 40 }, requestRender() {} } as TUI;
const plain = (text: string) => text;
const editorTheme: EditorTheme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

test("practice uses native editor borders and keeps every keystroke without judging it", () => {
  let closed = 0;
  const input = new PracticeInput(tuiStub, editorTheme, () => { closed++; });
  input.focused = true;
  const lines = input.render(60);
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => visibleWidth(line) <= 60));
  assert.match(lines[0]!, /输入一遍/);
  assert.match(lines[2]!, /回车结束/);
  assert.ok(lines[1]!.includes(CURSOR_MARKER));
  for (const character of "Don't implement anything yet.") input.handleInput(character);
  assert.match(input.render(60)[1]!, /implement/);
  // Enter ends the lap and closes the row; nothing is checked.
  input.handleInput("\r");
  assert.equal(closed, 1);
  input.handleInput("\x1b");
  assert.equal(closed, 2);
  input.handleInput("\x1b[12~");
  assert.equal(closed, 2, "F2 is not a practice shortcut; only Enter or Esc closes the row");
});

test("practice wraps long text, supports multiline paste and editing, resize and focus", () => {
  const input = new PracticeInput(tuiStub, editorTheme, () => {});
  input.focused = true;
  const text = "Do not implement anything yet. 先梳理目标。\nCheck the plan again.";
  input.handleInput(`\x1b[200~${text}\x1b[201~`);
  assert.equal(input.getExpandedText(), text);
  for (const width of [80, 36, 12, 80]) {
    input.invalidate();
    const lines = input.render(width);
    assert.ok(lines.length >= 4);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
    assert.equal(lines.filter(line => line.includes(CURSOR_MARKER)).length, 1);
  }
  input.handleInput("\x7f"); // Native backspace edits the last character.
  assert.equal(input.getText(), text.slice(0, -1));
  input.focused = false;
  assert.ok(input.render(80).every(line => !line.includes(CURSOR_MARKER)));
});

test("empty Enter still closes practice without a submission", () => {
  let closed = 0;
  const input = new PracticeInput(tuiStub, editorTheme, () => { closed++; });
  input.onSubmit = () => assert.fail("practice must not submit to the host");
  input.handleInput("\r");
  assert.equal(closed, 1);
});

type Host = Pick<ExtensionAPI, "on" | "registerCommand" | "registerShortcut">;
type WidgetFactory = Exclude<Parameters<ExtensionContext["ui"]["setWidget"]>[1], undefined>;
type HarnessContext = Pick<ExtensionContext, "mode" | "hasUI"> & {
  ui: Pick<ExtensionContext["ui"], "setWidget" | "notify" | "setEditorComponent" | "getEditorComponent">;
};
type HarnessEvent = InputEvent | { type: "session_start" | "session_shutdown" | "session_tree" };
type Handler = (event: HarnessEvent, ctx: HarnessContext) => unknown;
type Row = { handleInput(data: string): void; render(width: number): string[] };

function uiHarness(dependencies: Dependencies = {}, environment: Environment = { PI_LANGUAGE_COACH_API_KEY: "synthetic", PI_LANGUAGE_COACH_AUTO_SAVE: "false" }) {
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, (ctx: HarnessContext) => unknown>();
  const saved: Lesson[] = [];
  const notifications: string[] = [];
  let command: ((args: string, ctx: HarnessContext) => unknown) | undefined;
  let editor: CoachEditor | undefined;
  let editorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  let current: Component | undefined;
  const themeStub = { fg: (_color: string, text: string) => text };
  const ui = {
    notify(message: string) { notifications.push(message); },
    setWidget(_key: string, factory: unknown) {
      current = typeof factory === "function" ? (factory as WidgetFactory)(undefined as never, themeStub as never) : undefined;
    },
    getEditorComponent() { return editorFactory; },
    setEditorComponent(factory: NonNullable<typeof editorFactory>) {
      editorFactory = factory;
      editor = factory(tuiStub, editorTheme, new KeybindingsManager()) as CoachEditor;
      editor.focused = true;
      editor.onExtensionShortcut = data => {
        const key = data === "\x1b[19~" ? "f8" : data === "\x1b[12~" ? "f2" : undefined;
        if (!key) return false;
        void shortcuts.get(key)?.(context);
        return true;
      };
    },
    custom() { assert.fail("practice must never open a blocking UI prompt / Orca needs-input notification"); },
    onTerminalInput() { assert.fail("practice must not intercept terminal input globally"); },
  } as unknown as HarnessContext["ui"];
  const context: HarnessContext = { mode: "tui", hasUI: true, ui };
  const host = {
    on: (name: string, callback: Handler) => { handlers.set(name, callback); },
    registerCommand: (_name: string, options: { handler: (args: string, ctx: HarnessContext) => unknown }) => {
      command = options.handler;
    },
    registerShortcut: (key: string, options: { handler: (ctx: HarnessContext) => unknown }) => {
      shortcuts.set(key, options.handler);
    },
  } as unknown as Host;
  registerLanguageCoach(host, {
    environment: () => environment,
    generate: async () => generation,
    save: async lesson => { saved.push(lesson); return "saved"; },
    ...dependencies,
  });
  return {
    context, handlers, shortcuts, saved, notifications,
    emit(event: HarnessEvent) { return handlers.get(event.type)?.(event, context); },
    get lines() { return current?.render(160) ?? []; },
    get editor() { return editor; },
    get row(): Row | undefined { return editor?.practicing ? editor : undefined; },
    async command(args: string) { await command?.(args, context); },
    input(text: string) { return handlers.get("input")?.({ type: "input", text, source: "interactive" }, context); },
    // Editor mode changes are synchronous: no blocking dialog promise.
    openPractice() { return command?.("practice", context) ?? Promise.resolve(); },
    pressF8() { return shortcuts.get("f8")?.(context) ?? Promise.resolve(); },
    type(text: string) { for (const character of text) editor?.handleInput(character); },
    enter() { editor?.handleInput("\r"); },
    escape() { editor?.handleInput("\x1b"); },
  };
}

test("the typing row appears by default with every fresh result, next to english and grammar", async () => {
  const h = uiHarness();
  h.emit({ type: "session_start" });
  const before = h.row;
  assert.equal(before, undefined, "no typing row without a result");
  h.input("先梳理目标和计划");
  await flush();
  const field = h.row;
  assert.ok(field, "the row opens on its own when the result lands");
  const panel = h.lines.join("\n");
  assert.match(panel, /Outline the goals first\./);
  assert.match(panel, /语法：祈使句用动词原形开头。/);
  assert.match(field.render(160).join("\n"), /输入一遍/);
});

test("Enter closes the row; the lesson stays visible", async () => {
  const h = uiHarness();
  h.emit({ type: "session_start" });
  h.input("先梳理目标和计划");
  await flush();
  h.type("Outline the goals first.");
  h.enter();
  await flush();
  assert.equal(h.row, undefined, "Enter closes the row");
  const panel = h.lines.join("\n");
  assert.match(panel, /Outline the goals first\./, "the lesson stays visible");
  assert.doesNotMatch(panel, /输入一遍/, "the typing row is gone");
});

test("Esc closes the row, and /coach practice reopens it on demand", async () => {
  const h = uiHarness();
  h.emit({ type: "session_start" });
  assert.equal(h.shortcuts.get("f2"), undefined, "no practice shortcut: F2 belongs to other extensions");
  h.input("先梳理目标和计划");
  await flush();
  assert.ok(h.row);
  h.escape();
  await flush();
  assert.equal(h.row, undefined, "Esc closes the row");
  const reopening = h.openPractice();
  const reopened = h.row;
  assert.ok(reopened, "/coach practice reopens the row");
  h.escape();
  await reopening;
  await flush();
  assert.equal(h.row, undefined, "Esc closes the reopened row too");
  await h.openPractice();
  assert.ok(h.row, "opening an already open row never closes it");
  h.escape();
  await flush();
});

test("no result, or no configuration, means no typing row and a clear hint from /coach practice", async () => {
  const withoutResult = uiHarness();
  await withoutResult.openPractice();
  assert.match(withoutResult.notifications.at(-1) ?? "", /还没有可输入的表达/);
  const unconfigured = uiHarness({}, { PI_LANGUAGE_COACH_API_KEY: "" });
  unconfigured.emit({ type: "session_start" });
  unconfigured.input("先梳理目标和计划");
  await flush();
  const field = unconfigured.row;
  assert.equal(field, undefined, "no row without a configured channel");
  await unconfigured.openPractice();
  assert.match(unconfigured.notifications.at(-1) ?? "", /未配置或已关闭/);
});

test("SHOW_PRACTICE=false stops the automatic popup; /coach practice still opens it on demand", async () => {
  const h = uiHarness({}, { PI_LANGUAGE_COACH_API_KEY: "synthetic", PI_LANGUAGE_COACH_AUTO_SAVE: "false",
    PI_LANGUAGE_COACH_SHOW_PRACTICE: "false" });
  h.emit({ type: "session_start" });
  h.input("先梳理目标和计划");
  await flush();
  assert.equal(h.row, undefined, "the typing row never opens on its own");
  assert.ok(h.editor, "the composed editor stays installed for explicit /coach practice");
  await h.openPractice();
  assert.ok(h.row, "an explicit /coach practice still opens the row");
  h.escape();
});

test("SHOW_ORIGINAL=false hides the submitted line but keeps english and grammar", async () => {
  const h = uiHarness({}, { PI_LANGUAGE_COACH_API_KEY: "synthetic", PI_LANGUAGE_COACH_AUTO_SAVE: "false",
    PI_LANGUAGE_COACH_SHOW_ORIGINAL: "false" });
  h.emit({ type: "session_start" });
  h.input("先梳理目标和计划");
  await flush();
  const panel = h.lines.join("\n");
  assert.doesNotMatch(panel, /原文：/);
  assert.match(panel, /Outline the goals first\./);
  assert.match(panel, /语法：祈使句用动词原形开头。/);
});

test("practice retains the native main draft, paste storage and cursor without a text round-trip", () => {
  const editor = new CoachEditor(tuiStub, editorTheme, new KeybindingsManager());
  const draft = Array.from({ length: 20 }, (_, i) => `DRAFT_LINE_${i}`).join("\n");
  editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
  const cursor = editor.getCursor();
  assert.match(editor.getText(), /\[paste #/);
  let submitted: string | undefined;
  editor.onSubmit = text => { submitted = text; };
  editor.openPractice();
  editor.handleInput("practice only");
  assert.equal(editor.getExpandedText(), draft, "host reads only the untouched main draft");
  editor.handleInput("\r");
  assert.equal(submitted, undefined, "practice Enter never submits");
  assert.equal(editor.practicing, false);
  assert.deepEqual(editor.getCursor(), cursor);
  editor.handleInput("\r");
  assert.equal(submitted, draft, "main Enter expands the original native paste, never its marker");
});

test("a delayed result cannot capture an in-progress prompt; /coach practice can explicitly open", async () => {
  let complete!: (value: Generation) => void;
  const h = uiHarness({ generate: () => new Promise(resolve => { complete = resolve; }) });
  h.emit({ type: "session_start" });
  h.input("first prompt");
  await flush();
  h.type("next draft");
  complete(generation);
  await flush();
  assert.equal(h.row, undefined, "do not take focus from an existing draft");
  h.type(" continues");
  assert.equal(h.editor?.getExpandedText(), "next draft continues");
  await h.openPractice();
  assert.ok(h.row);
  h.type("practice only");
  h.enter();
  assert.equal(h.editor?.getExpandedText(), "next draft continues");
});

test("native app and extension shortcuts still work during practice", async () => {
  const h = uiHarness();
  h.emit({ type: "session_start" });
  h.input("prompt"); await flush();
  h.editor!.handleInput("\x1b[19~"); await flush();
  assert.equal(h.saved.length, 1, "real F8 path saves while practicing");
  assert.ok(h.row);
  let cleared = 0;
  h.editor!.onAction("app.clear", () => { cleared++; });
  h.editor!.handleInput("\x03");
  assert.equal(cleared, 1, "Ctrl+C reaches the native app handler");
  assert.equal(h.row, undefined, "native app control restores the main editor");
});

test("off and session cleanup discard practice but never its main draft", async () => {
  const h = uiHarness();
  h.emit({ type: "session_start" });
  h.input("prompt"); await flush();
  h.editor!.setText("main draft");
  h.escape(); // close auto-open practice without any close shortcut
  await h.openPractice();
  assert.ok(h.row);
  await h.command("off");
  assert.equal(h.row, undefined);
  assert.equal(h.editor?.getExpandedText(), "main draft");
  await h.command("on");
  h.input("another prompt"); await flush();
  await h.openPractice();
  assert.ok(h.row);
  h.emit({ type: "session_shutdown" });
  assert.equal(h.row, undefined);
  assert.equal(h.editor?.getExpandedText(), "main draft");
});

test("enhanced foreign editors keep their identity and gain practice without touching the draft", () => {
  class ChipEditorStub extends CustomEditor {}
  const chip = new ChipEditorStub(tuiStub, editorTheme, new KeybindingsManager());
  chip.setText("USER_DRAFT");
  chip.focused = true;
  const enhanced = enhanceWithPractice(chip, editorTheme, new KeybindingsManager());
  assert.equal(enhanced, chip, "same instance: only the prototype changes");
  assert.ok(enhanced instanceof ChipEditorStub, "the foreign class identity survives");
  enhanced.openPractice();
  assert.equal(enhanced.practicing, true);
  enhanced.handleInput("LAP_TEXT");
  const lines = enhanced.render(80).join("\n");
  assert.match(lines, /输入一遍/);
  assert.match(lines, /LAP_TEXT/);
  assert.equal(enhanced.getText(), "USER_DRAFT", "lap input never reaches the base draft");
  enhanced.handleInput("\r");
  assert.equal(enhanced.practicing, false);
  enhanced.handleInput("MORE");
  assert.equal(enhanced.getText(), "USER_DRAFTMORE", "base input resumes after closing");
  enhanced.openPractice(true);
  assert.equal(enhanced.practicing, false, "automatic open never steals an in-progress draft");
  enhanced.openPractice();
  assert.equal(enhanced.practicing, true);
  enhanced.closePractice();
  assert.equal(enhanced.practicing, false);
});

let foreignBuilt = 0;
class ForeignChipEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager) {
    super(tui, theme, keys);
    foreignBuilt++;
  }
}

for (const beforeStartup of [true, false]) {
  test(`practice composes with another extension's editor set ${beforeStartup ? "before" : "after"} startup`, async () => {
    const h = uiHarness();
    foreignBuilt = 0;
    const replacement = (tui: TUI, theme: EditorTheme, keys: KeybindingsManager) => new ForeignChipEditor(tui, theme, keys);
    if (!beforeStartup) h.emit({ type: "session_start" });
    h.context.ui.setEditorComponent(replacement);
    if (beforeStartup) h.emit({ type: "session_start" });
    h.input("先梳理目标和计划");
    await flush();
    assert.notEqual(h.context.ui.getEditorComponent(), replacement, "the composed factory wraps the foreign one");
    assert.equal(foreignBuilt >= 1, true, "the foreign editor is still built");
    assert.ok(h.editor instanceof ForeignChipEditor, "the foreign instance is reused, not replaced");
    assert.ok(h.row, "practice opens on top of the composed foreign editor");
    h.type("practice lap text");
    assert.doesNotMatch(h.editor!.getText(), /practice lap/, "the foreign draft stays clean during the lap");
    h.enter();
    await flush();
    assert.equal(h.row, undefined, "Enter closes the composed lap");
    assert.match(h.lines.join("\n"), /Outline the goals first/);
    assert.equal(h.notifications.some(message => /其他扩展自定义编辑器/.test(message)), false, "no yield notification anymore");
  });
}

test("typing stores nothing and F8 still saves the lesson afterwards", async () => {
  const h = uiHarness();
  h.emit({ type: "session_start" });
  h.input("先梳理目标和计划");
  await flush();
  h.type("Outline the goals first.");
  h.enter();
  h.escape();
  await flush();
  await h.pressF8();
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0]?.english, generation.english);
});
