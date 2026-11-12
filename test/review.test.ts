import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browserCommand, loadLessons, openReview, renderReview, ReviewOpenError } from "../src/review.ts";
import { saveLesson } from "../src/storage.ts";

async function temporary(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "coach-review-test-"));
  try { await run(join(root, "saved # 中文 ' &")); } finally { await rm(root, { recursive: true, force: true }); }
}

const lesson = {
  original: "先不要实现。\n保留 src/index.ts。",
  english: "Don't implement anything yet.\nKeep src/index.ts unchanged.",
  grammar: { excerpt: "Don't implement", pattern: "Don't + base verb", explanation: "否定祈使句。", correction: "保持动词原形。" },
};

test("loads complete saved records newest first, including English-only lessons", async () => {
  await temporary(async directory => {
    await saveLesson(lesson, directory);
    await saveLesson({ original: "你好", english: "Hello." }, directory);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const record = JSON.parse(await readFile(path, "utf8"));
      record.savedAt = record.english === "Hello." ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z";
      record.apiKey = "EXTRA_SECRET";
      await writeFile(path, JSON.stringify(record));
    }
    const data = await loadLessons(directory);
    assert.equal(data.skipped, 0);
    assert.equal(data.lessons.length, 2);
    assert.equal(data.lessons[0]!.english, "Hello.");
    assert.equal(data.lessons[0]!.grammar, undefined);
    assert.equal(data.lessons[1]!.english, lesson.english);
    assert.deepEqual(data.lessons[1]!.grammar, lesson.grammar);
    assert.doesNotMatch(JSON.stringify(data), /EXTRA_SECRET|apiKey/);
    const html = renderReview(data);
    assert.equal((html.match(/<article /g) ?? []).length, 2);
    assert.equal((html.match(/<div class="grammar">/g) ?? []).length, 1);
    assert.match(html, /<mark>Don&#39;t implement<\/mark>/);
    assert.match(html, /<span class="grammar-label">语法<\/span>否定祈使句。/);
    assert.doesNotMatch(html, /Don&#39;t \+ base verb/, "older saved formulas are not displayed");
    assert.match(html, /纠正：保持动词原形。/);
    assert.match(html, /\nKeep src\/index.ts unchanged\./);
    assert.doesNotMatch(html, /示例数据|评分|EXTRA_SECRET/, "two lessons fit one page, so the wheel script is not even present");
  });
});

test("malformed, unsupported and invalid records are skipped visibly without modifying originals", async () => {
  await temporary(async directory => {
    await saveLesson(lesson, directory);
    const [name] = await readdir(directory);
    const raw = await readFile(join(directory, name!), "utf8");
    const valid = JSON.parse(raw);
    const invalid: unknown[] = [null, [], { ...valid, version: 2 }, { ...valid, id: "wrong" },
      { ...valid, original: " " }, { ...valid, english: 3 }, { ...valid, savedAt: "invalid" },
      { ...valid, grammar: { pattern: "incomplete" } }, { ...valid, grammar: null }];
    for (let index = 0; index < invalid.length; index++) {
      const id = index.toString(16).padStart(64, "0");
      const value = invalid[index];
      // Match filename IDs except for the deliberately mismatched ID case.
      if (value && typeof value === "object" && !Array.isArray(value) && index !== 3) Reflect.set(value, "id", id);
      await writeFile(join(directory, `${id}.json`), JSON.stringify(value));
    }
    await writeFile(join(directory, `${"f".repeat(64)}.json`), "{broken");
    await writeFile(join(directory, "unrelated.json"), raw);
    await writeFile(join(directory, ".incomplete.tmp"), "{broken");
    await writeFile(join(directory, "review.html"), "OLD_SNAPSHOT");
    if (process.platform !== "win32") await symlink(join(directory, name!), join(directory, `${"e".repeat(64)}.json`));
    const data = await loadLessons(directory);
    assert.equal(data.lessons.length, 1);
    assert.equal(data.skipped, invalid.length + 1);
    assert.match(renderReview(data), /有 10 条收藏无法读取/);
    assert.equal(await readFile(join(directory, name!), "utf8"), raw);
    assert.equal(await readFile(join(directory, `${"f".repeat(64)}.json`), "utf8"), "{broken");
  });
});

test("all content is escaped, grammar marks only a literal match and HTML cannot run active content", () => {
  const attack = '</p><script>alert("x")</script><img src="https://evil.test" onerror="alert(1)">&';
  const single = renderReview({ skipped: 0, lessons: [{
    id: "a".repeat(64), savedAt: "2026-01-01T00:00:00Z", original: attack,
    english: `Before ${attack} after`,
    grammar: { excerpt: attack, pattern: attack, explanation: attack, correction: attack },
  }] });
  assert.doesNotMatch(single, /<script/, "a single page has no script at all");
  assert.doesNotMatch(single, /<img|<iframe|<link|<a /i, "user content never becomes active elements");
  assert.match(single, /&lt;script&gt;/, "the attack string stays escaped in content");
  assert.match(single, /<mark>&lt;\/p&gt;/);
  const html = renderReview({ skipped: 0, lessons: Array.from({ length: 25 }, (_, index) => ({
    id: String(index).padStart(64, "0"), savedAt: "2026-01-01T00:00:00Z",
    original: `原文${index}`, english: `Lesson ${index}.`,
  })) });
  const scripts = html.match(/<script[\s\S]*?<\/script>/g) ?? [];
  assert.equal(scripts.length, 1, "exactly one script exists");
  assert.ok(!scripts[0]!.includes("alert"), "it contains no user-supplied text");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  const missingExcerpt = renderReview({ skipped: 0, lessons: [{
    id: "a", savedAt: "2026-01-01", ...lesson,
    grammar: { ...lesson.grammar, excerpt: "Not in the translation" },
  }] });
  assert.doesNotMatch(missingExcerpt, /<mark>/);
  assert.match(missingExcerpt, /Don&#39;t implement anything yet/);
});

test("one page shows at a time and the wheel silently accumulates before flipping", () => {
  const lessons = Array.from({ length: 30 }, (_, index) => ({
    id: String(index).padStart(64, "0"), savedAt: "2026-01-01T00:00:00Z",
    original: `原文${index}`, english: `Lesson ${index}.`,
  }));
  const html = renderReview({ skipped: 0, lessons });
  assert.equal((html.match(/<article /g) ?? []).length, 30, "every lesson stays in the single offline file");
  assert.match(html, /原文29</);
  assert.match(html, /html,body\{overflow:hidden;height:100%\}/, "the document never scrolls");
  assert.match(html, /<span class="state" id="p1"><\/span><span class="state" id="p2"><\/span>/, "each page has a hash marker");
  assert.match(html, /\.page\{display:none/, "pages are hidden until their marker is targeted");
  assert.match(html, /#p2:target~\.page:nth-of-type\(2\)\{display:grid\}/, "exactly one page turns on");
  assert.match(html, /body:not\(:has\(\.state:target\)\) \.page:first-of-type\{display:grid\}/, "page 1 shows at load");
  assert.match(html, /height:calc\(100vh - 58px\);overflow:auto/, "a tall page scrolls inside itself");
  assert.match(html, /@keyframes page-in\{from\{opacity:0;transform:scale\(\.9\)\}/, "an arriving page scales up in");
  assert.match(html, /@keyframes page-out\{from\{opacity:1;transform:none\}to\{opacity:0;transform:scale\(1\.07\)\}/, "a leaving page recedes with a visible zoom");
  assert.match(html, /@keyframes page-out/, "a leaving page animates out before the flip");
  assert.match(html, /animationend/, "the hash flips after the leave animation finishes");
  assert.match(html, /\.page\.anim \.reading-list\{animation:page-in/, "only the card grid animates");
  assert.doesNotMatch(html, /\.page\.anim\{animation|\.page\.anim-out\{animation/, "the page container (which holds the pager) no longer animates");
  assert.doesNotMatch(html, /rail-in|pill-in|data-dir/, "no pager animations or direction tracking remain");
  assert.equal((html.match(/<nav class="rail"/g) ?? []).length, 3, "every page carries its own rail");
  assert.match(html, /<span class="step gap"[^>]*>↑<\/span><span class="pages"><span class="current" aria-current="page">1<\/span><a href="#p2"[^>]*>2<\/a><a href="#p3"[^>]*>3<\/a><\/span><a class="step" rel="next" href="#p2"/, "page 1: no prev, all three numbers, next exists");
  assert.match(html, /<p class="page-mark" aria-hidden="true">2 \/ 3<\/p>/);
  assert.match(html, /\.rail\{grid-area:rail;position:sticky/, "the rail rides along with its page");
  assert.match(html, /\.reading-list\{column-width:340px/, "wide windows get several card columns");
  assert.match(html, /@font-face\{font-family:Geist;src:url\(data:font\/woff2;base64,/, "Orca's bundled Geist is embedded for English");
  assert.match(html, /font:14px\/1.7 "Geist",-apple-system,BlinkMacSystemFont,"PingFang SC"/, "Chinese falls back to PingFang SC like Orca");
  assert.match(html, /font:21px\/1.55 "Geist",-apple-system,BlinkMacSystemFont,"Segoe UI"/, "English uses Orca's chat stack, not Georgia");
  assert.doesNotMatch(html, /Georgia/, "the old serif font is gone");
  assert.match(html, /font-src data:/, "CSP admits only the embedded font");
  assert.match(html, /-webkit-line-clamp:2/, "a long original prompt cannot dominate a card");
  assert.match(html, /min-height:236px/, "short cards keep a comparable height");
  assert.match(html, /-webkit-line-clamp:6/, "a wall of translated text cannot dwarf its neighbours");
  assert.match(html, /title="原文0"/, "the full text stays available on hover");
  assert.doesNotMatch(html, /scroll-snap/, "no snap scrolling is left");
  assert.match(html, /<script>/, "the wheel handler is the one allowed script");
  assert.match(html, /const THRESHOLD = 400/, "about four wheel notches flip the page");
  assert.match(html, /room > 1/, "a page taller than the window scrolls inside itself first");
  assert.match(html, /script-src 'unsafe-inline'/, "CSP admits exactly the inline handler");
  const small = renderReview({ skipped: 0, lessons: lessons.slice(0, 10) });
  assert.doesNotMatch(small, /<nav class="rail"|<section class="page"|class="page-mark"|<script>/, "a single page has no pagination and no script");
  assert.equal((small.match(/<article /g) ?? []).length, 10);
  const empty = renderReview({ skipped: 0, lessons: [] });
  assert.match(empty, /还没有收藏/);
  const many = renderReview({ skipped: 0, lessons: Array.from({ length: 250 }, (_, index) => lessons[index % 30]!) });
  const page7 = many.split(`<section class="page" aria-label="第 7 页"`)[1]!.split("</section>")[0]!;
  assert.equal((many.match(/<section class="page"/g) ?? []).length, 25);
  assert.match(page7, /<a href="#p1"[^>]*>1<\/a><span class="ellipsis" aria-hidden="true">…<\/span><a href="#p5"[^>]*>5<\/a><a href="#p6"[^>]*>6<\/a><span class="current" aria-current="page">7<\/span><a href="#p8"[^>]*>8<\/a><a href="#p9"[^>]*>9<\/a><span class="ellipsis" aria-hidden="true">…<\/span><a href="#p25"[^>]*>25<\/a>/, "25 pages still show only first/last/neighbours");
});

test("missing storage has a helpful empty state; filesystem errors do not masquerade as an empty list", async () => {
  await temporary(async directory => {
    assert.deepEqual(await loadLessons(directory), { lessons: [], skipped: 0 });
    assert.match(renderReview(await loadLessons(directory)), /还没有收藏/);
    assert.match(renderReview({ lessons: [], skipped: 1 }), /暂无可显示的收藏/);
    await writeFile(directory, "not a directory");
    await assert.rejects(loadLessons(directory));
    let opened = false;
    await assert.rejects(openReview(directory, async () => { opened = true; }));
    assert.equal(opened, false);
  });
});

test("review publishes a private offline snapshot, reloading data each time without touching saved JSON", async () => {
  await temporary(async directory => {
    const urls: string[] = [];
    const opener = async (url: string) => { urls.push(url); };
    await openReview(directory, opener);
    const path = join(directory, "review.html");
    assert.equal(urls[0], pathToFileURL(path).href);
    assert.ok(urls[0]!.includes("%23"), "special characters must not become URL fragments");
    assert.match(await readFile(path, "utf8"), /还没有收藏/);
    await saveLesson(lesson, directory);
    const json = (await readdir(directory)).find(name => name.endsWith(".json"))!;
    const before = await readFile(join(directory, json), "utf8");
    await openReview(directory, opener);
    const html = await readFile(path, "utf8");
    assert.match(html, /先不要实现。/);
    assert.doesNotMatch(html, /还没有收藏/);
    assert.equal(await readFile(join(directory, json), "utf8"), before);
    await Promise.all(Array.from({ length: 5 }, () => openReview(directory, opener)));
    assert.equal(await readFile(path, "utf8"), html);
    assert.deepEqual((await readdir(directory)).sort(), [json, "review.html"].sort(), "no temporary files remain");
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    await rm(join(directory, json));
    await openReview(directory, opener);
    assert.doesNotMatch(await readFile(path, "utf8"), /先不要实现/);
  });
});

test("browser failure preserves a usable HTML snapshot and reports its path without raw errors", async () => {
  await temporary(async directory => {
    await assert.rejects(openReview(directory, async () => { throw new Error("SECRET browser stderr"); }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewOpenError);
        assert.equal(error.path, join(directory, "review.html"));
        assert.doesNotMatch(error.message, /SECRET/);
        return true;
      });
    assert.match(await readFile(join(directory, "review.html"), "utf8"), /表达收藏/);
  });
});

test("browser launching uses separate arguments and no shell, including special file names", () => {
  const url = "file:///tmp/saved%20%26%20%23/review.html";
  assert.deepEqual(browserCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
  assert.deepEqual(browserCommand(url, "win32"), ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]);
});

test("old records show image locations as 「图片」 so no pasted path reaches the page", async () => {
  await temporary(async directory => {
    await saveLesson({ original: "/var/folders/2f/7ck/T/orca-paste-1794.png 看看这张图的报错",
      english: "Look at the error in this screenshot." }, directory);
    const [name] = await readdir(directory);
    const path = join(directory, name!);
    const before = await readFile(path, "utf8");
    const data = await loadLessons(directory);
    assert.equal(data.lessons[0]!.original, "「图片」 看看这张图的报错");
    const html = renderReview(data);
    assert.match(html, /「图片」 看看这张图的报错/);
    assert.doesNotMatch(html, /orca-paste|var\/folders/, "the page stays free of local paths");
    assert.equal(await readFile(path, "utf8"), before, "reading never rewrites a saved file");
  });
});

test("saved word notes round-trip to the review page; old records without words keep their id", async () => {
  await temporary(async directory => {
    const plain = { original: "你好", english: "Hello." };
    await saveLesson(plain, directory);
    const [before] = await readdir(directory);
    await saveLesson({ ...plain, words: [] }, directory);
    assert.deepEqual(await readdir(directory), [before], "an empty word list does not change content identity");
    await saveLesson({ original: "没有写死的吧", english: "Nothing is <hard-coded>.",
      words: [{ word: "<hard-coded>", meaning: "写死的 & 固定" }] }, directory);
    const data = await loadLessons(directory);
    assert.equal(data.lessons.length, 2);
    const withWords = data.lessons.find(item => item.words)!;
    assert.deepEqual(withWords.words, [{ word: "<hard-coded>", meaning: "写死的 & 固定" }]);
    const html = renderReview(data);
    assert.match(html, /<span class="grammar-label">词语<\/span><span lang="en">&lt;hard-coded&gt;<\/span> 写死的 &amp; 固定/);
    const [name] = (await readdir(directory)).filter(file => file !== before);
    const record = JSON.parse(await readFile(join(directory, name!), "utf8"));
    await writeFile(join(directory, name!), JSON.stringify({ ...record, words: [{ word: 1 }] }));
    assert.equal((await loadLessons(directory)).skipped, 1, "malformed word notes are skipped like other bad records");
  });
});
