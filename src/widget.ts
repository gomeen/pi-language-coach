import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { CoachState } from "./controller.ts";

/** Semantic widget rows; the colorize callback keys theme colors off these. */
export type CoachRow = "input" | "english" | "notes";
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

export function hasResult(state: CoachState): state is Extract<CoachState, { kind: "ready" | "partial" }> {
  return state.kind === "ready" || state.kind === "partial";
}

/** Submitted prompt (when known and not hidden), then English, then notes; each wraps to as many rows as the terminal width needs. No border or padding. */
function rows(state: CoachState, prompt?: string, showOriginal = true): Array<[CoachRow, string]> | undefined {
  if (state.kind !== "ready" && state.kind !== "partial") return undefined;
  const words = state.words?.length ? `词：${state.words.map(({ word, meaning }) => `${word} ${meaning}`).join(" · ")}` : "";
  const lines: Array<[CoachRow, string]> = [];
  // Show what was typed this time above the translation for easy comparison; safeText flattens it later.
  const submitted = showOriginal ? prompt?.trim() : undefined;
  if (submitted) lines.push(["input", `原文：${submitted}`]);
  lines.push(["english", state.english]);
  if (state.kind === "partial") {
    lines.push(["notes", words || "语法：未取得有效语法点；英文结果已保留。"]);
    return lines;
  }
  // The model's pattern field may be an opaque formula (e.g. "don't + adverb + base verb").
  // Keep it in the saved lesson, but show the practical explanation instead.
  const { explanation, correction } = state.grammar;
  const grammar = `语法：${explanation}${correction ? `；纠正：${correction}` : ""}`;
  lines.push(["notes", words ? `${words} ｜ ${grammar}` : grammar]);
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
    return lines.flatMap(([row, line]) => {
      const text = safeText(row === "notes" && this.notice ? `${this.notice} · ${line}` : line);
      // Wrap plain text, then color each row, so styling never splits an escape sequence.
      // A glyph wider than a very narrow terminal is clipped for display only.
      return wrapTextWithAnsi(text, columns).map(part =>
        truncateToWidth(this.colorize(row, part), columns, "…"));
    });
  }

  invalidate(): void { /* Theme and width are evaluated on every render. */ }
}
