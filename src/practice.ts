import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** App-level keys always leave practice and reach the native editor handlers. */
function isAppLevelControl(editor: CustomEditor, data: string, keys: KeybindingsManager): boolean {
  if (keys.matches(data, "app.interrupt") || keys.matches(data, "app.exit") ||
      keys.matches(data, "app.clipboard.pasteImage")) return true;
  const handlers = (editor as { actionHandlers?: Map<Parameters<KeybindingsManager["matches"]>[1], unknown> }).actionHandlers;
  return handlers !== undefined && [...handlers.keys()].some(action => keys.matches(data, action));
}

/** Keeps the main editor (including native paste storage) alive during a local practice lap.
 * Unlike ui.custom(), editor mode changes do not emit blocking UI-prompt events to Orca.
 */
export class CoachEditor extends CustomEditor {
  private practice: PracticeInput | undefined;

  constructor(tui: TUI, private readonly practiceTheme: EditorTheme, private readonly appKeys: KeybindingsManager) {
    super(tui, practiceTheme, appKeys, { embedWorkingStatus: true });
  }

  get practicing(): boolean { return this.practice !== undefined; }

  override get capturesViewportInput(): boolean {
    return this.practice?.capturesViewportInput ?? super.capturesViewportInput;
  }

  openPractice(automatic = false): void {
    // A delayed translation must not steal the next prompt's in-progress draft.
    if (this.practice || (automatic && this.getText().length > 0)) return;
    this.practice = new PracticeInput(this.tui, this.practiceTheme, () => this.closePractice());
    this.tui.requestRender();
  }

  closePractice(): void {
    if (!this.practice) return;
    this.practice = undefined;
    this.tui.requestRender();
  }

  override handleInput(data: string): void {
    if (!this.practice) { super.handleInput(data); return; }
    if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
      this.practice.handleInput(data);
      return;
    }
    // Keep native app controls (Ctrl+C, model switching, etc.) and extension shortcuts live.
    if (isAppLevelControl(this, data, this.appKeys)) {
      this.closePractice();
      super.handleInput(data);
      return;
    }
    if (this.onExtensionShortcut?.(data)) return;
    this.practice.handleInput(data);
  }

  override render(width: number): string[] {
    if (!this.practice) return super.render(width);
    this.practice.focused = this.focused;
    return this.practice.render(width);
  }

  override handleMouse(...args: Parameters<Editor["handleMouse"]>): ReturnType<Editor["handleMouse"]> {
    return this.practice ? this.practice.handleMouse(...args) : super.handleMouse(...args);
  }

  override invalidate(): void {
    super.invalidate();
    this.practice?.invalidate();
  }
}

/** Pi's native multiline editor, used only for a local typing lap, never a chat submission. */
export class PracticeInput extends Editor {
  constructor(tui: TUI, theme: EditorTheme, private readonly done: () => void) {
    super(tui, theme, { paddingX: 1 });
  }

  handleInput(data: string): void {
    // Handle empty Enter too (the base editor normally ignores an empty submission).
    if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
      this.done();
      return;
    }
    super.handleInput(data);
  }

  private labeledBorder(label: string, width: number): string {
    const text = truncateToWidth(`─ ${label} `, width, "");
    return this.borderColor(text + "─".repeat(Math.max(0, width - visibleWidth(text))));
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount ? super.renderTopBorder(width, hiddenLineCount)
      : this.labeledBorder("输入一遍", width);
  }

  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount ? super.renderBottomBorder(width, hiddenLineCount)
      : this.labeledBorder("回车结束 · Esc 退出", width);
  }
}

export interface PracticeHost {
  openPractice(automatic?: boolean): void;
  closePractice(): void;
  readonly practicing: boolean;
}

const enhancedPrototypes = new WeakMap<object, abstract new (...args: any[]) => CustomEditor>();

/** Practice-lap behavior layered ON TOP of another extension's editor. The foreign
 * instance keeps its own class, constructor state and draft; only its prototype
 * gains the practice members, so the host still duck-types it as that editor. */
export function enhanceWithPractice<T extends CustomEditor>(
  editor: T, theme: EditorTheme, keys: KeybindingsManager,
): T & PracticeHost {
  const proto = Object.getPrototypeOf(editor);
  let enhanced = enhancedPrototypes.get(proto);
  if (!enhanced) {
    enhanced = class extends (proto.constructor as abstract new (...args: any[]) => CustomEditor) {
      private practice: PracticeInput | undefined;
      private practiceTheme: EditorTheme | undefined;
      private practiceKeys: KeybindingsManager | undefined;

      rebindPractice(nextTheme: EditorTheme, nextKeys: KeybindingsManager): void {
        this.practiceTheme = nextTheme;
        this.practiceKeys = nextKeys;
      }

      get practicing(): boolean { return this.practice !== undefined; }

      override get capturesViewportInput(): boolean {
        return this.practice?.capturesViewportInput ?? super.capturesViewportInput;
      }

      openPractice(automatic = false): void {
        // A delayed translation must not steal the next prompt's in-progress draft.
        if (this.practice || (automatic && this.getText().length > 0)) return;
        this.practice = new PracticeInput(this.tui, this.practiceTheme!, () => this.closePractice());
        this.tui.requestRender();
      }

      closePractice(): void {
        if (!this.practice) return;
        this.practice = undefined;
        this.tui.requestRender();
      }

      override handleInput(data: string): void {
        if (!this.practice) { super.handleInput(data); return; }
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          this.practice.handleInput(data);
          return;
        }
        if (isAppLevelControl(this, data, this.practiceKeys!)) {
          this.closePractice();
          super.handleInput(data);
          return;
        }
        if (this.onExtensionShortcut?.(data)) return;
        this.practice.handleInput(data);
      }

      override render(width: number): string[] {
        if (!this.practice) return super.render(width);
        this.practice.focused = this.focused;
        return this.practice.render(width);
      }

      override handleMouse(...args: Parameters<Editor["handleMouse"]>): ReturnType<Editor["handleMouse"]> {
        return this.practice ? this.practice.handleMouse(...args) : super.handleMouse(...args);
      }

      override invalidate(): void {
        super.invalidate();
        this.practice?.invalidate();
      }
    };
    enhancedPrototypes.set(proto, enhanced);
  }
  Object.setPrototypeOf(editor, enhanced.prototype);
  const host = editor as T & PracticeHost & { rebindPractice(t: EditorTheme, k: KeybindingsManager): void };
  host.rebindPractice(theme, keys);
  return host;
}
