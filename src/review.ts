import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Grammar, Word } from "./generate.ts";
import { stripImageReferences } from "./input.ts";
import type { Lesson } from "./storage.ts";

interface SavedLesson extends Lesson {
  id: string;
  savedAt: string;
}
export interface ReviewData {
  lessons: SavedLesson[];
  skipped: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function grammar(value: unknown): value is Grammar {
  return object(value) && text(value.excerpt) && text(value.pattern) && text(value.explanation)
    && (value.correction === undefined || text(value.correction));
}
function words(value: unknown): value is Word[] {
  return Array.isArray(value) && value.every(item => object(item) && text(item.word) && text(item.meaning));
}

/** Only saved record files are read; snapshots, temporary files and symlinks are ignored. */
export async function loadLessons(directory: string): Promise<ReviewData> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lessons: [], skipped: 0 };
    throw error;
  }
  const result: ReviewData = { lessons: [], skipped: 0 };
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
      if (!object(value) || value.version !== 1 || !text(value.id) || value.id !== entry.name.slice(0, -5)
        || !text(value.savedAt) || !Number.isFinite(Date.parse(value.savedAt))
        || !text(value.original) || !text(value.english)
        || (value.grammar !== undefined && !grammar(value.grammar))
        || (value.words !== undefined && !words(value.words))) {
        result.skipped++;
        continue;
      }
      // Whitelist fields: do not propagate unknown metadata into the HTML. Records saved before image
      // locations were dropped still render them as 「图片」, so no local path reaches the page.
      const lesson: SavedLesson = {
        id: value.id, savedAt: value.savedAt, original: stripImageReferences(value.original), english: value.english,
      };
      if (grammar(value.grammar)) {
        const { excerpt, pattern, explanation, correction } = value.grammar;
        lesson.grammar = { excerpt, pattern, explanation, ...(correction ? { correction } : {}) };
      }
      if (words(value.words) && value.words.length) {
        lesson.words = value.words.map(({ word, meaning }) => ({ word, meaning }));
      }
      result.lessons.push(lesson);
    } catch {
      result.skipped++;
    }
  }
  result.lessons.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || a.id.localeCompare(b.id));
  return result;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}
function renderEnglish(lesson: Lesson): string {
  const excerpt = lesson.grammar?.excerpt;
  const start = excerpt ? lesson.english.indexOf(excerpt) : -1;
  if (!excerpt || start < 0) return escape(lesson.english);
  return escape(lesson.english.slice(0, start)) + `<mark>${escape(excerpt)}</mark>`
    + escape(lesson.english.slice(start + excerpt.length));
}

/** Orca's bundled UI font (same variable file the app ships, weights 100–900), embedded so the
 *  offline page renders exactly like Orca even though Geist is not installed system-wide. Missing
 *  file silently falls back to the system stack, which is what Orca uses for Chinese anyway. */
const GEIST: string = (() => {
  try {
    return readFileSync(new URL("./fonts/Geist-Variable.woff2", import.meta.url)).toString("base64");
  } catch {
    return "";
  }
})();

const PAGE_SIZE = 10;

/** Only the pages near this one, so the gutter stays a handful of buttons however large the
 *  collection gets: first, last, the current page and its two neighbours. */
function pageNumbers(page: number, total: number): number[] {
  const shown = new Set<number>([1, total]);
  if (total <= 9) {
    for (let number = 1; number <= total; number++) shown.add(number);
  } else {
    for (let number = page - 2; number <= page + 2; number++) {
      if (number >= 1 && number <= total) shown.add(number);
    }
  }
  return [...shown].sort((a, b) => a - b);
}

/** Each page carries its own rail, sticky inside that page. Because only one page fits the window at
 *  a time, exactly one rail is ever on screen — and it always knows where it is. */
function rail(page: number, total: number): string {
  const parts: string[] = [];
  let previous = 0;
  for (const number of pageNumbers(page, total)) {
    if (previous && number - previous > 1) parts.push(`<span class="ellipsis" aria-hidden="true">…</span>`);
    parts.push(number === page
      ? `<span class="current" aria-current="page">${number}</span>`
      : `<a href="#p${number}" title="第 ${number} 页">${number}</a>`);
    previous = number;
  }
  const back = page > 1
    ? `<a class="step" rel="prev" href="#p${page - 1}" title="上一页" aria-label="上一页">↑</a>`
    : `<span class="step gap" aria-hidden="true">↑</span>`;
  const next = page < total
    ? `<a class="step" rel="next" href="#p${page + 1}" title="下一页" aria-label="下一页">↓</a>`
    : `<span class="step gap" aria-hidden="true">↓</span>`;
  return `<nav class="rail" aria-label="第 ${page} 页 / 共 ${total} 页">${back}<span class="pages">${parts.join("")}</span>${next}</nav>`;
}

/** Static, escaped HTML: no remote assets, server, API calls or embedded JSON. Chunks of PAGE_SIZE
 *  lessons become one screenful each; one inline script turns the wheel into page flips. */
export function renderReview(data: ReviewData): string {
  const renderLesson = (lesson: SavedLesson): string => {
    const grammar = lesson.grammar;
    const vocabulary = lesson.words?.length ? `
<p class="words"><span class="grammar-label">词语</span>${lesson.words
      .map(({ word, meaning }) => `<span lang="en">${escape(word)}</span> ${escape(meaning)}`).join("　·　")}</p>` : "";
    return `<article class="lesson">
<p class="source" title="${escape(lesson.original)}">${escape(lesson.original)}</p>
<p class="english" lang="en" title="${escape(lesson.english)}">${renderEnglish(lesson)}</p>${vocabulary}${grammar ? `
<div class="grammar"><p class="explanation"><span class="grammar-label">语法</span>${escape(grammar.explanation)}</p>${grammar.correction ? `
<p class="correction">纠正：${escape(grammar.correction)}</p>` : ""}</div>` : ""}
</article>`;
  };
  const pages = Math.ceil(data.lessons.length / PAGE_SIZE);
  const list = pages <= 1
    ? `<div class="reading-list">${data.lessons.map(renderLesson).join("\n") || `<p class="notice">${data.skipped ? "暂无可显示的收藏。" : "还没有收藏。返回 Pi，按 F8 或输入 /coach save 收藏当前表达。"}</p>`}</div>`
    : `${Array.from({ length: pages }, (_, index) => `<span class="state" id="p${index + 1}"></span>`).join("")}\n${Array.from({ length: pages }, (_, index) => {
      const page = index + 1;
      return `<section class="page" aria-label="第 ${page} 页"><div class="reading-list">${data.lessons
        .slice(index * PAGE_SIZE, page * PAGE_SIZE).map(renderLesson).join("\n")}</div>\n${rail(page, pages)}\n<p class="page-mark" aria-hidden="true">${page} / ${pages}</p></section>`;
    }).join("\n")}`;
  /** One rule per page: its marker's :target lights exactly that page. Built here so the stylesheet
   *  stays in sync with the page count. */
  const pageRules = Array.from({ length: pages }, (_, index) => `#p${index + 1}:target~.page:nth-of-type(${index + 1}){display:grid}`).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>表达收藏</title>
<style>
:root{color-scheme:light;--paper:#f7f7f2;--card:#fffefa;--ink:#292e28;--muted:#72786b;--line:#dedfd4}
*{box-sizing:border-box}
${GEIST ? `@font-face{font-family:Geist;src:url(data:font/woff2;base64,${GEIST})format("woff2");font-weight:100 900;font-style:normal;font-display:swap}\n` : ""}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.7 "Geist",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
main{max-width:2100px;margin:auto;padding:24px clamp(16px,2.6vw,40px) 40px}
header{position:sticky;top:0;z-index:2;display:flex;align-items:baseline;gap:14px;padding:10px 0 12px;background:var(--paper)}
h1{margin:0;font-size:20px;font-weight:550;letter-spacing:-.4px}
.count{margin:0;color:var(--muted);font-size:13px}
/* Wide windows get as many columns as fit, so the sides are used instead of padded away. Cards keep
   their own height, but one clamp plus one min-height below keep that height from swinging wildly. */
.reading-list{column-width:340px;column-gap:18px}
.lesson{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:20px 22px;margin:0 0 18px;break-inside:avoid;min-width:0;min-height:236px}
/* One page at a time, swapped by hash: nothing scrolls, so two pages can never share the screen.
   .state anchors are position:fixed, so jumping between pages never scrolls the document. A page
   taller than the window (narrow screens) scrolls inside itself until its edge, then the wheel
   flips the page. */
html,body{overflow:hidden;height:100%}
.state{position:fixed;top:0;left:0;width:0;height:0;pointer-events:none}
@keyframes page-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
@keyframes page-out{from{opacity:1;transform:none}to{opacity:0;transform:scale(1.07)}}
.page{display:none;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"cards rail" "mark mark";column-gap:16px;align-content:center;height:calc(100vh - 58px);overflow:auto}
/* Only the card grid animates; the pager is outside this element, so it never moves a pixel. */
.page.anim .reading-list{animation:page-in .4s cubic-bezier(.2,.8,.3,1) both}
.page.anim-out .reading-list{animation:page-out .26s cubic-bezier(.5,0,.8,.5) both}
@media(prefers-reduced-motion:reduce){.page.anim .reading-list,.page.anim-out .reading-list{animation:none}}
body:not(:has(.state:target)) .page:first-of-type{display:grid}
@supports not selector(:has(*)){.page:first-of-type{display:grid}}
${pages > 1 ? pageRules : ""}
.reading-list{grid-area:cards}
.page-mark{grid-area:mark;margin:8px 0 0;color:var(--line);font-size:11px;text-align:right;font-variant-numeric:tabular-nums}
/* Each page carries its own rail: it sticks while its page is on screen and leaves with it, so only
   one rail is ever visible and it always shows the right page. */
.rail{grid-area:rail;position:sticky;top:calc(50vh - 40px);align-self:start;margin-bottom:120px;display:flex;flex-direction:column;align-items:center;gap:5px;padding-top:2px;font-size:13px;line-height:1;color:var(--muted)}
.rail a{color:inherit;text-decoration:none;display:flex;flex:0 0 auto;align-items:center;justify-content:center;width:32px;height:24px;border:1px solid var(--line);border-radius:999px;background:var(--card);font-variant-numeric:tabular-nums;font-size:12px}
.rail a:hover{border-color:var(--muted);color:var(--ink)}
.rail .current{display:flex;align-items:center;justify-content:center;width:32px;height:24px;border:1px solid var(--ink);border-radius:999px;background:var(--ink);color:var(--paper);font-variant-numeric:tabular-nums;font-size:12px}
.rail .pages{display:flex;flex-direction:column;align-items:center;gap:5px}
.rail .ellipsis{color:var(--line)}
.rail .step.gap{opacity:.3}
/* The original prompt can be a multi-line paste of paths; two lines plus the hover title keep it
   from dominating the card, and print expands it again. */
.source{margin:0 0 10px;color:var(--muted);font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
/* A pasted mega-prompt can translate into a wall of text that dwarfs every neighbouring card.
   Six lines plus the hover title keep the card height in the same league as the rest; print expands. */
.english{margin:0;font:21px/1.55 "Geist",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;letter-spacing:-.2px;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden}
mark{color:inherit;background:none;text-decoration:underline;text-decoration-color:#9aa986;text-decoration-thickness:2px;text-underline-offset:5px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.grammar{margin-top:15px;border-top:1px solid #e8e9df;padding-top:11px;color:var(--muted);font-size:13px}
.grammar-label{margin-right:11px;font:11px "Geist",-apple-system,BlinkMacSystemFont,sans-serif;color:var(--muted)}
.words{margin:11px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.explanation,.correction{margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.explanation{margin-top:0}
.notice{color:var(--muted)}
::selection{background:#dce5cd;color:#24321e}
@media(max-width:900px){
.page{grid-template-columns:minmax(0,1fr);grid-template-areas:"cards" "rail" "mark";min-height:calc(100vh - 52px)}
.rail{position:sticky;top:auto;bottom:0;flex-direction:row;justify-content:center;flex-wrap:wrap;gap:6px;margin-top:14px;padding:9px 0;background:var(--paper);box-shadow:0 -1px 0 var(--line)}
.rail .pages{flex-direction:row;flex-wrap:wrap;gap:6px}
}
@media(max-width:600px){main{padding:24px 16px 80px}header{margin-bottom:18px}h1{font-size:19px}.lesson{padding:18px 18px;min-height:0}.english{font-size:20px}}
@media print{header{position:static}.rail,.page-mark{display:none}.page{display:block;min-height:0;margin-bottom:0;scroll-margin-top:0;break-after:page}.source,.english{-webkit-line-clamp:none;display:block}}
</style>
</head>
<body><main id="top">
<header><h1>表达收藏</h1>${data.lessons.length ? `<p class="count">共 ${data.lessons.length} 条</p>` : ""}</header>
${data.skipped ? `<p class="notice">有 ${data.skipped} 条收藏无法读取，已跳过；原文件未修改。</p>` : ""}
${list}
</main>${pages > 1 ? `
<script>
"use strict";
// Wheel = page turn: accumulate notches silently, flip after ~400px (4 notches). A page taller than
// the window (narrow screens) scrolls inside itself first; the wheel only flips once it is at an
// edge. Keyboard and the rail links keep working as before. No data leaves the file.
(() => {
  const states = document.querySelectorAll(".state");
  if (!states.length) return;
  let current = 1, accumulator = 0, cooldown = 0;
  const THRESHOLD = 400, COOLDOWN = 450;
  const totalPages = states.length;
  const pageAt = index => document.querySelector(".page:nth-of-type(" + index + ")");
  const go = page => { if (page >= 1 && page <= totalPages && page !== current) flip(page); };
  /** Leaving page fades/slides out, then the hash flips and the arriving page animates in — a page
   *  turn you can see, while only one page is ever visible. */
  const flip = page => {
    const leaving = pageAt(current);
    const done = () => location.hash = "#p" + page;
    if (!leaving || getComputedStyle(leaving).animationName === "none") { done(); return; }
    leaving.classList.add("anim-out");
    leaving.addEventListener("animationend", done, { once: true });
    setTimeout(done, 320);                            // safety net if animationend never fires
  };
  addEventListener("hashchange", () => {
    const next = Math.min(totalPages, Math.max(1, Number(location.hash.slice(2)) || 1));
    const leaving = pageAt(current);
    const entering = pageAt(next);
    if (next !== current) {
      leaving?.classList.remove("anim-out", "anim");
      entering?.classList.remove("anim-out");
      // retrigger the entry animation even if the same element animated before
      entering?.classList.remove("anim");
      void entering?.offsetWidth;
      entering?.classList.add("anim");
    }
    current = next;
    accumulator = 0;
  });
  addEventListener("wheel", event => {
    if (event.ctrlKey) return;                        // keep pinch-zoom
    const page = document.querySelector(".page:nth-of-type(" + current + ")");
    const room = event.deltaY > 0 ? page.scrollHeight - page.clientHeight - page.scrollTop : page.scrollTop;
    if (room > 1) { accumulator = 0; return; }        // inner content still has room
    event.preventDefault();
    const now = Date.now();
    if (now < cooldown) return;
    accumulator += event.deltaY;
    if (Math.abs(accumulator) >= THRESHOLD) {
      go(current + (accumulator > 0 ? 1 : -1));
      accumulator = 0;
      cooldown = now + COOLDOWN;
    }
  }, { passive: false });
})();
</script>` : ""}
</body>
</html>\n`;
}

/** Fixed executable + separate argument: never interpolate a shell command. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}
async function openInBrowser(url: string): Promise<void> {
  const [command, args] = browserCommand(url);
  await promisify(execFile)(command, args, { timeout: 10_000 });
}

export class ReviewOpenError extends Error {
  constructor(readonly path: string) {
    super("无法自动打开复习页");
  }
}

/** Regenerate a private offline snapshot; concurrent invocations cannot publish partial HTML. */
export async function openReview(directory: string, opener = openInBrowser): Promise<void> {
  const html = renderReview(await loadLessons(directory));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "review.html");
  const temporary = join(directory, `.review.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, html, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  try {
    await opener(pathToFileURL(path).href);
  } catch {
    throw new ReviewOpenError(path);
  }
}
