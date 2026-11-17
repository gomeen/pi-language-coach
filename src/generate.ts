import type { ApiProtocol, CoachConfig } from "./config.ts";
import { hasProse, stripPathsAndLinks } from "./input.ts";

export const SYSTEM_PROMPT = `用户用拼音输入法给编程助手发消息，中英混合说明其中用中文写的词不会说。把消息翻译成自然、直接的英语；已是英语就改正其中的错误，大小写和标点不算错误；根据上下文修正拼音输入法的同音错别字，比如改界面时「北京的间距」是「背景的间距」、「北京色」是「背景色」，按意思翻成 background 而不是 Beijing；「图片」「文件」「链接」是占位符，代表被移除的位置，翻译成 image、file、link 这类名词本身，不要省略，也不要丢掉它周围「这个文件」「里面的说明」这类指代；根据英语表达习惯调整语序；保留所有细节、数字、代码和标识符。

仅返回 JSON，不要任何前言、说明或代码块：{"english":string,"words":[{"word":string,"meaning":string}],"grammar":{"excerpt":string,"pattern":string,"explanations":[string],"correction"?:string}}。

words 和 grammar 都是可选的，只在这句话确实值得学时才有，没有就给 "words":[] 或整个省略 grammar；不要为了凑数硬写，空着比讲废话好。

words 讲 english 里你可能猜不出意思的词或固定说法，最多 3 个，按句中先后顺序；word 用 english 里的原样拼写，meaning 写简短中文释义加怎么用，不超过 20 字。这些不要讲：fix、show、change、build、yet、whether、continue、bug、code、api、mock、input、log 这类日常词和编程常用词；你输入里已经用英文写过的词；从中文直译出来的长名词短语（如 algorithm configuration、background outside the table）；超过 3 个词的整段话。只讲像 popup、clickable、hardcoded、routing 这种真能学到东西的词。例外：输入里用中文写、english 里换成英文的那个词要讲（输入「接口」、english 是 API 就讲 API），那是你不会写的词。

grammar 讲这类话英语怎么说：用哪个说法开头、后面接什么、把哪个词换掉就能表达别的意思，用 english 里的真实单词举例；不要只写「用于询问……」这类意思，也不用动名词、分词、从句、不定式、谓语、表语、情态动词这类说法，直接写成「后面接 explaining grammar 这样的 -ing 形式」这种看得懂的话；不要写成「动词 + 名词」「be not + 形容词」这类带加号的公式，改成「后面接 clickable 这样的形容词」这种说法；excerpt 必须从 english 逐字复制——输入里的英语有错时也一样，excerpt 用改好后的写法（如输入是 don't、english 是 doesn't，就复制 doesn't 那段），不要复制你输入里那句错的；pattern 写这个句式的简短中文名；explanations 最多 3 条，每条一句独立的话、不超过 50 字，不要重复，不要复述整句。english 只有一两个词（如 Continue.、Hello.）或本身没有可讲的结构时，省略整个 grammar。

输入里的英语有错误时，把该错误放在 explanations 的第一条，并填写 correction，格式为 "before → after"，只写最主要的一处改动涉及的几个词，不写整句；没有错误就省略 correction。`;

export interface Grammar {
  excerpt: string;
  pattern: string;
  /** One independent point per line, at most MAX_POINTS; the panel prints one numbered row each. */
  explanations: string[];
  correction?: string;
}

/** A word or short phrase from the English with its Chinese meaning in this sentence. */
export interface Word {
  word: string;
  meaning: string;
}

export type Generation =
  | { kind: "ready"; english: string; grammar: Grammar; words?: Word[] }
  | { kind: "partial"; english: string; words?: Word[] };

// The panel is read at a glance, so both lists are short on purpose: three is what fits without
// turning the teaching area into a wall of text, and the prompt asks for the hardest picks only.
export const MAX_WORDS = 3;
export const MAX_POINTS = 3;

// The prompt asks for the hardest picks only; the cap keeps a chatty model from filling the panel.
/** Keep only entries whose word really occurs in the English, spelled as there; drop the rest one by one. */
export function parseWords(value: unknown, english: string): Word[] {
  if (!Array.isArray(value)) return [];
  const result: Word[] = [];
  for (const item of value) {
    if (result.length === MAX_WORDS) break;
    if (!object(item) || !nonempty(item.word) || !nonempty(item.meaning)) continue;
    const word = item.word.trim(), meaning = item.meaning.trim();
    if (Array.from(word).length > 40 || Array.from(meaning).length > 60 || !/\p{Script=Han}/u.test(meaning)) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").exec(english);
    // Skip duplicates and overlaps such as "requirements" next to "meet the requirements".
    if (!found) continue;
    const key = found[0].toLowerCase();
    if (result.some(entry => entry.word.toLowerCase().includes(key) || key.includes(entry.word.toLowerCase()))) continue;
    result.push({ word: found[0], meaning });
  }
  return result;
}

/**
 * Grammar points as a list of one-line statements. Accepts the list field, and a single string for
 * prompts written before the list existed; keeps only items that are Chinese, bounded and distinct.
 */
export function parsePoints(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const points: string[] = [];
  for (const item of items) {
    if (points.length === MAX_POINTS) break;
    // The row is Chinese so the user can read it; an English fragment inside a Chinese item
    // (such as "I'll = I will") is still part of that readable statement.
    if (typeof item !== "string" || !/\p{Script=Han}/u.test(item)) continue;
    // A point is one statement; a paragraph pasted into one item is split so the cap still means
    // something, and the panel keeps one idea per row.
    for (const piece of item.split(/[\n；;]+/)) {
      if (points.length === MAX_POINTS) break;
      const point = piece.trim().replace(/^\d+[.、)\uff09]\s*/, "");
      if (!point || Array.from(point).length > 100) continue;
      // The same sentence twice is noise, not a second point.
      if (points.some(existing => existing.toLowerCase() === point.toLowerCase())) continue;
      points.push(point);
    }
  }
  return points;
}

type FailureCode = "network" | "timeout" | "cancelled" | "http" | "oversized" | "invalid" | "incomplete";
const messages: Record<FailureCode, string> = {
  network: "学习请求失败，请检查网络或专用地址。",
  timeout: "学习请求超时，可用 /coach retry 重试。",
  cancelled: "学习请求已取消。",
  http: "学习服务返回错误。",
  oversized: "学习响应超过安全大小限制。",
  invalid: "学习响应格式无效。",
  incomplete: "学习响应未完成，未显示不完整译文。",
};

export class GenerationError extends Error {
  constructor(readonly code: FailureCode, readonly status?: number) {
    super(messages[code] + (code === "http" && status !== undefined ? ` (HTTP ${status})` : ""));
    this.name = "GenerationError";
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
// Bounded transport memory, not an input-length filter. The provider still has its own finite context/output limits.
const BODY_LIMIT = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// Real words that only look inflected; "string 不加 ing" is not a contradiction.
const endsWith: Record<string, (word: string) => boolean> = {
  ing: word => word.length > 4 && word.endsWith("ing") && !/(?:thing|string|bring|spring|during|ring|king|sing|wing)$/.test(word),
  ed: word => word.length > 3 && word.endsWith("ed") && !word.endsWith("eed"),
  es: word => word.length > 3 && word.endsWith("es"),
  s: word => word.length > 2 && word.endsWith("s") && !/(?:ss|us|is|as|ys|os|ics)$/.test(word),
};

/**
 * "objectives 不加 s" or "impl 加 s" (when no impls is in the English) contradicts the word it describes.
 * "go 要加 ing" is fine when going appears in the English.
 */
export function contradictsEnding(explanation: string, english = ""): boolean {
  const text = explanation.toLowerCase();
  const negative = /([a-z]+)[^a-z]{0,10}?(?:不加|不用加|不要加|没有加|没加)\s*((?:-?(?:ing|ed|es|s)(?![a-z])\s*(?:[、,，/]|或|和|也|or)?\s*)+)/giu;
  for (const [, word, list] of text.matchAll(negative)) {
    for (const ending of list!.match(/ing|ed|es|s/g) ?? []) if (endsWith[ending]!(word!)) return true;
  }
  if (!english) return false;
  const words = english.toLowerCase().match(/[a-z]+/g) ?? [];
  const positive = /([a-z]+)[^a-z\p{Script=Han}]{0,3}(?:要加|需要加|得加|加上|加)\s*-?(ing|ed|es|s)(?![a-z])/giu;
  for (const [match, word, ending] of text.matchAll(positive)) {
    if (/不(?:要|用|需要)?加|没有?加/.test(match)) continue;
    if (endsWith[ending!]!(word!) || word!.endsWith(ending!)) continue;
    const stem = word!.replace(/e$/, "");
    if (!words.some(item => item.startsWith(stem) && item.endsWith(ending!) && item.length > word!.length)) return true;
  }
  return false;
}

const expand = (english: string) => english
  .replace(/\bcan't\b/g, "cannot can not").replace(/\bwon't\b/g, "will not").replace(/\blet's\b/g, "let us")
  .replace(/n't\b/g, " not").replace(/'ll\b/g, " will").replace(/'re\b/g, " are").replace(/'m\b/g, " am")
  .replace(/'ve\b/g, " have").replace(/'s\b/g, " is").replace(/'d\b/g, " would");

const PARTICLE = "with|to|for|on|in|at|of|about|from|into|onto|by|up|out|off|back";
/**
 * Invented teaching phrases seen in practice: a preposition pair the English lacks ("match with")
 * or a question opening that is not in the sentence ("what is" for "check what plugins...").
 * Templates such as "be + ed" or "need to do" are not quotations and are left alone.
 */
export function inventsPhrase(explanation: string, english: string): boolean {
  const normal = (value: string) => value.toLowerCase().replace(/[\u2019]/g, "'");
  const result = normal(english);
  const haystack = ` ${result.replace(/[^a-z']+/g, " ")} ${expand(result).replace(/[^a-z']+/g, " ")} `;
  const has = (phrase: string) => haystack.includes(` ${phrase.replace(/\s+/g, " ")} `);
  const text = normal(explanation);
  const pair = new RegExp(`\\b([a-z]+)[ \\t]+(${PARTICLE})\\b(?![ \\t]*[+\\p{Script=Han}])`, "giu");
  for (const [, word, particle] of text.matchAll(pair)) {
    if (/^(?:be|do|doing|sb|sth|somebody|something)$/.test(word!)) continue;
    // "switch back to" also covers "switches back to".
    const stem = word!.length > 3 ? word!.replace(/(?:e|es|s|ed|ing)$/, "") : word!;
    if (!new RegExp(` ${stem}[a-z']* ${particle} `).test(haystack)) return true;
  }
  const question = /\b(what|how|why|where|when|who|which)[ \t]+(is|are|was|were|do|does|did|can|should|will)\b/g;
  return [...text.matchAll(question)].some(([match]) => !has(match));
}

// Terms the user asked to avoid; school basics such as 主语、宾语、动词、名词、过去式、被动 stay allowed.
const HARD_TERMS = /(?:宾语|定语|状语|主语|表语|同位语)从句|非谓语|谓语|表语|不定式|动名词|现在分词|情态动词/;

/** Formula labels ("don't + adverb + base verb", "动词 + 名词") and hard grammar terms the user could not read. */
export function usesFormula(text: string, english: string): boolean {
  if (HARD_TERMS.test(text)) return true;
  if (/(?:动词|名词|形容词|副词|原形)\s*\+|\+\s*(?:动词|名词|形容词|副词|原形)/.test(text)) return true;
  const label = /(?:base verb|bare verb|adverb|adjective|verb|noun|subject|object|gerund|infinitive|participle|clause|sb|sth|somebody|something|doing|do)/;
  const formula = new RegExp(`(?:\\b${label.source}\\s*\\+|\\+\\s*${label.source}\\b)`, "gi");
  return [...text.toLowerCase().matchAll(formula)].some(match => {
    const word = match[0].replace(/[+\s]/g, "");
    return !new RegExp(`\\b${word}\\b`, "i").test(english);
  });
}

/** Provider envelope → assistant text; thinking blocks and other metadata are never consumed. */
function envelopeText(api: ApiProtocol, raw: string): string {
  let provider: unknown;
  try { provider = JSON.parse(raw); } catch { throw new GenerationError("invalid"); }
  if (!object(provider)) throw new GenerationError("invalid");
  if (api === "anthropic-messages") {
    if (provider.stop_reason !== "end_turn") throw new GenerationError("incomplete");
    if (!Array.isArray(provider.content)) throw new GenerationError("invalid");
    return provider.content.filter((block: unknown) => object(block) && block.type === "text" && typeof block.text === "string")
      .map((block: Record<string, unknown>) => block.text).join("").trim();
  }
  if (api === "openai-completions") {
    const choice = Array.isArray(provider.choices) && object(provider.choices[0]) ? provider.choices[0] : undefined;
    if (!choice) throw new GenerationError("invalid");
    if (choice.finish_reason !== "stop") throw new GenerationError("incomplete");
    if (!object(choice.message) || typeof choice.message.content !== "string") throw new GenerationError("invalid");
    return choice.message.content.trim();
  }
  if (provider.status !== "completed") throw new GenerationError("incomplete");
  if (!Array.isArray(provider.output)) throw new GenerationError("invalid");
  const text: string[] = [];
  for (const item of provider.output) {
    if (!object(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (object(part) && part.type === "output_text" && typeof part.text === "string") text.push(part.text);
    }
  }
  return text.join("").trim();
}

interface Transport {
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function buildRequest(config: CoachConfig, system: string, user: string, tokens: number): Transport {
  if (config.api === "anthropic-messages") {
    return {
      headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      body: {
        model: config.model, stream: false,
        // Adaptive thinking is the provider's on state; the omitted field is its off state.
        ...(config.thinking === "disabled" ? {} : { thinking: { type: "adaptive" } }),
        // An effort cap trims how long the model may think (honored by M3.1-Flash, ignored by M3).
        ...(config.thinking === "low" || config.thinking === "medium" || config.thinking === "high"
          ? { output_config: { effort: config.thinking } } : {}),
        max_tokens: tokens, system, messages: [{ role: "user", content: user }],
      },
    };
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
  if (config.api === "openai-completions") {
    // DeepSeek exposes thinking as a plain on/off switch (matching Pi); effort levels are not sent.
    return {
      headers,
      body: {
        model: config.model, stream: false,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: tokens,
        thinking: { type: config.thinking === "disabled" ? "disabled" : "enabled" },
      },
    };
  }
  return {
    headers,
    body: {
      model: config.model, stream: false, store: false,
      input: [{ role: "system", content: system }, { role: "user", content: [{ type: "input_text", text: user }] }],
      max_output_tokens: tokens,
      // No reasoning field = the provider's own default; "none" is the documented off state.
      ...(config.thinking === "disabled" ? { reasoning: { effort: "none" } }
        : config.thinking === "adaptive" ? {} : { reasoning: { effort: config.thinking } }),
    },
  };
}

/** The text's own spelling of a case-insensitive match. */
function span(text: string, phrase: string): string | undefined {
  const at = text.toLowerCase().indexOf(phrase.toLowerCase());
  return at === -1 ? undefined : text.slice(at, at + phrase.length);
}

function parsePayload(raw: string, original: string): Generation {
  let text = raw;
  const fence = /^\`\`\`(?:json)?\s*\n?([\s\S]*?)\n?\`\`\`$/i.exec(text);
  if (fence) text = fence[1]!.trim();
  // The model occasionally narrates before the answer ("I'll inspect the working tree…") and only then
  // emits the object. Recover the last balanced top-level JSON object instead of discarding a valid answer.
  const parsed = (value: string): unknown => { try { return JSON.parse(value); } catch { return undefined; } };
  let result = parsed(text);
  if (result === undefined) {
    const candidates: string[] = [];
    let depth = 0, start = -1, quoted = false, escaped = false;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = depth > 0;
      else if (character === "{") { if (depth === 0) start = index; depth++; }
      else if (character === "}" && depth > 0 && --depth === 0) candidates.push(text.slice(start, index + 1));
    }
    for (const candidate of candidates.reverse()) {
      result = parsed(candidate);
      if (result !== undefined) break;
    }
  }
  if (result === undefined) throw new GenerationError("invalid");
  if (!object(result) || !nonempty(result.english)) throw new GenerationError("invalid");
  // Display the model's casing; compare case-insensitively.
  const english = result.english;
  const lower = english.toLowerCase();
  const found = parseWords(result.words, english);
  const words = found.length ? { words: found } : {};
  const grammar = result.grammar;
  // An empty correction is the model saying "nothing to fix", which the prompt asks it to express by
  // omitting the field; treat the two the same instead of discarding a valid grammar point.
  const rawCorrection = object(grammar) ? grammar.correction : undefined;
  const proposed = typeof rawCorrection === "string" && rawCorrection.trim() ? rawCorrection.trim() : undefined;
  // One point per row, so each must stand on its own: a point that fails a check is dropped alone
  // instead of taking the readable ones with it. A single-string `explanation` (older prompts and
  // saved lessons) is read as a one-item list.
  const points = parsePoints(object(grammar) ? grammar.explanations ?? grammar.explanation : undefined);
  if (!object(grammar) || !nonempty(grammar.excerpt) || !lower.includes(grammar.excerpt.toLowerCase()) ||
      !nonempty(grammar.pattern) || points.length === 0 ||
      Array.from(grammar.excerpt).length > 300 || Array.from(grammar.pattern).length > 200 ||
      (rawCorrection !== undefined && typeof rawCorrection !== "string") ||
      (proposed !== undefined && Array.from(proposed).length > 300)) {
    return { kind: "partial", english, ...words };
  }
  // Showing no rule beats teaching a false one or the formula style the user found unreadable.
  // Only the points are judged: pattern is stored metadata that neither the panel nor the review
  // page displays, so an unreadable label there must not throw away a readable point.
  const readable = points.filter(point => !contradictsEnding(point, english) &&
    !inventsPhrase(point, english) && !usesFormula(point, english));
  if (!readable.length) return { kind: "partial", english, ...words };
  // An optional correction must compare an English span actually in the submitted input with one in the result.
  // Translating Chinese is never a correction; drop unverifiable suggestions rather than teaching an invented edit.
  // Several edits may be listed as "a → b; c → d"; each pair is checked on its own and the rest are kept.
  const parts = proposed ? proposed.split(/[;；]/) : [];
  const verified = parts.flatMap((part) => {
    const change = /^\s*(.+?)\s*→\s*(.+?)\s*$/u.exec(part);
    if (!change) return [];
    // Show both sides as actually written; casing-only edits are not taught.
    const before = /[A-Za-z]/.test(change[1]!) && !/\p{Script=Han}/u.test(change[1]!) ? span(original, change[1]!) : undefined;
    const after = span(english, change[2]!);
    return before && after && before.toLowerCase() !== after.toLowerCase() ? [`${before} → ${after}`] : [];
  });
  const correction = verified.length ? verified.join("；") : undefined;
  return {
    kind: "ready", english,
    grammar: {
      excerpt: span(english, grammar.excerpt)!, pattern: grammar.pattern, explanations: readable,
      ...(correction ? { correction } : {}),
    },
    ...words,
  };
}

async function bodyText(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > BODY_LIMIT) {
    void response.body?.cancel().catch(() => {});
    throw new GenerationError("oversized");
  }
  if (!response.body) throw new GenerationError("invalid");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal.aborted) throw new GenerationError("cancelled");
      const chunk = await reader.read();
      if (signal.aborted) throw new GenerationError("cancelled");
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > BODY_LIMIT) { cancel(); throw new GenerationError("oversized"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Single nonstream completion over the configured protocol, independent of all host provider state. */
async function complete(
  config: CoachConfig, system: string, user: string, signal: AbortSignal, fetcher: Fetch = globalThis.fetch,
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort();
  signal.addEventListener("abort", forward, { once: true });
  if (signal.aborted) forward();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  const tokens = Math.min(32768, Math.max(4096, Array.from(user).length * 4 + 1024));
  const failure = () => new GenerationError(timedOut ? "timeout" : "cancelled");
  let stopWaiting: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      stopWaiting = () => reject(failure());
      controller.signal.addEventListener("abort", stopWaiting, { once: true });
      if (controller.signal.aborted) stopWaiting();
    });
    // Defer transport one microtask, so cancellation before dispatch sends nothing.
    const request = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw failure();
      const { headers, body } = buildRequest(config, system, user, tokens);
      const response = await fetcher(config.endpoint, {
        method: "POST", redirect: "error", signal: controller.signal, headers,
        body: JSON.stringify(body),
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      if (response.redirected || !response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new GenerationError("http", response.status);
      }
      return envelopeText(config.api, await bodyText(response, controller.signal));
    });
    return await Promise.race([request, aborted]);
  } catch (error) {
    if (controller.signal.aborted) throw failure();
    if (error instanceof GenerationError) throw error;
    throw new GenerationError("network");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forward);
    if (stopWaiting) controller.signal.removeEventListener("abort", stopWaiting);
  }
}

/** Translation or correction for the submitted prompt. */
export async function generate(
  config: CoachConfig, prompt: string, signal: AbortSignal, fetcher: Fetch = globalThis.fetch,
): Promise<Generation> {
  const text = stripPathsAndLinks(prompt);
  if (!hasProse(text) && text !== prompt) throw new GenerationError("invalid");
  return parsePayload(await complete(config, config.systemPrompt, text, signal, fetcher), text);
}
