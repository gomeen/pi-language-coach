import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "./generate.ts";

export type Provider = "minimax" | "deepseek" | "h-self";
/** Wire protocol of the configured provider; one coach, three envelope shapes. */
export type ApiProtocol = "anthropic-messages" | "openai-completions" | "openai-responses";
type Thinking = "adaptive" | "disabled" | "low" | "medium" | "high";

export interface CoachConfig {
  readonly api: ApiProtocol;
  readonly apiKey: string;
  readonly model: string;
  /** Adaptive thinking on with an optional effort cap; "disabled" omits the field entirely. */
  readonly thinking: Thinking;
  readonly endpoint: string;
  /** Custom teaching prompt; the resolved value is always present (built-in default when unset). */
  readonly systemPrompt: string;
  /** Show the submitted 原文 line above the translation. */
  readonly showOriginal: boolean;
  /** Open the practice typing row automatically whenever a fresh result lands. */
  readonly showPractice: boolean;
  readonly autoSave: boolean;
  readonly timeoutMs: number;
}

export type ConfigResult =
  | { kind: "configured"; config: CoachConfig }
  | { kind: "disabled"; reason: string };

export type Environment = Readonly<Record<string, string | undefined>>;
const prefix = "PI_LANGUAGE_COACH_";
const providers: Provider[] = ["minimax", "deepseek", "h-self"];
const thinkingValues: Thinking[] = ["adaptive", "disabled", "low", "medium", "high"];

interface ProviderPreset {
  readonly api: ApiProtocol;
  readonly baseUrl: string;
  readonly model: string;
  // minimax keeps the historic unprefixed variable names; deepseek and h-self use scoped names so
  // one machine can hold every key at once and a stale minimax value never leaks into another route.
  readonly keyVar: string;
  readonly urlVar: string;
  readonly modelVar: string;
}

/** Built-in routes. Any other OpenAI-compatible relay works through a scoped base-url override. */
const presets: Record<Provider, ProviderPreset> = {
  minimax: {
    api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3.1-Flash",
    keyVar: "API_KEY", urlVar: "BASE_URL", modelVar: "MODEL",
  },
  deepseek: {
    api: "openai-completions", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
    keyVar: "DEEPSEEK_API_KEY", urlVar: "DEEPSEEK_BASE_URL", modelVar: "DEEPSEEK_MODEL",
  },
  "h-self": {
    api: "openai-responses", baseUrl: "https://ai.yuchuantest.com/v1", model: "gpt-5.6-luna",
    keyVar: "H_SELF_API_KEY", urlVar: "H_SELF_BASE_URL", modelVar: "H_SELF_MODEL",
  },
};

const apiPath: Record<ApiProtocol, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
};

/** Everything the environment variables can express, in one JSON file next to saved lessons. */
export interface FileConfig {
  provider?: Provider;
  thinking?: Thinking;
  showOriginal?: boolean;
  showPractice?: boolean;
  autoSave?: boolean;
  timeoutMs?: number;
  prompt?: string;
  /** Path relative to the language-coach directory, or absolute. */
  promptFile?: string;
  providers?: Partial<Record<Provider, { apiKey?: string; baseUrl?: string; model?: string }>>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict-enough shape check: wrong types throw so the caller reports an invalid config file. */
function parseFileConfig(raw: string): FileConfig {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value)) throw new Error();
  const file = value as FileConfig;
  if (file.provider !== undefined && !providers.includes(file.provider)) throw new Error();
  if (file.thinking !== undefined && !thinkingValues.includes(file.thinking)) throw new Error();
  for (const flag of ["showOriginal", "showPractice", "autoSave"] as const) {
    if (file[flag] !== undefined && typeof file[flag] !== "boolean") throw new Error();
  }
  if (file.timeoutMs !== undefined && (typeof file.timeoutMs !== "number" || !Number.isSafeInteger(file.timeoutMs))) throw new Error();
  for (const text of ["prompt", "promptFile"] as const) {
    if (file[text] !== undefined && typeof file[text] !== "string") throw new Error();
  }
  if (file.providers !== undefined) {
    if (!isObject(file.providers)) throw new Error();
    for (const [name, entry] of Object.entries(file.providers)) {
      if (!providers.includes(name as Provider) || !isObject(entry)) throw new Error();
      for (const field of ["apiKey", "baseUrl", "model"] as const) {
        const item = (entry as Record<string, unknown>)[field];
        if (item !== undefined && typeof item !== "string") throw new Error();
      }
    }
  }
  return file;
}

/** Missing file is normal; a malformed file throws so the caller can name it in the reason. */
function readConfigFile(agentDir: string | undefined): FileConfig | undefined {
  const path = join(envAgentDir(agentDir), "language-coach", "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseFileConfig(raw);
  } catch {
    throw new Error(`${path} 格式无效`);
  }
}

/** <PI_CODING_AGENT_DIR or ~/.pi/agent>/language-coach — the one directory that holds everything. */
function envAgentDir(agentDir: string | undefined): string {
  return agentDir?.trim() || join(homedir(), ".pi", "agent");
}

function boolean(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[prefix + name];
  if (value === undefined) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error();
}

function integer(env: Environment, name: string, fallback: number, maximum: number): number {
  const raw = env[prefix + name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error();
  return value;
}

/** Prompt from a file wins over inline text; both fall back to the built-in teaching prompt. */
function systemPrompt(env: Environment, file: FileConfig | undefined, coachDir: string): string {
  const envFile = env[prefix + "PROMPT_FILE"];
  const fileEntry = file?.promptFile;
  const path = envFile ?? (fileEntry ? join(coachDir, fileEntry) : undefined);
  const raw = path ? readFileSync(path, "utf8") : env[prefix + "PROMPT"] ?? file?.prompt ?? SYSTEM_PROMPT;
  const prompt = raw.trim();
  if (!prompt) throw new Error();
  return prompt;
}

/** Only the dedicated environment namespace and the optional config file are read. Never consult Pi authentication. */
export function loadConfig(env: Environment): ConfigResult {
  const coachDir = join(envAgentDir(env.PI_CODING_AGENT_DIR), "language-coach");
  let file: FileConfig | undefined;
  try {
    file = readConfigFile(env.PI_CODING_AGENT_DIR);
  } catch (error) {
    return { kind: "disabled", reason: `学习配置无效：${error instanceof Error ? error.message : "config.json 读取失败"}；仅学习功能停用。` };
  }
  const pickProvider = env[prefix + "PROVIDER"] ?? file?.provider;
  if (pickProvider !== undefined && !providers.includes(pickProvider as Provider)) {
    return { kind: "disabled", reason: "学习配置无效；供应商只能是 minimax、deepseek 或 h-self。" };
  }
  const provider = (pickProvider ?? "minimax") as Provider;
  const preset = presets[provider];
  const fileEntry = file?.providers?.[provider];
  const apiKey = env[prefix + preset.keyVar]?.trim() ? env[prefix + preset.keyVar] : fileEntry?.apiKey;
  if (!apiKey?.trim()) {
    return {
      kind: "disabled",
      reason: provider === "minimax"
        ? "未设置 PI_LANGUAGE_COACH_API_KEY，config.json 也没有提供 minimax 的 key；仅学习功能停用。"
        : `未设置 PI_LANGUAGE_COACH_${preset.keyVar}，config.json 也没有提供 ${provider} 的 key；仅学习功能停用。`,
    };
  }
  try {
    // Header-safe, nonempty key; never include rejected values in an error.
    if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new Error();
    const model = env[prefix + preset.modelVar] ?? fileEntry?.model ?? preset.model;
    if (!model.trim() || /[\p{Cc}\p{Cf}]/u.test(model)) throw new Error();
    // "adaptive" leaves the depth to the model; low/medium/high add a provider effort cap where the
    // protocol has one; "disabled" asks for the provider's off state.
    const rawThinking = env[prefix + "THINKING"] ?? file?.thinking ?? "medium";
    if (!thinkingValues.includes(rawThinking as Thinking)) throw new Error();
    const thinking = rawThinking as Thinking;
    const rawUrl = env[prefix + preset.urlVar] ?? fileEntry?.baseUrl ?? preset.baseUrl;
    const url = new URL(rawUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
        url.username || url.password || url.search || url.hash || /[?#]/.test(rawUrl)) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "") + apiPath[preset.api];
    const fileTimeout = file?.timeoutMs;
    const fallbackTimeout = fileTimeout === undefined ? 30000
      : Number.isInteger(fileTimeout) && fileTimeout >= 1 && fileTimeout <= 300000 ? fileTimeout : -1;
    if (fallbackTimeout === -1) throw new Error();
    return {
      kind: "configured",
      config: Object.freeze({
        api: preset.api, apiKey, model, thinking, endpoint: url.href,
        systemPrompt: systemPrompt(env, file, coachDir),
        showOriginal: boolean(env, "SHOW_ORIGINAL", file?.showOriginal ?? true),
        showPractice: boolean(env, "SHOW_PRACTICE", file?.showPractice ?? true),
        autoSave: boolean(env, "AUTO_SAVE", file?.autoSave ?? true),
        timeoutMs: integer(env, "TIMEOUT_MS", fallbackTimeout, 300000),
      }),
    };
  } catch {
    return { kind: "disabled", reason: "学习配置无效；请检查专用密钥、地址、数值和提示词设置。" };
  }
}
