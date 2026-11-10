import type { ExtensionAPI, ExtensionContext, CustomEditor } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Environment, type ConfigResult } from "./config.ts";
import { CoachController, type CoachState, type Generator } from "./controller.ts";
import { CoachWidget, hasResult } from "./widget.ts";
import { CoachEditor, enhanceWithPractice, type PracticeHost } from "./practice.ts";
import { saveLesson, storageDirectory, type Lesson, type SaveResult } from "./storage.ts";
import { openReview, ReviewOpenError } from "./review.ts";

const WIDGET = "language-coach";
type Context = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;
export interface Dependencies {
  environment?: () => Environment;
  generate?: Generator;
  save?: (lesson: Lesson) => Promise<SaveResult>;
  review?: () => Promise<void>;
}

export function registerLanguageCoach(
  pi: Pick<ExtensionAPI, "on" | "registerCommand" | "registerShortcut">,
  dependencies: Dependencies = {},
): void {
  let controller: CoachController | undefined;
  let settings: ConfigResult | undefined;
  let ui: Context["ui"] | undefined;
  let currentState: CoachState | undefined;
  let revision = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let autoSaveEnabled = true;
  let autoSaveOverride: boolean | undefined;
  let activeWidget: CoachWidget | undefined;
  let editor: (CustomEditor & PracticeHost) | undefined;
  let editorFactory: Parameters<Context["ui"]["setEditorComponent"]>[0];

  function cancelNotice(): void {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
  }

  function render(state: CoachState, notice?: string): void {
    if (!ui) return;
    if (!hasResult(state)) {
      // Remove the host widget too: an empty component may still leave layout spacing.
      activeWidget = undefined;
      editor?.closePractice();
      ui.setWidget(WIDGET, undefined);
      return;
    }
    ui.setWidget(WIDGET, (_tui, theme) => {
      activeWidget = new CoachWidget(() => state,
        (row, text) => theme.fg(row === "english" ? "accent" : "muted", text), notice, controller?.prompt);
      return activeWidget;
    });
  }

  async function saveAutomatically(lesson: Lesson, owner: CoachController, version: number): Promise<void> {
    try {
      await (dependencies.save ?? (entry => saveLesson(entry, storageDirectory())))(lesson);
    } catch {
      // A failed background write must not leak file paths or break the main input path.
      if (controller === owner && revision === version && ui) {
        ui.notify("自动收藏失败，请检查收藏目录与权限。", "error");
      }
    }
  }

  async function saveCurrent(ctx: Context): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const lesson = controller?.lesson();
    if (!lesson) return;
    const owner = controller;
    const version = revision;
    let notice: string;
    try {
      const result = await (dependencies.save ?? (entry => saveLesson(entry, storageDirectory())))(lesson);
      notice = result === "saved" ? "已收藏" : "已收藏过";
    } catch {
      notice = "收藏失败，请检查存储目录与权限";
    }
    // Saving a snapshot may complete after another prompt, clear, switch or shutdown.
    if (controller !== owner || revision !== version || !currentState) return;
    cancelNotice();
    render(currentState, notice);
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      if (controller === owner && revision === version && currentState) render(currentState);
    }, 1800);
    noticeTimer.unref();
  }

  function clear(): void {
    revision++;
    cancelNotice();
    editor?.closePractice();
    activeWidget = undefined;
    currentState = undefined;
    controller?.dispose();
    controller = undefined;
    ui?.setWidget(WIDGET, undefined);
    ui = undefined;
  }

  /** Own the editor component while coexisting with whoever else wants it: our plain
   * editor when none is set, otherwise practice layered onto the foreign editor. */
  function reconcileEditor(): void {
    if (!ui) return;
    const currentFactory = ui.getEditorComponent();
    if (currentFactory === editorFactory && editor) return;
    if (!currentFactory) {
      editorFactory = Object.assign(
        (tui: NonNullable<typeof editorFactory> extends (...args: infer A) => any ? A[0] : never, theme: NonNullable<typeof editorFactory> extends (...args: infer A) => any ? A[1] : never, keys: NonNullable<typeof editorFactory> extends (...args: infer A) => any ? A[2] : never) => {
          editor = new CoachEditor(tui, theme, keys);
          return editor;
        },
        { __languageCoach: process.pid },
      );
      ui.setEditorComponent(editorFactory);
      return;
    }
    // Compose with the foreign editor (for example a usage-bar chip editor) instead of
    // yielding: its instance, class and draft survive; practice just layers on top.
    const foreign = currentFactory;
    editor = undefined;
    editorFactory = Object.assign(
      (tui: NonNullable<typeof editorFactory> extends (...args: infer A) => any ? A[0] : never, theme: NonNullable<typeof editorFactory> extends (...args: infer A) => any ? A[1] : never, keys: NonNullable<typeof editorFactory> extends (...args: infer A) => any ? A[2] : never) => {
        editor = enhanceWithPractice(foreign(tui, theme, keys) as CustomEditor, theme, keys);
        return editor;
      },
      { __languageCoach: process.pid },
    );
    ui.setEditorComponent(editorFactory);
  }

  function begin(ctx: Context): CoachController | undefined {
    if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
    settings ??= loadConfig((dependencies.environment ?? (() => process.env))());
    autoSaveEnabled = autoSaveOverride ?? (settings.kind === "configured" ? settings.config.autoSave : false);
    ui = ctx.ui;
    if (settings.kind === "configured") reconcileEditor();
    if (controller) return controller;
    controller = new CoachController(settings, (state: CoachState) => {
      revision++;
      cancelNotice();
      currentState = state;
      render(state);
      if (hasResult(state)) {
        const lesson = controller?.lesson();
        if (lesson && controller) {
          // Local practice never blocks the agent or interrupts an in-progress main draft.
          openTypingRow(true);
          if (autoSaveEnabled) void saveAutomatically(lesson, controller, revision);
        }
      }
    }, dependencies.generate);
    controller.initial();
    return controller;
  }

  pi.on("session_start", (_event, ctx) => {
    clear();
    settings = undefined;
    begin(ctx);
  });
  pi.on("session_tree", () => {
    // Same session/runtime: forget branch-local data without re-enabling an opted-out user.
    controller?.command("clear");
  });
  pi.on("session_shutdown", () => {
    clear();
    settings = undefined;
  });
  pi.on("input", (event, ctx) => {
    if (ctx.mode === "tui" && ctx.hasUI && event.source === "interactive") {
      begin(ctx)?.submit(event.text, Boolean(event.images?.length));
    }
    return { action: "continue" };
  });

  /** Open the practice editor below the current result; a no-op while open. */
  function openTypingRow(automatic = false): void {
    if (!ui || !controller?.lesson() || ui.getEditorComponent() !== editorFactory) return;
    editor?.openPractice(automatic);
  }

  /** /coach practice: open the practice row without a shortcut; only Enter or Esc closes it. */
  async function openPracticeRow(ctx: Context): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    begin(ctx);
    if (!controller?.lesson()) {
      if (settings?.kind === "disabled") ctx.ui.notify("学习功能未配置或已关闭。", "warning");
      else ctx.ui.notify("还没有可输入的表达；先提交一个提示词，等结果出现。", "info");
      return;
    }
    if (!editor || ctx.ui.getEditorComponent() !== editorFactory) {
      ctx.ui.notify("当前有其他扩展自定义编辑器；为保留正常输入，暂不打开练习框。", "info");
      return;
    }
    if (editor.practicing) ctx.ui.notify("输入一遍行已打开；回车或 Esc 退出。", "info");
    else openTypingRow();
  }

  pi.registerShortcut("f8", {
    description: "收藏当前英文与语法（Language Coach）",
    handler: saveCurrent,
  });
  pi.registerCommand("coach", {
    description: "独立英语学习：on | off | retry | clear | save | practice | review | autosave on|off",
    handler: async (args, ctx) => {
      if (args.trim() === "review") {
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        try {
          await (dependencies.review ?? (() => openReview(storageDirectory())))();
        } catch (error) {
          ctx.ui.notify(error instanceof ReviewOpenError
            ? `无法自动打开浏览器，请手动打开：${error.path}`
            : "复习页生成失败，请检查收藏目录与权限。", "error");
        }
      } else if (args.trim() === "save") await saveCurrent(ctx);
      else if (args.trim() === "practice") await openPracticeRow(ctx);
      else if (args.trim() === "autosave on" || args.trim() === "autosave off") {
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        begin(ctx);
        autoSaveOverride = autoSaveEnabled = args.trim() === "autosave on";
        ctx.ui.notify(autoSaveEnabled ? "自动收藏已开启" : "自动收藏已关闭；仍可按 F8 手动收藏", "info");
      } else begin(ctx)?.command(args);
    },
  });
}

export default function languageCoach(pi: ExtensionAPI): void {
  registerLanguageCoach(pi);
}
