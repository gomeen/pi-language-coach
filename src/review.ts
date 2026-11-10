import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Grammar, Word } from "./generate.ts";
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
      // Whitelist fields: do not propagate unknown metadata into the HTML.
      const lesson: SavedLesson = {
        id: value.id, savedAt: value.savedAt, original: value.original, english: value.english,
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

const PAGE_SIZE = 10;

/** Prev / page counter / next; the grid keeps the counter centered when a side is absent. */
function pager(page: number, total: number): string {
  return `<nav class="pager" aria-label="翻页">${page > 1 ? `<a class="prev" rel="prev" href="#p${page - 1}">‹ 上一页</a>` : "<span></span>"}<span>第 ${page} / ${total} 页</span>${page < total ? `<a class="next" rel="next" href="#p${page + 1}">下一页 ›</a>` : "<span></span>"}</nav>`;
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

/** Static, escaped HTML: no scripts, remote assets, server, API calls or embedded JSON.
 *  Over PAGE_SIZE lessons the list splits into pure-CSS (`:target`) pages inside this one offline file. */
export function renderReview(data: ReviewData): string {
  const renderLesson = (lesson: SavedLesson): string => {
    const grammar = lesson.grammar;
    const vocabulary = lesson.words?.length ? `
<p class="words"><span class="grammar-label">词语</span>${lesson.words
      .map(({ word, meaning }) => `<span lang="en">${escape(word)}</span> ${escape(meaning)}`).join("　·　")}</p>` : "";
    return `<article class="lesson">
<p class="source">${escape(lesson.original)}</p>
<p class="english" lang="en">${renderEnglish(lesson)}</p>${vocabulary}${grammar ? `
<div class="grammar"><p class="explanation"><span class="grammar-label">语法</span>${escape(grammar.explanation)}</p>${grammar.correction ? `
<p class="correction">纠正：${escape(grammar.correction)}</p>` : ""}</div>` : ""}
</article>`;
  };
  const pages = Math.ceil(data.lessons.length / PAGE_SIZE);
  const list = pages <= 1
    ? `<div class="reading-list">${data.lessons.map(renderLesson).join("\n") || `<p class="notice">${data.skipped ? "暂无可显示的收藏。" : "还没有收藏。返回 Pi，按 F8 或输入 /coach save 收藏当前表达。"}</p>`}</div>`
    : Array.from({ length: pages }, (_, page) => `<section class="page" id="p${page + 1}"><div class="reading-list">${data.lessons
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(renderLesson).join("\n")}</div>${pager(page + 1, pages)}</section>`).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>表达收藏</title>
<style>
:root{color-scheme:light;--paper:#f7f7f2;--card:#fffefa;--ink:#292e28;--muted:#72786b;--line:#dedfd4}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:900px;margin:auto;padding:34px 28px 64px}
header{margin-bottom:23px}
h1{margin:0;font-size:20px;font-weight:550;letter-spacing:-.4px}
.reading-list{display:grid;gap:16px}
.page{display:none}
.page:target{display:block}
body:not(:has(.page:target)) .page:first-of-type{display:block}
@supports not selector(:has(*)){.page{display:block}}
.pager{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;margin-top:2px;font-size:13px;color:var(--muted)}
.pager .prev{justify-self:start}
.pager .next{justify-self:end}
.pager a{color:inherit;text-decoration:none;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 14px;white-space:nowrap}
.pager a:hover{border-color:var(--muted)}
.lesson{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:24px 28px;min-width:0}
.source{margin:0 0 10px;color:var(--muted);font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.english{margin:0;font:25px/1.6 Georgia,"Times New Roman",serif;letter-spacing:-.25px;white-space:pre-wrap;overflow-wrap:anywhere}
mark{color:inherit;background:none;text-decoration:underline;text-decoration-color:#9aa986;text-decoration-thickness:2px;text-underline-offset:5px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.grammar{margin-top:19px;border-top:1px solid #e8e9df;padding-top:13px;color:var(--muted);font-size:13px}
.grammar-label{margin-right:11px;font:11px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--muted)}
.words{margin:13px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.explanation,.correction{margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.explanation{margin-top:0}
.notice{color:var(--muted)}
::selection{background:#dce5cd;color:#24321e}
@media(max-width:600px){main{padding:24px 16px 40px}header{margin-bottom:18px}h1{font-size:19px}.lesson{padding:20px 18px}.english{font-size:23px}}
@media print{.page{display:block}.pager{display:none}}
</style>
</head>
<body><main>
<header><h1>表达收藏</h1></header>
${data.skipped ? `<p class="notice">有 ${data.skipped} 条收藏无法读取，已跳过；原文件未修改。</p>` : ""}
${list}
</main></body>
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
