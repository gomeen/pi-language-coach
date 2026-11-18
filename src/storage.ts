import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Grammar, Word } from "./generate.ts";

export interface Lesson {
  original: string;
  english: string;
  grammar?: Grammar;
  words?: Word[];
}

export type SaveResult = "saved" | "duplicate";

/** 收藏聚合粒度：一天一个文件，或一个 ISO 周一个文件。 */
export type GroupBy = "day" | "week";
export const GROUP_BY_VALUES: readonly GroupBy[] = ["day", "week"];
export const DEFAULT_GROUP_BY: GroupBy = "week";

/** One saved lesson. Same shape as the 0.9 one-file-per-lesson record. */
export interface StoredLesson extends Lesson {
  version: 1;
  id: string;
  savedAt: string;
}

/** From 0.10 on: one file per local day or ISO week, lessons in saved order. */
export interface LessonFile {
  version: 2;
  groupBy: GroupBy;
  period: string;
  lessons: StoredLesson[];
}

/** Bundle file names: `2026-11-18.json` for a day, `2026-W47.json` for an ISO week. */
export const PERIOD_FILE = /^\d{4}-(?:W\d{2}|\d{2}-\d{2})\.json$/;
/** 0.9 and earlier wrote one `<sha256>.json` per lesson; those stay readable forever. */
export const LEGACY_FILE = /^[a-f0-9]{64}\.json$/;

const pad = (value: number): string => String(value).padStart(2, "0");

/** Local-time bucket key. ISO week: the week holding the year's first Thursday owns the year. */
export function periodKey(date: Date, groupBy: GroupBy): string {
  if (groupBy === "day") return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
  const year = thursday.getFullYear();
  const firstThursday = new Date(year, 0, 4);
  firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${year}-W${pad(week)}`;
}

export function storageDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.PI_LANGUAGE_COACH_STORAGE_DIR ?? join(
    env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "language-coach", "saved",
  );
  if (!isAbsolute(directory)) throw new Error("收藏目录必须是绝对路径。");
  return directory;
}

export interface SaveOptions {
  /** Defaults to weekly bundles; a day file keeps at most a day of lessons together. */
  readonly groupBy?: GroupBy;
  /** Injectable clock (period bucket and `savedAt`). */
  readonly now?: Date;
}

/** Explicit fields only, so credentials, host state and runtime extras never reach disk. */
function content(lesson: Lesson): Lesson {
  const stored: Lesson = { original: lesson.original, english: lesson.english };
  if (lesson.grammar) {
    const { excerpt, pattern, explanations, correction } = lesson.grammar;
    stored.grammar = { excerpt, pattern, explanations: [...explanations], ...(correction ? { correction } : {}) };
  }
  // Added after the first format; lessons without words keep their old content hash.
  if (lesson.words?.length) stored.words = lesson.words.map(({ word, meaning }) => ({ word, meaning }));
  return stored;
}

function isLessonFile(value: unknown): value is LessonFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const file = value as Partial<LessonFile>;
  if (file.version !== 2 || !GROUP_BY_VALUES.includes(file.groupBy as GroupBy) || typeof file.period !== "string") return false;
  return Array.isArray(file.lessons) && file.lessons.every(entry =>
    typeof entry === "object" && entry !== null && typeof (entry as StoredLesson).id === "string");
}

/** A file we cannot read is moved aside rather than overwritten, so no lesson is ever lost. */
async function readLessonFile(path: string): Promise<LessonFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (isLessonFile(value)) return value;
  await rename(path, join(dirname(path), `.${basename(path, ".json")}.${randomUUID()}.corrupt.json`));
  return undefined;
}

async function writeFileAtomically(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // Readers see either the previous complete file or the next one, never a partial write.
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** How long to wait for another Pi process that is appending to the same period file. */
const LOCK_WAIT_MS = 2_000;
/** A lock older than this was left behind by a crashed process and may be reclaimed. */
const LOCK_STALE_MS = 10_000;

async function isStaleLock(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Exclusive create doubles as the mutex: only one process edits a period file at a time. */
async function withLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid), "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw new Error("收藏文件正被其他进程写入。");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  try {
    return await run();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

/** Append one lesson to this period's file, deduplicated by content id within that file. */
export async function saveLesson(
  lesson: Lesson,
  directory: string,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const stored = content(lesson);
  const id = createHash("sha256").update(JSON.stringify(stored)).digest("hex");
  const now = options.now ?? new Date();
  const groupBy = options.groupBy ?? DEFAULT_GROUP_BY;
  const period = periodKey(now, groupBy);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${period}.json`);
  return withLock(join(directory, `.${period}.lock`), async () => {
    const file = await readLessonFile(path);
    if (file?.lessons.some(entry => entry.id === id)) return "duplicate";
    const lessons = [...(file?.lessons ?? []), { version: 1 as const, id, savedAt: now.toISOString(), ...stored }];
    await writeFileAtomically(path, JSON.stringify({ version: 2, groupBy, period, lessons }, null, 2) + "\n");
    return "saved";
  });
}

export interface MigrationResult {
  /** Lessons written into a period file. */
  merged: number;
  /** Lessons that were already in a period file, so only the old file moved. */
  duplicate: number;
  /** Old files that were not a readable lesson; left untouched in the collection directory. */
  skipped: number;
  /** Where the moved single-record files went; restore them to undo the migration. */
  backup: string;
}

function legacyRecord(value: unknown): value is StoredLesson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<StoredLesson>;
  return entry.version === 1 && typeof entry.id === "string" && typeof entry.savedAt === "string"
    && Number.isFinite(Date.parse(entry.savedAt)) && typeof entry.original === "string"
    && typeof entry.english === "string";
}

/** Fold the 0.9 one-file-per-lesson layout into period bundles, keeping the original `savedAt`.
 *  Old files are copied into a backup directory before they are removed, so this is reversible. */
export async function migrateLegacyFiles(
  directory: string,
  groupBy: GroupBy = DEFAULT_GROUP_BY,
  now: Date = new Date(),
): Promise<MigrationResult> {
  const entries = await readdir(directory, { withFileTypes: true });
  const singles: { name: string; lesson: StoredLesson }[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !LEGACY_FILE.test(entry.name)) continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
    } catch {
      skipped++;
      continue;
    }
    // The file name is the content hash, so a mismatched id means the file was edited by hand.
    if (!legacyRecord(value) || value.id !== entry.name.slice(0, -5)) {
      skipped++;
      continue;
    }
    singles.push({ name: entry.name, lesson: value });
  }
  const groups = new Map<string, StoredLesson[]>();
  for (const { lesson } of singles) {
    const period = periodKey(new Date(lesson.savedAt), groupBy);
    const list = groups.get(period) ?? [];
    list.push(lesson);
    groups.set(period, list);
  }
  let merged = 0;
  let duplicate = 0;
  for (const [period, lessons] of groups) {
    const path = join(directory, `${period}.json`);
    await withLock(join(directory, `.${period}.lock`), async () => {
      const file = await readLessonFile(path);
      const known = new Set(file?.lessons.map(entry => entry.id) ?? []);
      const added = lessons.filter(lesson => !known.has(lesson.id)).sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
      duplicate += lessons.length - added.length;
      if (!added.length) return;
      merged += added.length;
      const next = { version: 2, groupBy, period, lessons: [...(file?.lessons ?? []), ...added] };
      await writeFileAtomically(path, JSON.stringify(next, null, 2) + "\n");
    });
  }
  // Only after every bundle is on disk: keep the old files, just out of the way.
  const backup = join(directory, `.backup-${now.toISOString().replace(/[:.]/g, "-")}`);
  if (singles.length) {
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const { name } of singles) await rename(join(directory, name), join(backup, name));
  }
  return { merged, duplicate, skipped, backup };
}
