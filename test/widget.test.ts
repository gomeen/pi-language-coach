import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { CoachWidget, safeText } from "../src/widget.ts";
import type { CoachState } from "../src/controller.ts";

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
      assert.ok(lines.length >= 2);
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
  const visible = new CoachWidget(() => state, (row, text) => text, undefined, "I has a bug.").render(200);
  assert.deepEqual(visible, ["原文：I has a bug.", "I have a bug.", "语法：have 表状态。"]);
  const partial = new CoachWidget(() => ({ kind: "partial", english: "Second." }),
    (_row, text) => text, undefined, "second").render(200);
  assert.deepEqual(partial, ["原文：second", "Second.", "语法：未取得有效语法点；英文结果已保留。"]);
  // Multiline and hostile input collapses into one sanitized line.
  assert.equal(new CoachWidget(() => state, (_row, text) => text, undefined, "a\nb").render(200)[0], "原文：a b");
  // No or blank prompt keeps the two-row layout for older callers.
  assert.deepEqual(new CoachWidget(() => state).render(200), ["I have a bug.", "语法：have 表状态。"]);
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
  assert.equal(widget.render(200).length, 2);
  assert.ok(sanitized[0]?.includes("RED"));
  assert.doesNotMatch(safeText(hostile), /[\p{Cc}\p{Cf}]/u);
});

test("word notes come before grammar on the second row and replace the failure note", () => {
  const words = [{ word: "hard-coded", meaning: "写死的" }, { word: "sign-off", meaning: "验收确认" }];
  const ready: CoachState = { kind: "ready", english: "Nothing is hard-coded.", words, grammar: {
    excerpt: "Nothing is", pattern: "nothing 自带否定", explanation: "nothing 后面不再加 not。" } };
  assert.equal(new CoachWidget(() => ready).render(200)[1], "词：hard-coded 写死的 · sign-off 验收确认 ｜ 语法：nothing 后面不再加 not。");
  const partial: CoachState = { kind: "partial", english: "Nothing is hard-coded.", words };
  assert.equal(new CoachWidget(() => partial).render(200)[1], "词：hard-coded 写死的 · sign-off 验收确认");
  const lines = new CoachWidget(() => ready).render(20);
  assert.ok(lines.length > 2, "long notes wrap onto more rows");
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
