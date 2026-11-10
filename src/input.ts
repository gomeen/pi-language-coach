// Removed locations become short markers, so the remaining Chinese still reads as a sentence.
const IMAGE = "\uE000";
const FILE = "\uE001";
const LINK = "\uE002";
const MARKERS: Record<string, string> = { [IMAGE]: "「图片」", [FILE]: "「文件」", [LINK]: "「链接」" };
const MARKER_TEXT = /「(?:图片|文件|链接)」/g;
// A location never continues into Chinese text, full-width punctuation or another marker.
const STOP = String.raw`\s<>"'\x60\p{Script=Han}，。！？；：、（）【】「」\uE000-\uE002`;
const IMAGE_EXT = "png|jpe?g|gif|webp|svg|heic|heif|avif|bmp|tiff?|ico";
const FILE_EXT = `tsx?|jsx?|[cm]js|json|md|txt|log|ya?ml|toml|html?|css|scss|py|rs|go|java|swift|sh|sql|pdf|csv|docx?|xlsx?|pptx?|zip|tar|gz|7z|${IMAGE_EXT}`;
const imageLike = (value: string) => new RegExp(`\\.(?:${IMAGE_EXT})(?::\\d+)*[.,;:!?]*$`, "i").test(value);

/** True when real prose remains once removed-location markers are ignored. */
export function hasProse(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(MARKER_TEXT, ""));
}

/** Remove Markdown labels and destinations together, including nested parentheses in destinations. */
function stripInlineLinks(text: string): string {
  const link = /!?\[[^\]\n]*\]\s*\(/g;
  let output = "";
  let copied = 0;
  for (let match; (match = link.exec(text));) {
    let depth = 1;
    let end = link.lastIndex;
    for (; end < text.length && depth; end++) {
      const character = text[end];
      if (character === "\\") { end++; continue; }
      if ((character === '"' || character === "'") && /\s/.test(text[end - 1] ?? "")) {
        const quote = character;
        for (end++; end < text.length && text[end] !== quote; end++) {
          if (text[end] === "\\") end++;
        }
      } else if (character === "<") {
        const close = text.indexOf(">", end + 1);
        if (close !== -1) end = close;
      } else if (character === "(") depth++;
      else if (character === ")") depth--;
    }
    if (depth) break; // Bound malformed-link scanning; bare-location filtering still runs below.
    output += text.slice(copied, match.index) + (match[0].startsWith("!") ? IMAGE : LINK);
    copied = end;
    link.lastIndex = end;
  }
  return output + text.slice(copied);
}

/** Best-effort removal of file locations, complete links and image references, only for coaching. */
export function stripPathsAndLinks(text: string): string {
  const original = text;
  // No labels, alt text, reference definitions, image tags or encoded image bodies go to coaching.
  const references = new Set<string>();
  const referenceId = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  text = text.replace(/^[ \t]{0,3}\[([^\]\n]+)\]:[^\r\n]*(?:\r?\n|$)/gm, (_match, id: string) => {
    references.add(referenceId(id));
    return "";
  });
  text = stripInlineLinks(text);
  text = text.replace(/(!?)\[([^\]\n]*)\](?:[ \t]*\[([^\]\n]*)\])?/g,
    (match, image: string, label: string, id: string | undefined) =>
      image ? IMAGE : id !== undefined || references.has(referenceId(label)) ? LINK : match);
  text = text.replace(/<(a|picture)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi,
    (_match, tag: string) => tag.toLowerCase() === "a" ? LINK : IMAGE);
  text = text.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, IMAGE);
  text = text.replace(/\[(?:image|图片)\s*#?\s*\d+\]/gi, IMAGE);
  text = text.replace(new RegExp(String.raw`\b(?:data:[\w.+-]+\/[^${STOP}]+|blob:[^${STOP}]+)`, "giu"), IMAGE);
  text = text.replace(/<(?:(?:https?|ftp|file):\/\/|mailto:)[^>\n]+>/gi, LINK);
  // Preserve sentence punctuation following a bare location.
  const replace = (marker: string) => (value: string) => marker + (/[.,;:!?]+$/.exec(value)?.[0] ?? "");
  const location = (value: string) => replace(imageLike(value) ? IMAGE : FILE)(value);
  text = text.replace(new RegExp(String.raw`\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^${STOP}]+`, "giu"), replace(LINK));
  text = text.replace(new RegExp(String.raw`(?<![\w@.-])(?:[a-z\d-]+\.)+(?:com|org|net|edu|gov|io|ai|dev|app|cn|uk|cloud|test|invalid)(?![\w-])(?::\d+)?(?:[/?#][^${STOP}]*)?`, "giu"), replace(LINK));
  // Quoted absolute/explicit relative paths can contain spaces.
  text = text.replace(/(["'`])(?:[a-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/)[^\r\n]*?\1/gi, value => location(value.slice(0, -1)));
  // Paths: ASCII segments, or a final Chinese file name followed by a known extension.
  // Without segmentation, Chinese text glued before a Chinese directory name may still be removed.
  const segment = String.raw`[^${STOP}\\/]+`;
  const hanName = String.raw`[\w.@-]*\p{Script=Han}[\p{Script=Han}\d_.@-]*\.(?:${FILE_EXT})(?::\d+)*(?![\w.])`;
  const root = String.raw`(?:[a-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/(?=[\w.~@-]))`;
  text = text.replace(new RegExp(String.raw`(?<![\w.\\/])(?:${root}|[\w.@-]+[\\/]|[\p{Script=Han}\w-]+[\\/](?=\p{Script=Han}))(?:${segment}[\\/])*${hanName}`, "giu"), location);
  text = text.replace(new RegExp(String.raw`(?<![\w.\\/])(?:${root}(?:${segment}[\\/]?)*|[\w.@-]+[\\/](?:${segment}[\\/]?)*)`, "giu"),
    value => {
      // Bare words such as /coach or win/mac are prose; real paths have depth, an extension or a trailing slash.
      const parts = value.replace(/[.,;:!?]+$/, "").split(/[\\/]/).filter(Boolean);
      const rooted = /^(?:[a-z]:|\\\\|~|\.{1,2})[\\/]/i.test(value) || value.startsWith("/");
      const real = /^(?:[a-z]:|\\\\|~|\.{1,2})[\\/]/i.test(value) || parts.length >= (rooted ? 2 : 3) ||
        /[\\/]$/.test(value) || new RegExp(`\\.(?:${FILE_EXT})(?::\\d+)*[.,;:!?]*$`, "i").test(value);
      return real && !/^(?:and\/or|\d+(?:\/\d+)+)[.,;:!?]*$/i.test(value) ? location(value) : value;
    });
  // Standalone filenames (not everyday dotted words such as e.g. or version numbers).
  const filename = (value: string) => replace(imageLike(value) ? IMAGE : FILE)("");
  text = text.replace(new RegExp(String.raw`(?<![\w.@-])[\w.@-]+\.(?:${FILE_EXT})(?::\d+(?::\d+)?)?(?![\w.])`, "giu"), filename);
  text = text.replace(new RegExp(String.raw`(?<=^|[\s\p{P}\uE000-\uE002])${hanName}`, "gimu"), filename);
  if (text === original) return text;
  return text.replace(/(["'`])\s*\1/g, "").replace(/(["'`])([\uE000-\uE002])\1/g, "$2")
    // Repeated markers such as four pasted screenshots in a row read as one reference.
    .replace(/([\uE000-\uE002])(?:[ \t]*\1)+/g, "$1")
    .replace(/[\uE000-\uE002]/g, marker => MARKERS[marker]!)
    .replace(/[ \t]+/g, " ").replace(/ +([，。！？；、,.;!?])/g, "$1").trim();
}
