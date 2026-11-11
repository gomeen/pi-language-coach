# Pi Language Coach

在 Pi 输入框上方显示刚提交提示词的英语表达，第一部分是英文，第二部分是词语和语法；超出终端宽度时自动换行：

```text
don't implement anything yet; outline the goals and plan first.
语法 “还没/先不”的 yet 放在句尾：implement anything yet。
```

中文、中英混合输入会按英语习惯调整语序、句式及分句，翻译成自然英文，不逐字直译；保留原意、限制和动作先后。提示词按“用拼音输入法给编程助手发指令”的场景理解术语，明显的同音错字（如“北京的间距”实为“背景”）按原意翻译，不认识的缩写原样保留。英文输入可以纠正语法和拼写，并用中文解释相关结构。英文按正常大小写显示（句首、I、专有名词和缩写大写，代码和标识符保持原样）；你随手用小写输入英文不算错误，不会单独纠正大小写。原始提示词仍照常发给主模型，**不会替换成译文**。

学习请求在后台独立调用 MiniMax，不等待它完成才开始主任务。教学规则、英文和语法不加入主对话上下文，也不写入会话记录。

## 安装

需要 Node.js **22.19+** 和 Pi。本扩展按 Pi package 标准分发，`package.json` 的 `pi.extensions` 声明入口 `src/index.ts`，不需要编译。

下载或克隆本仓库后：

```bash
# 使用仓库的真实绝对路径；本地安装直接引用该目录，请勿随后删除或移动。
pi install /absolute/path/to/pi-language-coach
```

重新启动 Pi，或在当前 Pi 会话运行 `/reload`。

只试用一次，不写入安装配置：

```bash
pi --extension /absolute/path/to/pi-language-coach/src/index.ts
```

卸载：

```bash
pi remove /absolute/path/to/pi-language-coach
```

不需要把文件复制到 Pi 安装目录，也不要同时用多个方式加载同一扩展。Pi 提供扩展所需的宿主模块；仅运行扩展无需在本仓库安装开发依赖。

## 配置 API key

**每位使用者必须自己配置学习请求的 key。扩展不读取 Pi 的 `auth.json`，不自动复用主模型密钥。**

在启动 Pi 的同一个终端设置（用 `PROVIDER` 选供应商，每个供应商只读自己的 key 变量，可以在同一终端同时配置多个供应商，切换只改 `PROVIDER`）：

```bash
export PI_LANGUAGE_COACH_PROVIDER='h-self'                          # minimax（默认）| deepseek | h-self
export PI_LANGUAGE_COACH_API_KEY='填写你自己的 MiniMax key'          # provider=minimax 时读取
export PI_LANGUAGE_COACH_DEEPSEEK_API_KEY='填写你自己的 DeepSeek key' # provider=deepseek 时读取
export PI_LANGUAGE_COACH_H_SELF_API_KEY='填写你自己的中转站 key'      # provider=h-self 时读取
pi
```

缺少当前供应商的 key 时，主任务不受影响，学习面板保持隐藏，提示中会写明缺少哪个变量；deepseek 和 h-self 永远不会读 `PI_LANGUAGE_COACH_API_KEY`，旧的 minimax 变量也不会泄漏到其他供应商。

### 配置文件（推荐：集中在一处）

所有配置也可以写进一个 JSON 文件：`~/.pi/agent/language-coach/config.json`（与收藏目录同处，建议权限 600）：

```json
{
  "provider": "h-self",
  "thinking": "medium",
  "showOriginal": true,
  "showPractice": true,
  "autoSave": true,
  "timeoutMs": 30000,
  "promptFile": "prompt.md",
  "providers": {
    "minimax":  { "apiKey": "…", "baseUrl": "…", "model": "…" },
    "deepseek": { "apiKey": "…", "baseUrl": "…", "model": "…" },
    "h-self":   { "apiKey": "…", "baseUrl": "…", "model": "…" }
  }
}
```

所有字段均可省略（省略即用预设默认）；`promptFile` 相对于 language-coach 目录解析，`prompt` 可直接内联文本，两者都不写则用内置提示词。优先级为：环境变量 > config.json > 内置默认，按字段逐项生效；文件不存在完全等价于未配置，格式错误会明确停用学习功能并指出文件。不需要 shell 环境变量的用户可以只用这一个文件。

PowerShell：

```powershell
$env:PI_LANGUAGE_COACH_API_KEY = '填写你自己的 MiniMax key'
pi
```

不要把真实 key 提交到 Git、发送到聊天中，或写进扩展源码。本扩展不自动读取 `.env`。建议使用个人 shell 配置或密码管理器注入环境变量；如果直接执行含 key 的命令，要注意 shell 历史记录。

环境变量在会话初始化时读取；修改后重新启动 Pi。缺少 key 时，主任务不受影响，学习面板保持隐藏，不占空行。

### 供应商与模型

学习模型固定，不跟随 `/model` 切换。`PI_LANGUAGE_COACH_PROVIDER` 选择内置供应商，每个供应商自带接口协议、默认地址和默认模型：

| Provider | 协议 | 默认地址 | 默认模型 | key 变量 | 地址 / 模型覆盖变量 |
| --- | --- | --- | --- | --- | --- |
| `minimax`（默认） | Anthropic Messages | `https://api.minimaxi.com/anthropic` | `MiniMax-M3.1-Flash` | `PI_LANGUAGE_COACH_API_KEY` | `PI_LANGUAGE_COACH_BASE_URL` / `PI_LANGUAGE_COACH_MODEL` |
| `deepseek` | OpenAI Chat Completions | `https://api.deepseek.com` | `deepseek-flash`（DeepSeek V4.1 Flash） | `PI_LANGUAGE_COACH_DEEPSEEK_API_KEY` | `PI_LANGUAGE_COACH_DEEPSEEK_BASE_URL` / `PI_LANGUAGE_COACH_DEEPSEEK_MODEL` |
| `h-self` | OpenAI Responses | `https://ai.yuchuantest.com/v1` | `gpt-5.6-luna` | `PI_LANGUAGE_COACH_H_SELF_API_KEY` | `PI_LANGUAGE_COACH_H_SELF_BASE_URL` / `PI_LANGUAGE_COACH_H_SELF_MODEL` |

`h-self` 预设按 OpenAI Responses 协议中转站接入，请求固定 `store: false`；指向其他 OpenAI 兼容中转站时改用各自的 `_BASE_URL` 覆盖变量即可。追加的路径由协议自动确定：`/v1/messages`、`/chat/completions`、`/responses`（deepseek 官方地址不带 `/v1`，中转站地址一般带）。默认使用实测速度最快的 **`MiniMax-M3.1-Flash`**（同形状请求延迟约为 M3 的一半，单价也是 M3 一半）：

```bash
export PI_LANGUAGE_COACH_MODEL='MiniMax-M3.1-Flash'
export PI_LANGUAGE_COACH_BASE_URL='https://api.minimaxi.com/anthropic'
```

早期默认为 `MiniMax-M3`（沿用 Pi 自定义配置的 `minimax-cn/MiniMax-M3[1M]`）。真实验证中，中国区接口以 HTTP 400 拒绝了 `MiniMax-M3[1M]`，而 `MiniMax-M3` 请求成功，因此曾显式修正；2026-11 又用同形状请求实测四组模型×思考档位后切换到 M3.1-Flash。直接请求不要加 `minimax-cn/` 前缀或未经服务支持的 `[1M]` 后缀。扩展仍不会在请求失败时偷偷换模型或回退到主模型；显式配置的 ID 会原样发送。

国际区账号可显式设置：

```bash
export PI_LANGUAGE_COACH_BASE_URL='https://api.minimax.io/anthropic'
export PI_LANGUAGE_COACH_MODEL='MiniMax-M3'
```

区域、账号、key、套餐、模型和接口必须匹配。扩展不会自动读取或迁移你在 Pi `models.json` 中的自定义地址、请求头或认证配置。

### 思考档位

默认 `PI_LANGUAGE_COACH_THINKING='medium'`：发送 `thinking: {"type": "adaptive"}` 让模型在回答前思考，并附 `output_config: {"effort": "medium"}` 限制思考深度。2026-11 用 3 个固定样例 × 4 轮实测：M3.1-Flash 加 `effort: medium` 后思考 token 从约 400–2200 降到约 140–230，中位延迟从 9.8s 降到 3.5s，且是最稳的组合（最差 6.9s）；译文与讲解仍然完整有效。此实测仅为当次观察，不是延迟或质量承诺。

接受值：`adaptive`（开思考，深度由模型自定）、`low` / `medium` / `high`（开思考并加 effort 上限）、`disabled`（关思考，请求中省略该字段）。注意：**M3 只有开/关两档**，实测忽略 `output_config.effort`，档位不改变其思考深度；若把 `PI_LANGUAGE_COACH_MODEL` 换回 M3，思考档位仅有 `adaptive` 与 `disabled` 有区别。无法关闭思考的模型会拒绝显式 `disabled`，因此关闭时扩展直接省略该字段。

档位按协议映射：minimax 发送 `thinking: {"type":"adaptive"}` 加 `output_config.effort`；deepseek 的思考只有开/关（`thinking:{"type":"enabled"}` / `{"type":"disabled"}`），`low`/`medium`/`high` 都映射为开，与 Pi 的接入一致；OpenAI Responses 协议发送 `reasoning:{"effort":档位}`，`disabled` 发送 `effort:"none"`，`adaptive` 省略该字段（由服务端默认档位决定）。

```bash
export PI_LANGUAGE_COACH_THINKING='medium'    # 默认：思考开，深度中等
export PI_LANGUAGE_COACH_THINKING='disabled'   # 关闭思考，换取更快响应
```

各地址覆盖变量是对应协议的根地址，不要带路径后缀（`/v1/messages`、`/chat/completions`、`/responses` 由扩展按协议追加）；仅支持 HTTPS（本机 HTTP 用于测试），拒绝带 URL 账号、查询参数或 fragment 的地址，并且不跟随重定向。所有协议都用非流式请求。自定义地址会收到当前提示词和专用 key，请只使用可信服务。

### 面板显示与练习框

两个显示开关默认都开启，只改展示，不影响收藏内容（收藏始终包含完整原文、英文和语法）：

```bash
export PI_LANGUAGE_COACH_SHOW_ORIGINAL='false'   # 不在译文上方显示「原文：」行
export PI_LANGUAGE_COACH_SHOW_PRACTICE='false'   # 结果出来后不再自动弹出「输入一遍」练习框
```

`SHOW_PRACTICE=false` 只关闭自动弹出；想练习时仍可运行 `/coach practice` 手动打开，回车或 Esc 关闭。

### 自定义教学提示词

不设置时使用内置教学提示词（要求返回固定 JSON：english、words、grammar）。可以完整替换：

```bash
export PI_LANGUAGE_COACH_PROMPT='你自己的完整提示词'
# 或指向一个 UTF-8 文本文件（优先级高于 PROMPT）：
export PI_LANGUAGE_COACH_PROMPT_FILE='/absolute/path/to/prompt.md'
```

替换是整体替换，内置提示词的格式要求（固定 JSON 形状、词语必须出现在英文中、语法点约束等）不会自动保留；若自定义提示词导致返回无法解析或缺少字段，面板会保留可用部分并标注缺失，不会报错中断主任务。路径需是本机可读的文本文件；读取失败时学习功能停用并在提示中说明。

### 可选配置

| 环境变量（均可在 config.json 中以同名字段替代，环境变量优先） | 默认值 | 含义 |
| --- | --- | --- |
| `PI_LANGUAGE_COACH_PROVIDER` | `minimax` | 学习服务供应商：`minimax`、`deepseek`、`h-self`（OpenAI Responses 中转站） |
| `PI_LANGUAGE_COACH_API_KEY` | 无 | minimax 的独立学习 key；deepseek/h-self 不读这个变量 |
| `PI_LANGUAGE_COACH_DEEPSEEK_API_KEY` / `PI_LANGUAGE_COACH_H_SELF_API_KEY` | 无 | 对应供应商的独立学习 key |
| `PI_LANGUAGE_COACH_MODEL` | `MiniMax-M3.1-Flash` | minimax 的准确模型 ID；deepseek/h-self 用各自的 `…_DEEPSEEK_MODEL` / `…_H_SELF_MODEL` |
| `PI_LANGUAGE_COACH_THINKING` | `medium` | `adaptive`（开思考，深度模型自定）、`low`/`medium`/`high`（思考 effort 上限）、`disabled`（关思考）；按协议映射（见上）；M3 忽略档位 |
| `PI_LANGUAGE_COACH_BASE_URL` | `https://api.minimaxi.com/anthropic` | minimax 的 Anthropic 兼容根地址；deepseek/h-self 用各自的 `…_DEEPSEEK_BASE_URL` / `…_H_SELF_BASE_URL` |
| `PI_LANGUAGE_COACH_AUTO_SAVE` | `true` | 默认自动收藏有效英文结果；设为 `false` 或 `0` 可永久关闭（重启 Pi 后生效），仍可手动收藏 |
| `PI_LANGUAGE_COACH_TIMEOUT_MS` | `30000` | 单次学习请求超时，毫秒 |
| `PI_LANGUAGE_COACH_SHOW_ORIGINAL` | `true` | 译文上方是否显示「原文：」行 |
| `PI_LANGUAGE_COACH_SHOW_PRACTICE` | `true` | 每个新结果后是否自动弹出「输入一遍」练习框；`/coach practice` 不受影响 |
| `PI_LANGUAGE_COACH_PROMPT` | 内置提示词 | 整体替换教学提示词；输出仍须是约定 JSON 形状 |
| `PI_LANGUAGE_COACH_PROMPT_FILE` | 无 | 从 UTF-8 文件读取提示词，优先于 `PROMPT` |

## 使用

直接在 Pi 提交提示词即可，无需额外前缀。

- 原文（译文上方第一行）：以 `原文：` 前缀原样显示本次提交的内容，方便对照译文；多行输入压成一行，超宽自动换行。这行显示的是原始输入；发送给学习服务前仍会先把路径、链接和图片引用替换为标记。
- 英文：直接显示英文翻译或纠正后的英文，不带 `EN` 标签。
- 讲解（紧接英文下方）：先列最多 3 个可能不认识的词语及其在本句中的中文意思，再用中文讲一个表达或语法点，优先讲中英文说法不同的地方，例如中文把“现在、在页面上”放句首，英文常放句尾；中文长修饰放名词前，英文放后面；“是否、不是…而是、先…再”对应的英文说法。格式如 `词：mocked 用假数据模拟的 · hard-coded 写死的 ｜ 语法：“没有东西…”用 nothing，后面不再加 not。`。词语必须出现在英文中，太基础的词（check、fix、add）不列；语法讲解可以用动词、名词、过去式、被动这类基础术语，但要配上句中的真实单词，不用“宾语从句”这类较难术语或 `don't + adverb + base verb` 这类公式。英文原句有错误时才附上词语级纠错。语法点无效时仍显示词语。模型生成仍可能不准确，不能保证每次都符合要求。
- **只有取得英文结果才显示面板**。请求中、跳过、请求失败、未配置、未提交、清空或关闭时完全移除面板，不显示提示文字、不保留占位空行。
- 不增加标题、边框、状态栏或空白行。
- 长原文、译文与讲解保留完整文本，超出终端宽度时自动换行显示，不需要翻页。长输入的结果会占用更多行。
- 不再按本地字符数跳过长提示词，也不截断原文。模型本身仍有上下文和最多 32768 输出 token 等服务限制；超限或未完成会隐藏结果，不冒充完整译文。响应读取保留 1 MiB 安全上限。
- 默认在获得有效英文后自动保存原文、完整英文、词语注释和可用语法（不要求语法有效）；内容去重，生成中、失败、被取消、跳过和旧响应不保存。关闭自动收藏后仍可手动保存。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/coach` | 清除当前显示；命令用法见此表，不显示状态占位 |
| `/coach on` | 开启后续输入的自动学习，无结果时仍隐藏面板 |
| `/coach off` | 取消学习请求、清除内存内容并隐藏面板 |
| `/coach retry` | 重试最近一条可处理的提交，仅请求学习模型，不重发主提示词 |
| `/coach clear` | 取消学习请求、清除内存内容并隐藏面板，保持开关状态；不删除已收藏文件 |
| `/coach save` | 收藏当前原文、完整英文、词语注释与有效语法；等同于按 `F8` |
| `/coach practice` | 输入一遍：在讲解下方打开输入区，照着英文敲一遍，回车退出 |
| `/coach review` | 用浏览器打开本机收藏阅读列表，不需要 API key |
| `/coach autosave off` | 在当前 Pi 运行期间关闭自动收藏，不影响手动收藏 |
| `/coach autosave on` | 在当前 Pi 运行期间重新开启自动收藏；不追溯收藏此前结果 |

命令不改动正在编辑的草稿。`autosave` 命令在当前 Pi 运行期间生效，切换会话不重置；重新加载扩展后由 `PI_LANGUAGE_COACH_AUTO_SAVE` 环境变量决定；其他开启状态也不跨重启保存。连续提交时取消旧请求，只有最新提交的结果能更新面板；新会话、切换会话、重载、退出和会话树切换会清理旧学习状态。

### 输入一遍

学习结果出现时，若主编辑器没有草稿，练习输入区**默认自动出现**，位于讲解下面；若已经在写下一条提示，则不自动切走焦点，之后可用 `/coach practice` 手动打开：

- 上面是原文、英文和讲解，下方是与 Pi 正常提示词输入区同款的多行编辑框，带上下边框，支持自动换行、光标移动和粘贴。上边框标注「输入一遍」，下边框提示退出按键。照着英文敲一遍，敲完回车即退出——主动产出比只读一遍记得牢。
- **不做任何校验**：输入对不对由你自己对照英文。不请求任何模型、不联网、不写入收藏文件，也不进入主对话上下文。
- **回车或 Esc 关闭输入区**，恢复讲解和正常编辑器；关闭前后你正在编辑的草稿都会保留。练习没有专用快捷键（避免与其他扩展冲突，例如 Plan 模式的 F2），关闭后用 `/coach practice` 可随时再打开；没有结果、或学习未配置/关闭时，该命令只给提示。
- 练习是原生编辑器的本地模式，不打开阻塞式提问，因此**不会触发 Orca 的「需要输入」提醒**；正常提问、确认与审批提醒保持不变。练习与主草稿使用独立缓冲区，长粘贴的正文和光标位置不会经文本恢复而丢失。F8 收藏仍可用；应用级控制键会返回主编辑器并按 Pi 原有方式处理。
- 若其他扩展也注册了编辑器组件（例如用量条、Vim 模式），不会争夺：language-coach 会把练习能力叠加到对方的编辑器实例上（保留其类、草稿和装饰），打开练习框时显示练习输入，关闭后恢复对方原样。`/coach autosave off` 只关闭自动收藏，不关闭练习。

### 快捷键收藏

自动收藏默认开启；需要手动收藏时，在看到英文结果后按 **F8**，保存该结果对应的原文、**完整而非被界面截断的英文**、有效语法说明和收藏时间。没有结果时不保存、不显示占位；相同原文、英文与语法重复收藏只保留一份。仅英文有效时也可收藏，此时不保存无效语法。

成功、重复或写入失败的提示会显示在讲解开头约 1.8 秒，然后恢复；不改草稿，不调用模型。快捷键在主编辑界面使用；弹窗可能接管按键。macOS 的 Option+S 在某些终端会输入 `ß` 而非发送 Alt 键，因此扩展默认使用 F8；若键盘需要 Fn 才能发送 F8，请按 Fn+F8。不方便使用功能键时可执行 `/coach save`。可通过 `/hotkeys` 检查快捷键。若希望用 **F19+S 同时按**，需在终端外通过按键映射工具把该组合映射为 F8；当前用户的 Karabiner-Elements 已配置为仅在 Orca 前台映射，不属于发布包配置。

默认目录：

```text
~/.pi/agent/language-coach/saved/
```

设置了 `PI_CODING_AGENT_DIR` 时，会改用该目录下的 `language-coach/saved/`。也可以在启动 Pi 前设置绝对路径：

```bash
export PI_LANGUAGE_COACH_STORAGE_DIR='/absolute/path/to/saved-lessons'
```

每条收藏是一个 UTF-8 JSON 文件，包含格式版本、内容 ID、收藏时间、原文、英文及可用的词语注释和语法。新建收藏目录和文件的权限分别为 `0700`、`0600`（POSIX）；文件**不加密**。不修改已有目录权限，不自动备份或同步。清空内存、关闭学习、切换会话或重启不会删除收藏；可手动删除对应 JSON，或删除 `saved/` 下所有收藏文件。

执行 `/coach review` 会读取该目录中的收藏 JSON，按收藏时间倒序生成同目录的 `review.html`，并在系统默认浏览器中打开。每次执行都会重新生成；浏览器中已打开的页面可能需要手动刷新。页面只显示原文、英文、词语注释和可用的中文语法说明（旧收藏中的公式字段也不展示），保留完整文本；没有答题、评分或定期提醒。超过 10 条时按每页 10 条分页，页面底部用「上一页／下一页 + 页码」切换，仍是同一个自包含离线文件，分页仅靠 CSS（`:target`）实现，不引入脚本或外部资源；10 条以内与旧版完全相同。未收藏时显示空状态；损坏或不支持的收藏会跳过并显示数量，不修改原文件。该离线快照同样是**明文**，权限为 `0600`（POSIX），手动打开或清除可使用 `saved/review.html`。自动打开失败时 Pi 会提示路径，文件仍可手动打开。阅读无需启动服务器、请求模型或修改主会话。

### 自动处理范围

仅处理交互式终端中的人工文本提交。RPC、print、JSON 模式和其他扩展注入的输入不会触发学习请求。跳过空内容、斜杠命令、`!` shell 输入和纯代码围栏。发送翻译请求前会把常见文件路径、文件名、完整链接（含 Markdown 标签）和图片引用（含替代文字、HTML 图片标签、图片 data URI 与图片占位符）替换为 `「文件」`、`「链接」`、`「图片」` 标记，原内容不发送；不发送图片附件。路径紧贴中文时只替换路径本身，例如 `去掉/tmp/a.png上面的标题` 发送为 `去掉「图片」上面的标题`，译文仍是完整句子；连续多张截图合并为一个标记。`win/mac`、`前端/后端`、`/coach` 这类单段写法保留原样。没有分词，中文目录名前紧贴的中文词仍可能被一起替换。附图输入仅翻译剩余正文；替换后只剩标记则不请求模型，重试同样执行过滤。主模型收到的提示词保持原样。长输入的其余正文不截断，服务自身的容量限制仍然适用。

英文纠错是学习建议，不是可靠的语法校验器。语法输出无效时保留可用英文，并在讲解中提示语法暂不可用（有词语时只显示词语）。讲解与英文自相矛盾（如称 objectives “不加 s”）、引用译文里没有的搭配（如 match with），或使用 `don't + adverb + base verb`、`动词 + 名词` 这类公式，或使用主语、宾语、从句、动名词、祈使句这类较难术语时，也按语法无效处理；服务返回不完整生成时不将其当成完整译文。

## 隐私、上下文与费用

- 每次学习请求仅发送固定教学规则和**当前提交文本中把常见路径、文件名、完整链接和图片引用替换为标记后的正文**。不读取主对话历史、工具结果、项目文件或主模型 system prompt。
- 译文和讲解只经 `ctx.ui.setWidget()` 显示，不调用消息注入、工具注册或会话持久化接口。
- 即使主模型也是 MiniMax，两者也没有共享对话历史。原始输入仍按 Pi 自身的正常流程进入主会话。
- 其他扩展可能在本扩展前后转换输入；这里不保证学习文本等于最终主模型收到的 provider payload。
- 每条可处理提交通常多一次付费请求，手动重试也会产生用量。学习用量不计入 Pi 主会话的 token/费用显示，实际账单以 MiniMax 为准。
- 路径和链接过滤采用启发式识别，不是完整的隐私脱敏或敏感信息检测；特殊格式仍可能漏过。普通文本里的密钥、内部代码和隐私也可能随提示词发送给学习服务；处理敏感内容前请 `/coach off`。
- **默认自动收藏每个成功生成的结果**，原文、完整英文和可用语法明文保存在本机（包括含代码、路径、密钥或隐私的原文）；不将配置的 API key 或原始服务错误响应写入收藏。若不希望落盘，启动前设 `PI_LANGUAGE_COACH_AUTO_SAVE=false`，或运行 `/coach autosave off` 暂时关闭。关闭后仍可用 F19+S（Orca 的本机映射）、F8 或 `/coach save` 手动收藏。请谨慎处理敏感输入和备份。进程内存、终端回滚缓冲、截图，以及 MiniMax 的数据保留政策不在此保证范围内。
- Pi 的原有会话记录不受本扩展改变；此前显示的内容也不会因为清空面板而从终端历史中抹除。

## 排错

| 现象 | 检查 |
| --- | --- |
| 找不到 `/coach` | 检查 `pi list`，重新启动或 `/reload`，避免入口路径失效 |
| 缺少 API key | 确认变量名是 `PI_LANGUAGE_COACH_API_KEY`，且从设置变量的同一终端启动 Pi |
| HTTP 401 / 403 | 检查专用 key、区域和套餐权限；不会自动使用其他凭据 |
| HTTP 400 / 404 | 检查准确模型 ID 和 Anthropic 接口地址，尤其自定义的 `[1M]` 标识 |
| HTTP 429 | 降低提交频率或稍后手动重试；不自动循环重试 |
| 超时 / 网络错误 | 检查网络、代理和接口可用性，可适当增加超时后重启 |
| 没有学习结果 | 无结果时不显示状态提示，这是设计行为。确认已开启、设置了专用 key、使用交互终端，且输入没有被跳过、模型未超出自身容量限制；可用 `/coach retry` 重试 |

## 复习页展示原型

[prototypes/review-demo.html](prototypes/review-demo.html) 是此前的独立 HTML 草图；正式复习请在 Pi 输入 `/coach review`，显示真实收藏。草图可双击离线打开，或运行：

```bash
npm run demo:review
```

浏览器打开 `http://127.0.0.1:8767/review-demo.html`。草图仅保留简洁阅读列表，**其中是示例数据**；正式 `/coach review` 读取真实收藏，无需运行这个预览服务。当前截图为 `prototypes/review-reading.png` 和 `prototypes/review-mobile.png`。

## 开发与验证

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
```

可选真实 Pi 伪终端回归（需要 PATH 中有 `pi`，并在 Python 虚拟环境中安装测试依赖 `pyte`）：

```bash
python test/smoke-pi.py
COACH_SMOKE_FULLSCREEN=1 python test/smoke-pi.py
```

脚本使用临时 HOME、模拟 key 和本地模拟服务，不调用真实模型；截图文本写入 `.scratch/`。

开发依赖仅供检查和测试；宿主提供的 Pi 包声明为 `peerDependencies`，不作为运行时依赖打包。`prototypes/` 保留早期 HTML 草图，**不是最终扩展，也不进入发布包**。

自动测试使用模拟服务，不使用真实 key；输入一遍覆盖默认自动出现（每个新结果）、回车/Esc 关闭契约、无结果与未配置提示、`/coach practice` 重开及已打开时不再关闭。练习无专用快捷键，避免与其他扩展冲突（如 Plan 模式的 F2）。另已在隔离配置目录启动真实 Pi 1.5.0，通过伪终端和本地模拟服务检查：100/36 列宽的上下两行、主任务不等待学习响应、学习请求不带历史、主请求和会话记录不含学习内容，以及清空和关闭行为。收藏与复习功能另通过单元/集成测试及真实 Pi 的 regular/fullscreen 伪终端验证：实际 F8/F9/F10 按键、草稿保留、完整内容保存、重复去重、自动收藏开关、第二行临时反馈，以及收藏不增加模型请求、不写入主会话。

另于 2026-11-07 使用真实中国区 MiniMax 接口验证了中文翻译、路径/命令限制和英文纠错三个固定样例，最终均成功，耗时约 1.4–1.7 秒；默认模型已从服务拒绝的 `MiniMax-M3[1M]` 修正为 `MiniMax-M3`。详见 [真实验证记录](docs/minimax-live-validation.md)（仓库文档，不随 npm 包分发）。这不是普遍质量或延迟保证，其他账号/区域、长期稳定性和真实账单仍需自行核实。

## 发布状态

当前为可本地安装的扩展包，采用 [MIT 许可证](LICENSE)，已完成上述真实 MiniMax 固定样例验证。尚未发布到 npm，也未替你修改全局 Pi 配置；公开发布前还需确定仓库/包发布位置。

## 参考

交互目标借鉴 [prompt-language-coach](https://github.com/leeguooooo/prompt-language-coach)。本扩展独立实现，不复制其 hook 注入方式：学习内容不会附在主模型回答中。

Pi 接口与打包约定：

- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
