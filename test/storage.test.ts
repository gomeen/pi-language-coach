import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveLesson, storageDirectory, type Lesson } from "../src/storage.ts";

const lesson: Lesson = {
  original: "请先不要修改 src/index.ts。",
  english: "Don't modify src/index.ts yet.",
  grammar: { excerpt: "Don't modify", pattern: "Don't + base verb", explanation: "否定祈使句。" },
};

async function temporary(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "coach-storage-test-"));
  try { await run(join(root, "saved")); } finally { await rm(root, { recursive: true, force: true }); }
}

test("explicit save stores full content and metadata with private permissions, no extra properties", async () => {
  await temporary(async directory => {
    const input = { ...lesson, english: lesson.english.repeat(100), apiKey: "SECRET-EXTRA" };
    assert.equal(await saveLesson(input, directory), "saved");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[a-f0-9]{64}\.json$/);
    const raw = await readFile(join(directory, files[0]!), "utf8");
    const record = JSON.parse(raw);
    assert.equal(record.version, 1);
    assert.equal(record.original, lesson.original);
    assert.equal(record.english, input.english, "store full English, not the truncated widget");
    assert.deepEqual(record.grammar, lesson.grammar);
    assert.ok(Number.isFinite(Date.parse(record.savedAt)));
    assert.equal(record.id + ".json", files[0]);
    assert.doesNotMatch(raw, /SECRET-EXTRA|apiKey/);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, files[0]!))).mode & 0o777, 0o600);
    }
  });
});

test("repeated and concurrent saves publish one complete record without overwriting timestamp", async () => {
  await temporary(async directory => {
    const results = await Promise.all(Array.from({ length: 20 }, () => saveLesson(lesson, directory)));
    assert.equal(results.filter(result => result === "saved").length, 1);
    assert.equal(results.filter(result => result === "duplicate").length, 19);
    const files = await readdir(directory);
    assert.equal(files.length, 1, "no temporary files remain");
    const before = await readFile(join(directory, files[0]!), "utf8");
    assert.equal(await saveLesson(lesson, directory), "duplicate");
    assert.equal(await readFile(join(directory, files[0]!), "utf8"), before);
    assert.equal(JSON.parse(before).english, lesson.english);
  });
});

test("English-only results can be saved; changed content creates a separate record", async () => {
  await temporary(async directory => {
    assert.equal(await saveLesson({ original: "你好", english: "Hello." }, directory), "saved");
    assert.equal(await saveLesson({ original: "你好", english: "Hi." }, directory), "saved");
    const records = await Promise.all((await readdir(directory)).map(async name =>
      JSON.parse(await readFile(join(directory, name), "utf8"))));
    assert.equal(records.length, 2);
    assert.ok(records.every(record => !("grammar" in record)));
  });
});

test("storage failures reject rather than claiming success", async () => {
  await temporary(async directory => {
    await writeFile(directory, "not a directory");
    await assert.rejects(saveLesson(lesson, directory));
    assert.equal(await readFile(directory, "utf8"), "not a directory");
  });
});

test("storage location is separate from sessions and honors isolated agent or explicit directories", () => {
  assert.equal(storageDirectory({ PI_CODING_AGENT_DIR: "/tmp/isolated-agent" }),
    "/tmp/isolated-agent/language-coach/saved");
  assert.equal(storageDirectory({ PI_LANGUAGE_COACH_STORAGE_DIR: "/tmp/coach-only" }), "/tmp/coach-only");
  assert.throws(() => storageDirectory({ PI_LANGUAGE_COACH_STORAGE_DIR: "relative/path" }));
});
