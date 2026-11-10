import { test } from "node:test";
import assert from "node:assert/strict";
import { stripPathsAndLinks } from "../src/input.ts";

const examples = [
  ["请检查 /Users/me/private/app.ts，别用 --force。", "请检查 「文件」，别用 --force。"],
  ["查看 src/index.ts 和 ./test/，再看 ../docs/plan.md。", "查看 「文件」 和 「文件」，再看 「文件」。"],
  ["Compare C:\\Users\\me\\app.ts with \\\\server\\share\\data.csv", "Compare 「文件」 with 「文件」"],
  ["Open ~/Documents/notes.md and '/Users/me/My Notes/draft.md'", "Open 「文件」 and 「文件」"],
  ["Open \"C:\\My Files\\app.ts\" and `./my docs/plan.md`", "Open 「文件」 and 「文件」"],
  ["Read https://example.com/private?q=SECRET#token, then www.example.org/docs.", "Read 「链接」, then 「链接」."],
  ["看 <https://example.com/private> 和 [这份文档](https://example.com/a)，不要修改。", "看 「链接」 和 「链接」，不要修改。"],
  ["根据 [src/private.ts](https://example.com/a) 修复", "根据 「链接」 修复"],
  ["Check example.com/private and docs.example.cn", "Check 「链接」 and 「链接」"],
  ["修改 index.ts、package.json 和 README.md", "修改 「文件」、「文件」 和 「文件」"],
  ["请检查src/index.ts，先别改。", "请检查「文件」，先别改。"],
  ["Email alice@example.com and use 24/7 support.", "Email alice@example.com and use 24/7 support."],
  ["按 `src/index.ts:12:3` 检查，不要执行 --force。", "按 「文件」 检查，不要执行 --force。"],
  ["/var/tmp/image.png 这个地方能否显示输入框", "「图片」 这个地方能否显示输入框"],
  ["请检查 ![PRIVATE_ALT](https://example.com/private.png)，先别改。", "请检查 「图片」，先别改。"],
  ["请检查 [PRIVATE_LABEL](https://example.com/a(b(c)).pdf \"PRIVATE_TITLE\")，先别改。", "请检查 「链接」，先别改。"],
  ["请检查 [PRIVATE_LABEL][private]，先别改。\n[private]: https://example.com/private \"PRIVATE_TITLE\"", "请检查 「链接」，先别改。"],
  ["请检查 [private]，先别改。\n[private]: /Users/me/private.pdf", "请检查 「链接」，先别改。"],
  ["![PRIVATE_ALT][private]\n[private]: /Users/me/private.png", "「图片」"],
  ["看 <img src=\"/Users/me/private.png\" alt=\"PRIVATE_ALT\">，先别改。", "看 「图片」，先别改。"],
  ["看 <a href=\"https://example.com/private\">PRIVATE_LABEL</a>，先别改。", "看 「链接」，先别改。"],
  ["看 <picture><source srcset=\"PRIVATE_IMAGE.avif\"><img src=\"PRIVATE_IMAGE.png\"></picture>，先别改。", "看 「图片」，先别改。"],
  ["看 [PRIVATE_LABEL](https://example.com/private \"PRIVATE_TITLE (\")，先别改。", "看 「链接」，先别改。"],
  ["看 data:image/png;base64,PRIVATE_IMAGE_DATA，再检查。", "看 「图片」，再检查。"],
  ["[Image #1] 请检查这个界面", "「图片」 请检查这个界面"],
  ["只看 项目/私人截图.heic 和 截图.avif，先别改。", "只看 「图片」 和 「图片」，先别改。"],
  ["https://example.com/private", "「链接」"],
  ["`/Users/me/private.ts`", "「文件」"],
  ["[src/a.ts](https://example.com/a)", "「链接」"],
  ["Don't implement it yet. Use --force only after M2.", "Don't implement it yet. Use --force only after M2."],
  ["支持 24/7 and/or 离线模式，版本 1.2.3；保留 foo_bar。", "支持 24/7 and/or 离线模式，版本 1.2.3；保留 foo_bar。"],
  ["1. 去掉/var/folders/2f/7ck/T/orca-paste-1794.png上面的标题\n2. 分两行显示筛选项/var/folders/2f/7ck/T/orca-paste-1794.png", "1. 去掉「图片」上面的标题\n2. 分两行显示筛选项「图片」"],
  ["1. 子表格显示还是不对/var/folders/2f/7ck/T/orca-paste-1794.png", "1. 子表格显示还是不对「图片」"],
  ["/var/folders/2f/7ck/T/orca-paste-1794.png现在实现的子table和算法配置不一致/var/folders/2f/7ck/T/orca-paste-1794.png，检查优化", "「图片」现在实现的子table和算法配置不一致「图片」，检查优化"],
  ["这个地址/Users/me/code/collection-miniapp的小程序，是当前项目配套的", "这个地址「文件」的小程序，是当前项目配套的"],
  ["/var/folders/2f/7ck/T/orca-paste-1794.png /var/folders/2f/7ck/T/orca-paste-1794.png /var/folders/2f/7ck/T/orca-paste-1794.png 1. 图2和5是drawer", "「图片」 1. 图2和5是drawer"],
  ["'/Users/me/Caches/Files/开发步骤与前后端联调设计.md'  这是后端发送给我的文档", "「文件」 这是后端发送给我的文档"],
  ["看/tmp/截图.png吧", "看「图片」吧"],
  ["修改index.ts的逻辑", "修改「文件」的逻辑"],
  ["打开https://example.com/x看看", "打开「链接」看看"],
  ["win/mac 的发布流程，前端/后端都检查", "win/mac 的发布流程，前端/后端都检查"],
  ["运行 /coach review 看看，中/英混合输入", "运行 /coach review 看看，中/英混合输入"],
] as const;

for (const [input, expected] of examples) {
  test(`remove paths and links: ${input}`, () => {
    const output = stripPathsAndLinks(input);
    assert.equal(output, expected);
    assert.equal(stripPathsAndLinks(output), output, "controller and transport filtering must be idempotent");
  });
}
