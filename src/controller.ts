import type { CoachConfig, ConfigResult } from "./config.ts";
import { generate, GenerationError, type Generation } from "./generate.ts";
import type { Lesson } from "./storage.ts";
import { hasProse, stripPathsAndLinks } from "./input.ts";

export type CoachState =
  | { kind: "idle"; message?: string }
  | { kind: "loading" }
  | Generation
  | { kind: "error"; message: string }
  | { kind: "skipped"; reason: string }
  | { kind: "disabled"; reason: string; hidden: boolean };

export type Generator = (config: CoachConfig, prompt: string, signal: AbortSignal) => Promise<Generation>;

export function skipReason(text: string, images: boolean): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return images ? "纯图片输入" : "空输入";
  if (/^\/[^\s/]+(?=\s|$)/.test(trimmed)) return "斜杠命令";
  if (trimmed.startsWith("!") && !trimmed.startsWith("![")) return "Bash 命令";
  if (/^(`{3,}|~{3,})[^\n]*\n[\s\S]*\n\1\s*$/.test(trimmed)) return "纯代码块";
  const cleaned = stripPathsAndLinks(text);
  if (!hasProse(cleaned) && cleaned !== text) return "纯路径、链接或图片引用";
  return undefined;
}

/** Owns only transient coaching state. Tokens invalidate even transports that ignore abort. */
export class CoachController {
  private version = 0;
  private pending: AbortController | undefined;
  private lastPrompt: string | undefined;
  private state: CoachState;
  private enabled = true;
  private alive = true;

  constructor(
    private readonly settings: ConfigResult,
    private readonly publish: (state: CoachState) => void,
    private readonly run: Generator = generate,
  ) {
    this.state = settings.kind === "configured"
      ? { kind: "idle" }
      : { kind: "disabled", reason: settings.reason, hidden: true };
  }

  initial(): void { this.publish(this.state); }

  /** Prompt of the most recent eligible submit; the widget shows it above the translation. */
  get prompt(): string | undefined { return this.lastPrompt; }

  private cancel(): void {
    this.version++;
    this.pending?.abort();
    this.pending = undefined;
  }

  private update(state: CoachState): void {
    if (!this.alive) return;
    this.state = state;
    this.publish(state);
  }

  submit(text: string, images = false): void {
    if (!this.alive) return;
    this.cancel();
    if (!this.enabled) return;
    if (this.settings.kind === "disabled") {
      this.update({ kind: "disabled", reason: this.settings.reason, hidden: false });
      return;
    }
    const reason = skipReason(text, images);
    if (reason) {
      this.update({ kind: "skipped", reason });
      return;
    }
    this.lastPrompt = text;
    this.start(text, this.settings.config);
  }

  private start(prompt: string, config: CoachConfig): void {
    const version = this.version;
    const abort = new AbortController();
    this.pending = abort;
    this.update({ kind: "loading" });
    // A promise boundary also handles synchronous throws from injected transports.
    void Promise.resolve().then(() => {
      if (!this.alive || version !== this.version) return undefined;
      return this.run(config, stripPathsAndLinks(prompt), abort.signal);
    }).then((result) => {
      if (this.alive && version === this.version && result) this.update(result);
    }).catch((error: unknown) => {
      if (this.alive && version === this.version) {
        this.update({ kind: "error", message: error instanceof GenerationError
          ? error.message : "学习请求失败，可用 /coach retry 重试。" });
      }
    }).finally(() => {
      if (version === this.version) this.pending = undefined;
    });
  }

  command(args: string): void {
    if (!this.alive) return;
    switch (args.trim()) {
      case "off":
        this.cancel();
        this.lastPrompt = undefined;
        this.enabled = false;
        this.update({ kind: "disabled", reason: "学习已关闭", hidden: true });
        return;
      case "clear":
        this.cancel();
        this.lastPrompt = undefined;
        this.update(this.enabled ? { kind: "idle" } : { kind: "disabled", reason: "学习已关闭", hidden: true });
        return;
      case "on":
        this.enabled = true;
        if (this.settings.kind === "disabled") {
          this.update({ kind: "disabled", reason: this.settings.reason, hidden: false });
        } else if (this.state.kind !== "loading") {
          this.update({ kind: "idle", message: "学习已开启；下次交互输入将独立发送。" });
        }
        return;
      case "retry":
        this.cancel();
        if (!this.enabled) return;
        if (this.settings.kind === "disabled") {
          this.update({ kind: "disabled", reason: this.settings.reason, hidden: false });
        } else if (this.lastPrompt !== undefined) {
          this.start(this.lastPrompt, this.settings.config);
        } else {
          this.update({ kind: "skipped", reason: "没有可重试的已提交学习输入" });
        }
        return;
      default:
        // A bare/unknown command clears even an in-flight request; it must not republish or autosave later.
        this.cancel();
        this.lastPrompt = undefined;
        this.update(this.enabled ? { kind: "idle" } : { kind: "disabled", reason: "学习已关闭", hidden: true });
    }
  }

  /** Snapshot only the currently visible result, never a draft, skipped input or old response. */
  lesson(): Lesson | undefined {
    if (!this.alive || !this.enabled || this.lastPrompt === undefined ||
        (this.state.kind !== "ready" && this.state.kind !== "partial")) return undefined;
    return {
      original: this.lastPrompt,
      english: this.state.english,
      ...(this.state.kind === "ready" ? { grammar: { ...this.state.grammar } } : {}),
      ...(this.state.words?.length ? { words: this.state.words.map(({ word, meaning }) => ({ word, meaning })) } : {}),
    };
  }

  /** Clears both the UI and retained prompt; later completions cannot publish. */
  dispose(): void {
    if (!this.alive) return;
    this.cancel();
    this.lastPrompt = undefined;
    this.state = { kind: "idle" };
    this.alive = false;
  }
}
