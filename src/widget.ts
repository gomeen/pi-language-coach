import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { CoachState } from "./controller.ts";

/** Semantic widget rows; the colorize callback keys theme colors off these. */
export type CoachRow = "input" | "english" | "words" | "notes";
/** A row plus whether the run is English, so the theme can give English one color everywhere. */
export type Colorize = (row: CoachRow, text: string, english?: boolean) => string;

/** Sanitize before theming, including OSC/APC, C0/C1, bidi and Unicode line controls. */
export function safeText(text: string): string {
  // Normalize 8-bit C1 sequence introducers to the 7-bit forms understood by pi-tui.
  const c1: Record<string, string> = { "\u0090": "P", "\u0098": "X", "\u009b": "[", "\u009c": "\\", "\u009d": "]", "\u009e": "^", "\u009f": "_" };
  const normalized = text.replace(/[\u0090\u0098\u009b-\u009f]/g, char => "\x1b" + c1[char]);
  return stripTerminalSequences(normalized)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

/** A wavy underline, with a plain one in front of it: terminals that know SGR 4:3 draw the wave,
 *  the rest ignore the unknown parameter and keep the solid underline, so the mark never disappears. */
export const MARK_START = "\x1b[4m\x1b[4:3m";
/** SGR 24 turns off every underline style, so one sequence closes the mark on any terminal. */
export const MARK_END = "\x1b[24m";

/** The two sides of every "before → after" pair, in the model's own order. */
export function editedSpans(correction: string | undefined): { before: string[]; after: string[] } {
  const before: string[] = [], after: string[] = [];
  for (const part of correction?.split(/[;；]/) ?? []) {
    const change = /^\s*(.+?)\s*→\s*(.+?)\s*$/u.exec(part);
    if (!change) continue;
    before.push(change[1]!);
    after.push(change[2]!);
  }
  return { before, after };
}

/** A stretch of a row and whether it is English; the two are colored differently. */
export interface Run {
  text: string;
  english: boolean;
}

/** An SGR sequence or an English word, matched whole: an escape must never be split between two
 *  runs, or the color wrapper would land in the middle of it. */
const TOKEN = /\x1b\[[0-9;:]*[A-Za-z]|[A-Za-z][A-Za-z0-9'’._+-]*/g;

/** Split a row into English and non-English runs, so the English words quoted inside a Chinese
 *  gloss («后面接 clickable 这样的形容词») can share the translation's color. Escapes stay in the
 *  run they sit in: the wavy mark around a word survives the split instead of being broken by it. */
export function englishRuns(text: string): Run[] {
  const runs: Run[] = [];
  let at = 0;
  for (const [token] of text.matchAll(TOKEN)) {
    const start = text.indexOf(token, at);
    if (start > at) runs.push({ text: text.slice(at, start), english: false });
    // An escape is colorless punctuation as far as the split is concerned; a word is English.
    runs.push({ text: token, english: token.charCodeAt(0) !== 0x1b });
    at = start + token.length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), english: false });
  return runs;
}

/** Mark the first whole-word occurrence of each phrase; overlapping runs are merged. */
export function markSpans(text: string, phrases: readonly string[], style = MARK_START): string {
  const ranges: Array<[number, number]> = [];
  for (const phrase of phrases) {
    const clean = safeText(phrase);
    if (!clean) continue;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").exec(text);
    if (found) ranges.push([found.index, found.index + found[0].length]);
  }
  if (!ranges.length) return text;
  ranges.sort((left, right) => left[0] - right[0]);
  let marked = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    marked += text.slice(at, from) + style + text.slice(from, end) + MARK_END;
    at = end;
  }
  return marked + text.slice(at);
}

export function hasResult(state: CoachState): state is Extract<CoachState, { kind: "ready" | "partial" }> {
  return state.kind === "ready" || state.kind === "partial";
}

/** A labelled section: the label sits in front of item 1, every later item starts under it, so the
 *  numbers line up on one column instead of drifting back to the left edge. */
export interface Section {
  label: string;
  items: string[];
}

/** Submitted prompt (when known and not hidden), then English, then one numbered row per word and per
 *  grammar point; each wraps to as many rows as the terminal width needs. No border or padding. */
function sections(state: CoachState, prompt?: string, showOriginal = true):
  Array<[CoachRow, string | Section, string[]?]> | undefined {
  if (state.kind !== "ready" && state.kind !== "partial") return undefined;
  const lines: Array<[CoachRow, string | Section, string[]?]> = [];
  // The wrong word is marked in what was typed, the fix is marked in the English, so both are visible at once.
  const edited = state.kind === "ready" ? editedSpans(state.grammar.correction) : { before: [], after: [] };
  // Show what was typed this time above the translation for easy comparison; safeText flattens it later.
  const submitted = showOriginal ? prompt?.trim() : undefined;
  if (submitted) lines.push(["input", `原文：${submitted}`, edited.before]);
  lines.push(["english", `英文：${state.english}`, edited.after]);
  // One row per word: joined with «·» a long list read as a paragraph and its items were hard to pick out.
  if (state.words?.length) {
    lines.push(["words", { label: "词：", items: state.words.map(({ word, meaning }) => `${word} ${meaning}`) }]);
  }
  // The model's pattern field may be an opaque formula (e.g. "don't + adverb + base verb").
  // Keep it in the saved lesson, but show the practical explanation instead.
  if (state.kind === "ready") {
    const { explanations, correction } = state.grammar;
    lines.push(["notes", { label: "语法：", items: explanations }]);
    // The edit gets its own labelled row instead of a number: it is a fact about this sentence,
    // not a third point about how to say it, and «纠正：» is the same width as «语法：».
    if (correction) lines.push(["notes", `纠正：${correction}`]);
  }
  return lines;
}

/** One renderable row: the item's own text, the head that starts it («词：1. », «2. » or nothing),
 *  so a wrapped continuation can start under the item's text instead of at the left edge. */
interface Row { text: string; head: string }

/** Indent a section so item 2 onwards start under item 1, not under the label. */
function layout({ label, items }: Section): Row[] {
  const indent = " ".repeat(visibleWidth(label));
  return items.map((item, index) => ({ text: item, head: `${index === 0 ? label : indent}${index + 1}. ` }));
}

/** Color one rendered row run by run. The English row is English throughout, so it is colored in
 *  one piece; the word and grammar rows are split, letting the quoted English inside a Chinese gloss
 *  keep the same color as the translation. The submitted 原文 stays uniformly muted: it is what you
 *  typed, a reference for comparison, not the answer. */
function colorRow(colorize: Colorize, row: CoachRow, text: string): string {
  if (row === "input") return colorize(row, text);
  if (row === "english") return colorize(row, text, true);
  return englishRuns(text)
    .map(run => (run.english ? colorize(row, run.text, true) : colorize(row, run.text)))
    .join("");
}

/** Input, English, then notes; each wraps to as many rows as the terminal width needs. No border or padding. */
export class CoachWidget implements Component {
  constructor(
    private readonly getState: () => CoachState,
    private readonly colorize: Colorize = (_row, text) => text,
    private readonly notice?: string,
    private readonly prompt?: string,
    private readonly showOriginal = true,
  ) {}

  render(width: number): string[] {
    const lines = sections(this.getState(), this.prompt, this.showOriginal);
    if (!lines) return [];
    const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (!columns) return lines.flatMap(([, line]) => typeof line === "string" ? [""] : line.items.map(() => ""));
    // The notice rides on the first row of the last section, so it never lands below the point it belongs to.
    const notesAt = lines.findIndex(([row]) => row === "notes");
    const noticeAt = notesAt === -1 ? lines.findIndex(([row]) => row === "words") : notesAt;
    return lines.flatMap(([row, line, marks], index) => {
      const notice = this.notice && index === noticeAt ? `${this.notice} · ` : "";
      // A section renders one row per item; a plain row renders itself. Both wrap below.
      const items: Row[] = typeof line === "string" ? [{ text: line, head: "" }] : layout(line);
      return items.flatMap(({ text, head }, position) => {
        // The notice only ever prints once, but every later item of that section is shifted by its
        // width so the numbers stay in one column instead of jumping left under it.
        const first = (position === 0 ? notice : " ".repeat(visibleWidth(notice))) + head;
        const hang = visibleWidth(first);
        const sanitized = safeText(text);
        // Mark before wrapping: wrapTextWithAnsi re-emits the underline on every row it splits across.
        const marked = marks?.length ? markSpans(sanitized, marks) : sanitized;
        // Wrap the item at the width its head leaves, so «2.» and its continuation start in the
        // same column; the head itself is prepended afterwards and never eats into a wrapped row.
        const room = Math.max(1, columns - hang);
        const continuation = " ".repeat(Math.min(hang, columns - 1));
        // Wrap plain text, then color each row, so styling never splits an escape sequence.
        // A glyph wider than a very narrow terminal is clipped for display only.
        // English words keep the translation's color inside the Chinese glosses too, so the
        // word being explained and the example in a grammar point are as easy to spot as the
        // English row itself.
        return wrapTextWithAnsi(marked, room).map((part, offset) => truncateToWidth(
          colorRow(this.colorize, row, offset === 0 ? first + part : continuation + part), columns, "…"));
      });
    });
  }

  invalidate(): void { /* Theme and width are evaluated on every render. */ }
}
