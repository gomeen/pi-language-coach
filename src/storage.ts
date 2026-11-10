import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Grammar, Word } from "./generate.ts";

export interface Lesson {
  original: string;
  english: string;
  grammar?: Grammar;
  words?: Word[];
}

export type SaveResult = "saved" | "duplicate";

export function storageDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.PI_LANGUAGE_COACH_STORAGE_DIR ?? join(
    env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "language-coach", "saved",
  );
  if (!isAbsolute(directory)) throw new Error("收藏目录必须是绝对路径。");
  return directory;
}

/** One complete JSON file per lesson; exclusive publication deduplicates across Pi processes. */
export async function saveLesson(lesson: Lesson, directory: string): Promise<SaveResult> {
  // Explicit fields exclude credentials, host state and any extra runtime properties.
  const content: Lesson = { original: lesson.original, english: lesson.english };
  if (lesson.grammar) {
    const { excerpt, pattern, explanation, correction } = lesson.grammar;
    content.grammar = { excerpt, pattern, explanation, ...(correction ? { correction } : {}) };
  }
  // Added after the first format; lessons without words keep their old content hash.
  if (lesson.words?.length) content.words = lesson.words.map(({ word, meaning }) => ({ word, meaning }));
  const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const record = { version: 1, id, savedAt: new Date().toISOString(), ...content };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
  const destination = join(directory, `${id}.json`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // A complete file becomes visible atomically; never overwrite another writer.
      await link(temporary, destination);
      return "saved";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
      throw error;
    }
  } finally {
    // Cleanup failure must not misreport a successfully published lesson as unsaved.
    await unlink(temporary).catch(() => {});
  }
}
