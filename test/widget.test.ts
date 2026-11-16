import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CoachWidget, editedSpans, markSpans, MARK_END, MARK_START, safeText } from "../src/widget.ts";
import type { CoachState } from "../src/controller.ts";

/** Render with the plain underline so assertions do not depend on the terminal running the tests. */
function plainTerminal(render: () => string[]): string[] {
  return render().map(line => line.replaceAll(MARK_START, "\x1b[4m"));
}

test("visible states wrap to rows fitting CJK/emoji terminal widths", () => {
  const states: CoachState[] = [
    { kind: "ready", english: "中英 mixed 👨‍👩‍👧‍👦 café e\u0301".repeat(20),
      grammar: { excerpt: "mixed", pattern: "形容词", explanation: "中文解释 🧑🏽‍💻".repeat(20), correction: "修正" } },
    { kind: "partial", english: "可保留的英文" },
  ];
  for (const state of states) {
    const widget = new CoachWidget(() => state, (_row, text) => "\x1b[36m" + text + "\x1b[0m");
    for (const width of [0, 1, 2, 3, 5, 8, 12, 40, 80, 200]) {
      const lines = widget.render(width);
      assert.ok(lines.length >= (state.kind === "ready" ? 2 : 1));
      if (width >= 80 && state.kind === "ready") assert.ok(lines.length > 2, "long text wraps instead of paging");
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${state.kind}, width=${width}: ${line}`);
        assert.doesNotMatch(stripTerminalSequences(line), /[\r\n\t]/);
      }
    }
  }
});

test("opaque grammar formulas stay hidden while practical explanation remains visible", () => {
  const excerpt = "Do not modify the code, and do not run npm install.";
  const state: CoachState = { kind: "ready", english: excerpt, grammar: {
    excerpt, pattern: "don't + adverb + base verb", explanation: "要说不要修改代码，可以用 Do not modify。",
  } };
  const lines = new CoachWidget(() => state).render(80);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], excerpt, "English is shown directly, without a label");
  assert.match(lines[1]!, /^语法：要说不要修改代码，可以用 Do not modify。/);
  assert.doesNotMatch(lines[1]!, /don't \+ adverb \+ base verb/);
  const feedback = new CoachWidget(() => state, (_row, text) => text, "已收藏").render(80);
  assert.equal(feedback.length, 2, "save notice shares the notes row, no extra row");
  assert.match(feedback[1]!, /^已收藏 · 语法/);
  assert.ok(feedback.every(line => visibleWidth(line) <= 80));
  assert.equal(new CoachWidget(() => ({ kind: "loading" }),
    (_row, text) => text, "已收藏").render(80).length, 0);
});

test("the submitted prompt is shown above the translation, never displacing the notice", () => {
  const state: CoachState = { kind: "ready", english: "I have a bug.", grammar: {
    excerpt: "I have", pattern: "p", explanation: "have 表状态。" } };
  const kinds: string[] = [];
  const widget = new CoachWidget(() => state, row => { kinds.push(row); return ""; }, undefined, "I has a bug.");
  const lines = widget.render(200);
  assert.deepEqual(kinds, ["input", "english", "notes"], "row kinds stay stable even when text is replaced");
  const withWords: CoachState = { ...state, words: [{ word: "bug", meaning: "缺陷" }] };
  const kinds2: string[] = [];
  new CoachWidget(() => withWords, row => { kinds2.push(row); return ""; }, undefined, "I has a bug.").render(200);
  assert.deepEqual(kinds2, ["input", "english", "words", "notes"], "words sit between the English and the grammar");
  const visible = new CoachWidget(() => state, (row, text) => text, undefined, "I has a bug.").render(200);
  assert.deepEqual(visible, ["原文：I has a bug.", "I have a bug.", "语法：have 表状态。"]);
  const partial = new CoachWidget(() => ({ kind: "partial", english: "Second." }),
    (_row, text) => text, undefined, "second").render(200);
  assert.deepEqual(partial, ["原文：second", "Second."], "no invented note when grammar is unavailable");
  // Multiline and hostile input collapses into one sanitized line.
  assert.equal(new CoachWidget(() => state, (_row, text) => text, undefined, "a\nb").render(200)[0], "原文：a b");
  // No or blank prompt keeps the two-row layout for older callers.
  assert.deepEqual(new CoachWidget(() => state).render(200), ["I have a bug.", "语法：have 表状态。"]);
  // SHOW_ORIGINAL=false hides the submitted line even when the prompt is known.
  const hidden = new CoachWidget(() => state, (_row, text) => text, undefined, "I has a bug.", false).render(200);
  assert.deepEqual(hidden, ["I have a bug.", "语法：have 表状态。"]);
  assert.equal(new CoachWidget(() => state, (_row, text) => text, undefined, " \n ").render(200).length, 2);
  // The save notice still prepends to the notes row only.
  const notice = new CoachWidget(() => state, (_row, text) => text, "已收藏", "I has a bug.").render(200);
  assert.deepEqual(notice, ["原文：I has a bug.", "I have a bug.", "已收藏 · 语法：have 表状态。"]);
  // Long prompts wrap fully like every other row.
  const long = new CoachWidget(() => state, (_row, text) => text, undefined, "长输入 ".repeat(30) + "END").render(20);
  assert.ok(long.length > 3, "the prompt wraps onto more rows");
  assert.ok(long.every(line => visibleWidth(line) <= 20));
  assert.match(stripTerminalSequences(long.join(" ")).replace(/\s+/g, " "), /END I have a bug/, "the whole prompt is visible, in order, before the translation");
});

test("the wrong word in the original and the fixed word in the English are underlined", () => {
  const state: CoachState = { kind: "ready", english: "He doesn't know how to fix this bug.", grammar: {
    excerpt: "He doesn't know", pattern: "主语是 he", explanation: "主语 He 是第三人称单数，所以用 doesn't。",
    correction: "He don't → He doesn't" } };
  const widget = new CoachWidget(() => state, (_row, text) => text, undefined, "He don't know how to fix this bug.");
  const plain = plainTerminal(() => widget.render(200));
  assert.equal(plain[0], "原文：\x1b[4mHe don't\x1b[24m know how to fix this bug.");
  assert.equal(plain[1], "\x1b[4mHe doesn't\x1b[24m know how to fix this bug.");
  // The notes row keeps the plain textual correction; only the two English rows are marked.
  assert.match(plain[2]!, /^语法：主语 He 是第三人称单数，所以用 doesn't。；纠正：He don't → He doesn't$/);
  assert.ok(widget.render(200).every(line => visibleWidth(line) <= 200));
});

test("marks never break wrapping, width limits or the escape pairing", () => {
  const state: CoachState = { kind: "ready", english: "Yesterday I went to the meeting and discussed it.", grammar: {
    excerpt: "went to the meeting", pattern: "过去的事", explanation: "Yesterday 说明是过去，动作要用过去式。",
    correction: "go → went；discuss → discussed" } };
  const widget = new CoachWidget(() => state, (_row, text) => text, undefined, "Yesterday I go to the meeting and discuss it");
  for (const width of [1, 2, 3, 6, 12, 20, 40, 200]) {
    const lines = plainTerminal(() => widget.render(width));
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width=${width}: ${line}`);
    // Narrow columns wrap between every character, so compare the text without its line breaks.
    const joined = stripTerminalSequences(lines.join("")).replace(/\s+/g, "");
    assert.ok(joined.includes("YesterdayIgotothemeetinganddiscussit"), `width=${width} keeps the original`);
    assert.ok(joined.includes("YesterdayIwenttothemeetinganddiscussed it".replace(/ /g, "")), `width=${width} keeps the fix`);
    // Every opened underline is closed again; an unbalanced run would bleed into the next row.
    for (const line of lines) assert.equal((line.match(/\x1b\[4m/g) ?? []).length, (line.match(/\x1b\[24m/g) ?? []).length);
  }
});

test("marks follow the correction pairs and stay out of rows without them", () => {
  const plain: CoachState = { kind: "ready", english: "I have a question.", grammar: {
    excerpt: "I have", pattern: "主语是 I", explanation: "主语是 I 时用 have。" } };
  assert.deepEqual(new CoachWidget(() => plain, (_r, t) => t, undefined, "I has a question.").render(200),
    ["原文：I has a question.", "I have a question.", "语法：主语是 I 时用 have。"]);
  const partial: CoachState = { kind: "partial", english: "Hello." };
  assert.equal(markSpans("Hello.", []), "Hello.", "no phrases means no marks");
  // A word inside another word is not a hit; the first hit is marked, later ones are left alone.
  assert.equal(markSpans("He is this one; is it?", ["is"], "\x1b[4m"), "He \x1b[4mis\x1b[24m this one; is it?");
  assert.equal(markSpans("Don't stop", ["don't"], "\x1b[4m"), "\x1b[4mDon't\x1b[24m stop");
  assert.deepEqual(editedSpans("go → went；discuss → discussed"), { before: ["go", "discuss"], after: ["went", "discussed"] });
  assert.deepEqual(editedSpans(undefined), { before: [], after: [] });
  assert.deepEqual(editedSpans("no arrow here"), { before: [], after: [] });
  assert.equal(new CoachWidget(() => partial, (_r, t) => t, undefined, "hi").render(200)[0], "原文：hi");
});

test("the mark asks for a wavy underline but keeps the plain one as a fallback", () => {
  // Both SGR sequences are emitted: unknown 4:3 parameters are ignored, leaving the solid underline.
  assert.equal(MARK_START, "\x1b[4m\x1b[4:3m");
  assert.equal(MARK_END, "\x1b[24m");
  const marked = markSpans("He don't know", ["don't"]);
  assert.equal(marked, `He ${MARK_START}don't${MARK_END} know`);
  assert.equal(visibleWidth(marked), "He don't know".length, "the escapes take no columns");
  const wrapped = wrapTextWithAnsi(marked, 8);
  assert.ok(wrapped.every(part => visibleWidth(part) <= 8));
  assert.equal(stripTerminalSequences(wrapped.join(" ")).replace(/\s+/g, " "), "He don't know");
});

test("hidden widget renders zero lines and no borders/padding", () => {
  for (const state of [
    { kind: "idle" }, { kind: "idle", message: "学习已开启" }, { kind: "loading" },
    { kind: "error", message: "请求失败" }, { kind: "skipped", reason: "图片" },
    { kind: "disabled", reason: "缺少密钥", hidden: false },
    { kind: "disabled", reason: "off", hidden: true },
  ] satisfies CoachState[]) {
    assert.deepEqual(new CoachWidget(() => state).render(80), []);
  }
  const widget = new CoachWidget(() => ({ kind: "partial", english: "hello" }));
  assert.equal(widget.render(80)[0], "hello");
});

test("strip hostile ANSI/OSC/APC/control/bidi and Unicode line separators before theming", () => {
  const hostile = "\x1b[31mRED\x1b[0m\x1b]8;;https://evil.invalid\x07link\x1b]8;;\x07" +
    "\x1b]52;c;SECRET\x07\x1b_Phidden\x1b\\\x9b31mC1\x9b0m\r\n\t\x00\b\u202eevil\u2066\u2028\u2029END";
  const sanitized: string[] = [];
  const widget = new CoachWidget(() => ({ kind: "partial", english: hostile }), (_row, text) => {
    sanitized.push(text);
    assert.doesNotMatch(text, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    assert.doesNotMatch(text, /evil.invalid|SECRET|hidden|https:|31m/);
    return text;
  });
  assert.equal(widget.render(200).length, 1, "no grammar row when the grammar is unavailable");
  assert.ok(sanitized[0]?.includes("RED"));
  assert.doesNotMatch(safeText(hostile), /[\p{Cc}\p{Cf}]/u);
});

test("words and grammar get a row each, and a missing part simply has no row", () => {
  const words = [{ word: "hard-coded", meaning: "写死的" }, { word: "sign-off", meaning: "验收确认" }];
  const ready: CoachState = { kind: "ready", english: "Nothing is hard-coded.", words, grammar: {
    excerpt: "Nothing is", pattern: "nothing 自带否定", explanation: "nothing 后面不再加 not。" } };
  assert.deepEqual(new CoachWidget(() => ready).render(200), [
    "Nothing is hard-coded.",
    "词：hard-coded 写死的 · sign-off 验收确认",
    "语法：nothing 后面不再加 not。",
  ]);
  // Invalid grammar keeps the words and drops only the grammar row; nothing is invented in its place.
  const partial: CoachState = { kind: "partial", english: "Nothing is hard-coded.", words };
  assert.deepEqual(new CoachWidget(() => partial).render(200),
    ["Nothing is hard-coded.", "词：hard-coded 写死的 · sign-off 验收确认"]);
  assert.deepEqual(new CoachWidget(() => ({ kind: "partial", english: "Second." })).render(200), ["Second."]);
  // Grammar without words is two rows, words without grammar is two rows.
  const noWords: CoachState = { kind: "ready", english: "Keep it.", grammar: { excerpt: "Keep", pattern: "p", explanation: "短。" } };
  assert.equal(new CoachWidget(() => noWords).render(200).length, 2);
  const lines = new CoachWidget(() => ready).render(20);
  assert.ok(lines.length > 3, "long words and grammar wrap onto more rows");
});

test("long English and notes wrap completely without splitting CJK or emoji, short text stays two rows", () => {
  const english = "Hello 😀 世界 " + "word ".repeat(40) + "END";
  const state: CoachState = { kind: "ready", english, grammar: {
    excerpt: "Hello", pattern: "p", explanation: "中文说明".repeat(20) + "结束" } };
  let color = "31";
  const widget = new CoachWidget(() => state, (row, text) => `\x1b[${color}m${row === "english" ? "E" : "N"}${text}\x1b[0m`);
  const lines = widget.render(20);
  assert.ok(lines.every(line => visibleWidth(line) <= 20));
  const plain = lines.map(line => stripTerminalSequences(line));
  const english_rows = plain.filter(line => line.startsWith("E")).map(line => line.slice(1));
  const note_rows = plain.filter(line => line.startsWith("N")).map(line => line.slice(1));
  assert.ok(english_rows.length > 3 && note_rows.length > 3);
  assert.deepEqual(plain.map(line => line[0]), [...english_rows.map(() => "E"), ...note_rows.map(() => "N")], "English rows come first");
  assert.equal(english_rows.join(" ").replace(/\s+/g, " ").trim(), safeText(english), "every word is shown once, in order");
  assert.match(note_rows.join(""), /结束$/);
  assert.ok(lines.every(line => /^\x1b\[31m/.test(line)), "each row is colored separately");
  color = "32";
  assert.match(widget.render(20)[0]!, /\x1b\[32m/, "theme is evaluated on every render");
  const short = new CoachWidget(() => ({ kind: "ready", english: "Keep it.", grammar: { excerpt: "Keep", pattern: "p", explanation: "短。" } }));
  assert.equal(short.render(80).length, 2);
  for (const width of [1, 2, 3]) {
    const narrow = new CoachWidget(() => ({ kind: "partial", english: "ABCDE" })).render(width);
    assert.ok(narrow.every(line => visibleWidth(line) <= width));
    assert.equal(narrow.filter(line => /[A-E]/.test(line)).join(""), "ABCDE", `width=${width}`);
  }
});
