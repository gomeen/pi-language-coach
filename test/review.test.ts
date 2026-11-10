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
    assert.doesNotMatch(html, /示例数据|评分|<script|EXTRA_SECRET/);
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
  const html = renderReview({ skipped: 0, lessons: [{
    id: "a".repeat(64), savedAt: "2026-01-01T00:00:00Z", original: attack,
    english: `Before ${attack} after`,
    grammar: { excerpt: attack, pattern: attack, explanation: attack, correction: attack },
  }] });
  assert.doesNotMatch(html, /<script|<img|<iframe|<link|<a /i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<mark>&lt;\/p&gt;/);
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

test("over ten lessons split into pure-CSS pages with a pager; ten or fewer stay a single list", () => {
  const lessons = Array.from({ length: 25 }, (_, index) => ({
    id: String(index).padStart(64, "0"), savedAt: "2026-01-01T00:00:00Z",
    original: `原文${index}`, english: `Lesson ${index}.`,
  }));
  const html = renderReview({ skipped: 0, lessons });
  assert.equal((html.match(/<section class="page" id="p\d+">/g) ?? []).length, 3);
  assert.equal((html.match(/<article /g) ?? []).length, 25, "every lesson stays in the single offline file");
  assert.match(html, /原文0</);
  assert.match(html, /原文24</);
  assert.equal((html.match(/class="(?:prev|next)"/g) ?? []).length, 4);
  assert.match(html, /<span><\/span><span>第 1 \/ 3 页<\/span><a class="next" rel="next" href="#p2">/);
  assert.match(html, /<a class="prev" rel="prev" href="#p1">/);
  assert.match(html, /<a class="prev" rel="prev" href="#p2">/);
  assert.match(html, /<span>第 3 \/ 3 页<\/span><span><\/span><\/nav>/, "the last page has no next link");
  assert.match(html, /\.page:target\{display:block\}/);
  assert.doesNotMatch(html, /<script/i);
  const small = renderReview({ skipped: 0, lessons: lessons.slice(0, 10) });
  assert.doesNotMatch(small, /class="page"|class="pager"|第 1 \/ 1/);
  assert.equal((small.match(/<article /g) ?? []).length, 10);
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
