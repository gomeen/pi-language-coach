/**
 * Fold 0.9's one-file-per-lesson collection into day/week bundles:
 *   npx tsx scripts/migrate-storage.ts                  # 用 config.json / 环境变量里的粒度
 *   npx tsx scripts/migrate-storage.ts --group-by=day   # 强制按天合并
 *   npx tsx scripts/migrate-storage.ts --directory=/abs/path/to/saved
 * 旧的单条文件会被移到同目录的隐藏 `.backup-<时间>` 里，不做删除，可随时搬回。
 */
import { loadConfig } from "../src/config.ts";
import {
  DEFAULT_GROUP_BY, GROUP_BY_VALUES, migrateLegacyFiles, storageDirectory, type GroupBy,
} from "../src/storage.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const entry = args.find(arg => arg.startsWith(`--${name}=`));
  return entry?.slice(name.length + 3);
};

const requested = flag("group-by");
if (requested !== undefined && !GROUP_BY_VALUES.includes(requested as GroupBy)) {
  console.error(`--group-by 只接受 ${GROUP_BY_VALUES.join(" / ")}。`);
  process.exit(2);
}
const settings = loadConfig(process.env);
const groupBy: GroupBy = (requested as GroupBy | undefined)
  ?? (settings.kind === "configured" ? settings.config.groupBy : DEFAULT_GROUP_BY);

let directory: string;
try {
  directory = flag("directory") ?? storageDirectory();
} catch (error) {
  console.error(error instanceof Error ? error.message : "收藏目录无效。");
  process.exit(2);
}

console.log(`目录：${directory}`);
console.log(`粒度：${groupBy === "day" ? "每天一个文件" : "每周一个文件"}`);
try {
  const result = await migrateLegacyFiles(directory, groupBy);
  console.log(`合并 ${result.merged} 条，已存在 ${result.duplicate} 条，跳过 ${result.skipped} 个无法读取的旧文件。`);
  if (result.merged || result.duplicate) console.log(`旧文件已移到：${result.backup}`);
  if (result.skipped) console.log("跳过的文件原样留在目录里，可自行检查后处理。");
} catch (error) {
  console.error(`合并失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
