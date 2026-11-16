import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { CoachState } from "./controller.ts";

/** Semantic widget rows; the colorize callback keys theme colors off these. */
export type CoachRow = "input" | "english" | "words" | "notes";
export type Colorize = (row: CoachRow, text: string) => string;

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

/** Submitted prompt (when known and not hidden), then English, then notes; each wraps to as many rows as the terminal width needs. No border or padding. */
function rows(state: CoachState, prompt?: string, showOriginal = true): Array<[CoachRow, string, string[]?]> | undefined {
  if (state.kind !== "ready" && state.kind !== "partial") return undefined;
  const lines: Array<[CoachRow, string, string[]?]> = [];
  // The wrong word is marked in what was typed, the fix is marked in the English, so both are visible at once.
  const edited = state.kind === "ready" ? editedSpans(state.grammar.correction) : { before: [], after: [] };
  // Show what was typed this time above the translation for easy comparison; safeText flattens it later.
  const submitted = showOriginal ? prompt?.trim() : undefined;
  if (submitted) lines.push(["input", `原文：${submitted}`, edited.before]);
  lines.push(["english", state.english, edited.after]);
  // Words get their own row so a long list never buries the grammar point; each part is optional.
  if (state.words?.length) {
    lines.push(["words", `词：${state.words.map(({ word, meaning }) => `${word} ${meaning}`).join(" · ")}`]);
  }
  // The model's pattern field may be an opaque formula (e.g. "don't + adverb + base verb").
  // Keep it in the saved lesson, but show the practical explanation instead.
  if (state.kind === "ready") {
    const { explanation, correction } = state.grammar;
    lines.push(["notes", `语法：${explanation}${correction ? `；纠正：${correction}` : ""}`]);
  }
  return lines;
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
    const lines = rows(this.getState(), this.prompt, this.showOriginal);
    if (!lines) return [];
    const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (!columns) return lines.map(() => "");
    const noticeRow = lines.findLastIndex(([row]) => row === "notes");
    const noticeAt = noticeRow === -1 ? lines.findLastIndex(([row]) => row === "words") : noticeRow;
    return lines.flatMap(([row, line, marks], index) => {
      const sanitized = safeText(this.notice && index === noticeAt ? `${this.notice} · ${line}` : line);
      // Mark before wrapping: wrapTextWithAnsi re-emits the underline on every row it splits across.
      const text = marks?.length ? markSpans(sanitized, marks) : sanitized;
      // Wrap plain text, then color each row, so styling never splits an escape sequence.
      // A glyph wider than a very narrow terminal is clipped for display only.
      return wrapTextWithAnsi(text, columns).map(part =>
        truncateToWidth(this.colorize(row, part), columns, "…"));
    });
  }

  invalidate(): void { /* Theme and width are evaluated on every render. */ }
}
