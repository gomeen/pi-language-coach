export interface CoachConfig {
  readonly apiKey: string;
  readonly model: string;
  /** Adaptive thinking on with an optional effort cap; "disabled" omits the field entirely. */
  readonly thinking: "adaptive" | "disabled" | "low" | "medium" | "high";
  readonly endpoint: string;
  readonly autoSave: boolean;
  readonly timeoutMs: number;
}

export type ConfigResult =
  | { kind: "configured"; config: CoachConfig }
  | { kind: "disabled"; reason: string };

export type Environment = Readonly<Record<string, string | undefined>>;
const prefix = "PI_LANGUAGE_COACH_";

function autoSave(env: Environment): boolean {
  const value = env[prefix + "AUTO_SAVE"];
  if (value === undefined || value === "1" || value === "true") return true;
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

/** Only the dedicated environment namespace is read. Never consult Pi authentication. */
export function loadConfig(env: Environment): ConfigResult {
  const apiKey = env[prefix + "API_KEY"];
  if (!apiKey?.trim()) {
    return { kind: "disabled", reason: "未设置 PI_LANGUAGE_COACH_API_KEY；仅学习功能停用。" };
  }
  try {
    // Header-safe, nonempty key; never include rejected values in an error.
    if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new Error();
    const model = env[prefix + "MODEL"] ?? "MiniMax-M3.1-Flash";
    if (!model.trim() || /[\p{Cc}\p{Cf}]/u.test(model)) throw new Error();
    // "adaptive" sends thinking alone and leaves the depth to the model; low/medium/high add an
    // output_config.effort cap (honored by M3.1-Flash, ignored by M3, which stays on/off only);
    // "disabled" omits the field entirely, the provider's off state.
    const rawThinking = env[prefix + "THINKING"] ?? "medium";
    if (rawThinking !== "adaptive" && rawThinking !== "disabled" &&
        rawThinking !== "low" && rawThinking !== "medium" && rawThinking !== "high") throw new Error();
    const thinking = rawThinking;
    const rawUrl = env[prefix + "BASE_URL"] ?? "https://api.minimaxi.com/anthropic";
    const url = new URL(rawUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
        url.username || url.password || url.search || url.hash || /[?#]/.test(rawUrl)) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "") + "/v1/messages";
    return {
      kind: "configured",
      config: Object.freeze({
        apiKey, model, thinking, endpoint: url.href,
        autoSave: autoSave(env),
        timeoutMs: integer(env, "TIMEOUT_MS", 30000, 300000),
      }),
    };
  } catch {
    return { kind: "disabled", reason: "学习环境变量无效；请检查专用密钥、地址和数值设置。" };
  }
}
