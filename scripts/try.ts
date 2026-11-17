/**
 * Manual check against the model you actually use: `npm run try -- "He don't know how to fix this bug."`
 * Prints the panel exactly as the TUI draws it (real underline escapes, real wrapping), then the raw state.
 */
import { loadConfig } from "../src/config.ts";
import { generate } from "../src/generate.ts";
import { CoachWidget } from "../src/widget.ts";

const args = process.argv.slice(2);
const widthArg = args.find(arg => arg.startsWith("--width="));
const width = Number(widthArg?.slice("--width=".length) ?? process.stdout.columns ?? 80);
const inputs = args.filter(arg => !arg.startsWith("--"));
if (!inputs.length) inputs.push("He don't know how to fix this bug.", "Please review my changes.");

const settings = loadConfig(process.env);
if (settings.kind !== "configured") {
  console.error(`未配置：${settings.reason}`);
  process.exit(1);
}

for (const input of inputs) {
  const state = await generate(settings.config, input, AbortSignal.timeout(120_000))
    .catch(error => ({ kind: "error" as const, message: String(error) }));
  console.log(`\n── 输入：${input}`);
  const lines = new CoachWidget(() => state, (_row, text, english) =>
    // Same mapping as the panel: English is the accent, everything else is muted.
    (english ? "\x1b[35m" : "\x1b[90m") + text + "\x1b[0m", undefined, input).render(width);
  for (const line of lines.length ? lines : [`（${"message" in state ? state.message : state.kind}）`]) console.log(line);
  if ("grammar" in state) {
    console.log(`\n  语法.correction：${state.grammar.correction ?? "（无，未判定有错）"}`);
  }
}
