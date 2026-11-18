import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyFiles, periodKey, saveLesson, storageDirectory, type Lesson } from "../src/storage.ts";
import { loadLessons } from "../src/review.ts";

const lesson: Lesson = {
  original: "请先不要修改 src/index.ts。",
  english: "Don't modify src/index.ts yet.",
  grammar: { excerpt: "Don't modify", pattern: "Don't + base verb", explanations: ["否定祈使句。"] },
};

async function temporary(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "coach-storage-test-"));
  try { await run(join(root, "saved")); } finally { await rm(root, { recursive: true, force: true }); }
}

/** Monday 2026-11-16 and Wednesday 2026-11-18 are both ISO week 47; Monday 2026-11-23 is week 48. */
const MONDAY = new Date(2026, 10, 16, 9, 30);
const WEDNESDAY = new Date(2026, 10, 18, 20, 15);
const NEXT_MONDAY = new Date(2026, 10, 23, 9, 30);

test("one weekly file holds every lesson of that week, with private permissions", async () => {
  await temporary(async directory => {
    const input = { ...lesson, english: lesson.english.repeat(100), apiKey: "SECRET-EXTRA" };
    assert.equal(await saveLesson(input, directory, { now: MONDAY }), "saved");
    assert.equal(await saveLesson({ original: "你好", english: "Hello." }, directory, { now: WEDNESDAY }), "saved");
    assert.deepEqual(await readdir(directory), ["2026-W47.json"], "both lessons share the week 47 file");
    const raw = await readFile(join(directory, "2026-W47.json"), "utf8");
    const file = JSON.parse(raw);
    assert.equal(file.version, 2);
    assert.equal(file.groupBy, "week");
    assert.equal(file.period, "2026-W47");
    assert.equal(file.lessons.length, 2);
    const [first, second] = file.lessons;
    assert.equal(first.version, 1, "each record keeps the single-lesson shape review already reads");
    assert.match(first.id, /^[a-f0-9]{64}$/);
    assert.equal(first.savedAt, MONDAY.toISOString());
    assert.equal(first.original, lesson.original);
    assert.equal(first.english, input.english, "store full English, not the truncated widget");
    assert.deepEqual(first.grammar, lesson.grammar);
    assert.deepEqual(second, { version: 1, id: second.id, savedAt: WEDNESDAY.toISOString(),
      original: "你好", english: "Hello." });
    assert.doesNotMatch(raw, /SECRET-EXTRA|apiKey/, "runtime extras never reach disk");
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, "2026-W47.json"))).mode & 0o777, 0o600);
    }
    // The review page reads the bundle exactly like the old one-file-per-lesson layout.
    const data = await loadLessons(directory);
    assert.equal(data.skipped, 0);
    assert.equal(data.lessons.length, 2);
    assert.equal(data.lessons[0]!.english, "Hello.");
    assert.deepEqual(data.lessons[1]!.grammar, lesson.grammar);
  });
});

test("repeated and concurrent saves append one record and leave no lock or temporary files", async () => {
  await temporary(async directory => {
    const results = await Promise.all(Array.from({ length: 20 }, () => saveLesson(lesson, directory, { now: MONDAY })));
    assert.equal(results.filter(result => result === "saved").length, 1);
    assert.equal(results.filter(result => result === "duplicate").length, 19);
    assert.deepEqual(await readdir(directory), ["2026-W47.json"], "no lock or temporary files remain");
    const before = await readFile(join(directory, "2026-W47.json"), "utf8");
    assert.equal(await saveLesson(lesson, directory, { now: WEDNESDAY }), "duplicate",
      "a repeat later in the same week is still the same record");
    assert.equal(await readFile(join(directory, "2026-W47.json"), "utf8"), before);
    assert.equal(JSON.parse(before).lessons[0].savedAt, MONDAY.toISOString(), "the first timestamp survives");
  });
});

test("each week gets its own file; a lock left by a crashed process is reclaimed", async () => {
  await temporary(async directory => {
    assert.equal(await saveLesson(lesson, directory, { now: MONDAY }), "saved");
    assert.equal(await saveLesson(lesson, directory, { now: NEXT_MONDAY }), "saved", "a new week is a new file");
    assert.deepEqual((await readdir(directory)).sort(), ["2026-W47.json", "2026-W48.json"]);
    const week = async (name: string) => JSON.parse(await readFile(join(directory, name), "utf8"));
    assert.equal((await week("2026-W47.json")).lessons.length, 1);
    assert.equal((await week("2026-W48.json")).lessons.length, 1);
    assert.equal((await loadLessons(directory)).lessons.length, 2, "deduplication is per file, not global");

    const lock = join(directory, ".2026-W49.lock");
    await writeFile(lock, "999999");
    await utimes(lock, new Date(0), new Date(0));
    const next = new Date(2026, 10, 30, 9);
    assert.equal(await saveLesson({ original: "你好", english: "Hi." }, directory, { now: next }), "saved");
    assert.ok(!(await readdir(directory)).includes(".2026-W49.lock"), "the stale lock is gone");
  });
});

test("a live lock from another process fails the save instead of dropping the lesson", async () => {
  await temporary(async directory => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, ".2026-W47.lock"), String(process.pid));
    await assert.rejects(saveLesson(lesson, directory, { now: MONDAY }), /其他进程/);
    assert.deepEqual(await readdir(directory), [".2026-W47.lock"], "nothing was written half-way");
  });
});

test("an unreadable week file is moved aside instead of overwritten", async () => {
  await temporary(async directory => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "2026-W47.json"), "{broken");
    assert.equal(await saveLesson(lesson, directory, { now: MONDAY }), "saved");
    const names = await readdir(directory);
    const quarantine = names.find(name => name.endsWith(".corrupt.json"));
    assert.ok(quarantine, "the damaged file is kept under a hidden name");
    assert.equal(await readFile(join(directory, quarantine!), "utf8"), "{broken");
    assert.equal((await loadLessons(directory)).lessons.length, 1, "the new file is readable again");
  });
});

test("day grouping keeps one file per local day", async () => {
  await temporary(async directory => {
    assert.equal(await saveLesson(lesson, directory, { now: MONDAY, groupBy: "day" }), "saved");
    assert.equal(await saveLesson({ original: "你好", english: "Hello." }, directory,
      { now: WEDNESDAY, groupBy: "day" }), "saved");
    assert.deepEqual((await readdir(directory)).sort(), ["2026-11-16.json", "2026-11-18.json"]);
    const file = JSON.parse(await readFile(join(directory, "2026-11-16.json"), "utf8"));
    assert.equal(file.groupBy, "day");
    assert.equal(file.period, "2026-11-16");
  });
});

test("week keys follow ISO 8601 across year boundaries", () => {
  assert.equal(periodKey(MONDAY, "week"), "2026-W47");
  assert.equal(periodKey(new Date(2026, 10, 18), "day"), "2026-11-18");
  assert.equal(periodKey(new Date(2026, 0, 1), "week"), "2026-W01", "2026 starts on a Thursday");
  assert.equal(periodKey(new Date(2026, 0, 4), "week"), "2026-W01");
  assert.equal(periodKey(new Date(2026, 0, 5), "week"), "2026-W02");
  assert.equal(periodKey(new Date(2025, 11, 29), "week"), "2026-W01", "that Monday belongs to 2026");
  assert.equal(periodKey(new Date(2025, 11, 28), "week"), "2025-W52");
  assert.equal(periodKey(new Date(2026, 11, 31), "week"), "2026-W53", "a 53-week ISO year");
  assert.equal(periodKey(new Date(2026, 0, 4), "day"), "2026-01-04");
});

test("English-only results can be saved; changed content becomes a second record", async () => {
  await temporary(async directory => {
    assert.equal(await saveLesson({ original: "你好", english: "Hello." }, directory, { now: MONDAY }), "saved");
    assert.equal(await saveLesson({ original: "你好", english: "Hi." }, directory, { now: MONDAY }), "saved");
    assert.equal(await saveLesson({ original: "你好", english: "Hello.", words: [] }, directory, { now: MONDAY }),
      "duplicate", "an empty word list does not change content identity");
    const file = JSON.parse(await readFile(join(directory, "2026-W47.json"), "utf8"));
    assert.equal(file.lessons.length, 2);
    assert.ok(file.lessons.every((entry: Record<string, unknown>) => !("grammar" in entry)));
  });
});

test("storage failures reject rather than claiming success", async () => {
  await temporary(async directory => {
    await writeFile(directory, "not a directory");
    await assert.rejects(saveLesson(lesson, directory, { now: MONDAY }));
    assert.equal(await readFile(directory, "utf8"), "not a directory");
  });
});

test("legacy single-file lessons fold into their period file, keeping timestamps and a backup", async () => {
  await temporary(async directory => {
    await mkdir(directory, { recursive: true });
    const old = (id: string, savedAt: string, english: string) =>
      ({ version: 1, id, savedAt, original: "先不要实现。", english });
    const records = [
      old("a".repeat(64), "2026-11-16T09:00:00.000Z", "Don't implement yet."),
      old("b".repeat(64), "2026-11-18T09:00:00.000Z", "Don't implement anything yet."),
    ];
    for (const record of records) await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record));
    // Unreadable and hand-edited files are left exactly as they are.
    await writeFile(join(directory, `${"c".repeat(64)}.json`), "{broken");
    await writeFile(join(directory, `${"d".repeat(64)}.json`), JSON.stringify(old("e".repeat(64), "2026-11-17T00:00:00.000Z", "x")));

    const result = await migrateLegacyFiles(directory, "week", new Date(2026, 11, 1, 12));
    assert.deepEqual([result.merged, result.duplicate, result.skipped], [2, 0, 2]);
    const names = await readdir(directory);
    assert.ok(names.includes("2026-W47.json"), "both lessons land in their ISO week");
    assert.deepEqual(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(),
      [`${"c".repeat(64)}.json`, `${"d".repeat(64)}.json`], "only the readable ones moved");
    const file = JSON.parse(await readFile(join(directory, "2026-W47.json"), "utf8"));
    assert.deepEqual(file.lessons.map((entry: { savedAt: string }) => entry.savedAt),
      records.map(record => record.savedAt), "the original timestamps survive, not the migration time");
    assert.equal((await loadLessons(directory)).lessons.length, 2);

    const backup = names.find(name => name.startsWith(".backup-"));
    assert.ok(backup, "a backup directory holds the moved files");
    assert.deepEqual((await readdir(join(directory, backup!))).sort(), records.map(record => `${record.id}.json`));

    const again = await migrateLegacyFiles(directory, "week", new Date(2026, 11, 1, 12));
    assert.deepEqual([again.merged, again.duplicate, again.skipped], [0, 0, 2], "the second run only re-reports damage");
  });
});

test("storage location is separate from sessions and honors isolated agent or explicit directories", () => {
  assert.equal(storageDirectory({ PI_CODING_AGENT_DIR: "/tmp/isolated-agent" }),
    "/tmp/isolated-agent/language-coach/saved");
  assert.equal(storageDirectory({ PI_LANGUAGE_COACH_STORAGE_DIR: "/tmp/coach-only" }), "/tmp/coach-only");
  assert.throws(() => storageDirectory({ PI_LANGUAGE_COACH_STORAGE_DIR: "relative/path" }));
});
