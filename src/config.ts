import { readFileSync } from "node:fs";
import { SYSTEM_PROMPT } from "./generate.ts";

export type Provider = "minimax" | "deepseek" | "h-self";
/** Wire protocol of the configured provider; one coach, three envelope shapes. */
export type ApiProtocol = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface CoachConfig {
  readonly api: ApiProtocol;
  readonly apiKey: string;
  readonly model: string;
  /** Adaptive thinking on with an optional effort cap; "disabled" omits the field entirely. */
  readonly thinking: "adaptive" | "disabled" | "low" | "medium" | "high";
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

function boolean(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[prefix + name];
  if (value === undefined) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error();
}

/** Prompt from a file wins over inline text; both fall back to the built-in teaching prompt. */
function systemPrompt(env: Environment): string {
  const file = env[prefix + "PROMPT_FILE"];
  const inline = env[prefix + "PROMPT"];
  const raw = file !== undefined ? readFileSync(file, "utf8") : inline ?? SYSTEM_PROMPT;
  const prompt = raw.trim();
  if (!prompt) throw new Error();
  return prompt;
}

function integer(env: Environment, name: string, fallback: number, maximum: number): number {
  const raw = env[prefix + name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error();
  return value;
}

/** Only the dedicated environment namespace is read. Never consult Pi authentication. */
export function loadConfig(env: Environment): ConfigResult {
  const provider = env[prefix + "PROVIDER"];
  if (provider !== undefined && provider !== "minimax" && provider !== "deepseek" && provider !== "h-self") {
    return { kind: "disabled", reason: "学习环境变量无效；请检查专用密钥、地址和数值设置。" };
  }
  const preset = presets[(provider ?? "minimax") as Provider];
  const apiKey = env[prefix + preset.keyVar];
  if (!apiKey?.trim()) {
    return {
      kind: "disabled",
      reason: provider === undefined || provider === "minimax"
        ? "未设置 PI_LANGUAGE_COACH_API_KEY；仅学习功能停用。"
        : `未设置 PI_LANGUAGE_COACH_${preset.keyVar}；仅学习功能停用。`,
    };
  }
  try {
    // Header-safe, nonempty key; never include rejected values in an error.
    if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new Error();
    const model = env[prefix + preset.modelVar] ?? preset.model;
    if (!model.trim() || /[\p{Cc}\p{Cf}]/u.test(model)) throw new Error();
    // "adaptive" leaves the depth to the model; low/medium/high add a provider effort cap where the
    // protocol has one; "disabled" asks for the provider's off state.
    const rawThinking = env[prefix + "THINKING"] ?? "medium";
    if (rawThinking !== "adaptive" && rawThinking !== "disabled" &&
        rawThinking !== "low" && rawThinking !== "medium" && rawThinking !== "high") throw new Error();
    const thinking = rawThinking;
    const rawUrl = env[prefix + preset.urlVar] ?? preset.baseUrl;
    const url = new URL(rawUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
        url.username || url.password || url.search || url.hash || /[?#]/.test(rawUrl)) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "") + apiPath[preset.api];
    return {
      kind: "configured",
      config: Object.freeze({
        api: preset.api, apiKey, model, thinking, endpoint: url.href,
        systemPrompt: systemPrompt(env),
        showOriginal: boolean(env, "SHOW_ORIGINAL", true),
        showPractice: boolean(env, "SHOW_PRACTICE", true),
        autoSave: boolean(env, "AUTO_SAVE", true),
        timeoutMs: integer(env, "TIMEOUT_MS", 30000, 300000),
      }),
    };
  } catch {
    return { kind: "disabled", reason: "学习环境变量无效；请检查专用密钥、地址、数值和提示词设置。" };
  }
}
