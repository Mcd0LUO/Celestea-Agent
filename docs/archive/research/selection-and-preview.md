# Celestea Agent：「选段提及」+「文件侧边弹出预览」调研与设计

> 状态：**历史参考**。本文件是调研/迁移阶段的记录，W890 起归档到 `docs/archive/`；现行口径见 [`docs/README.md`](../../README.md)。
> 📦 **历史文档**。

| 项 | 值 |
| --- | --- |
| 任务 | 「选段提及」+「文件侧边弹出预览」调研（只调研、不改代码） |
| 仓库 | `/src/celestea_studio-ts`（main @ 576657f） |
| 前端 | `apps/web`（无框架 TypeScript + DOM，Vite 打包） |
| 状态 | **调研 / 设计稿，未实现**（本轮只新增本文件，未改任何既有文件、未跑 build/check、未重启服务） |

> 事实与推测分栏：外部行为来自本轮联网调研（来源见 §6）；本机 `file:line` 均为实测。
> 行号基于本轮读到的 main 工作树。

---

## 0. 结论摘要（TL;DR）

1. **两件事都能落地，但被同一个后端事实卡住**：`POST /api/turn` 只收 `input: string`（+ 图片 `attachments`，见 `apps/web/src/api.ts:207-211`、`apps/web/src/types.ts:389-423`），**没有任何「引用/上下文片段」入参**；文件系统只有 `GET /api/fs/browse`（**只列目录**，`apps/web/src/api.ts:295-297`），**没有任何读文件内容的端点**。
2. **选段提及的 P0 不需要动后端**：照抄 W869 文本附件的成熟范式（唯一 ASCII 定界行 + 正文同形行转义 + 发送前注入消息文本，`apps/web/src/ui/text-attach.ts:109-145`），把引用块序列化进 `input`。老后端零改动，历史回放可解析出引用气泡。
3. **文件侧边预览的 P0 只能预览「会话里已经出现过的内容」**：`read_file` 的工具结果全文就在 `.tool-out`（`apps/web/src/ui/toolcards.ts:197-212`），代码高亮已有 `highlightCode()`（`apps/web/src/utils/hljs.ts:91`），图片放大已有 `openLightbox()`（`apps/web/src/ui/attachment-view.ts:140-154`）。**任意工作区文件的预览需要新增 `GET /api/fs/read`，属后端契约变更，本轮不做**。
4. **可复用地基很厚**：悬停提示注册缝（`ui/hint/`）、锚定弹层落位（`ui/anchor-popup.ts` + `ui/grants/geom.ts`）、浮层 Esc 栈（`utils/overlays.ts`）、按会话隔离的待发区（`ui/attachments.ts`）、唯一 HTML→DOM 消毒出口（`utils/sanitize.ts`）、#main 内绝对定位留白带先例（`ui/worker-strip.ts`、`ui/rail.ts`）。**真正要新建的只有**：选区监听/浮标、引用数据模型与序列化、文件路径识别、预览面板与预览器分派。
5. **交互范式**：外部产品普遍是「hover = 零提交预览，click/快捷键 = 提交进上下文」；引用编码有「快照 vs 可解析锚点」两条谱系（ChatGPT/GitHub 快照；Cursor/Claude Code/Zed 锚点）。本项目适合**快照为主 + 记录来源锚点/hash**，因为后端不解析锚点、且消息 DOM 会被整批搬家（不能存活引用）。
6. **红线**：引用文本来自模型输出/工具结果 = 不可信输入，进 DOM 必须走 `sanitizeNodes`；侧边预览必须遵守 8 条前端铁律（离屏构建 + 单次替换、竞态守卫、不重建背景）。

---

## 1. 现有可复用地基（本机实测，file:line）

### 1.1 已经具备、可直接复用

| 能力 | 位置 | 说明 / 可复用点 |
| --- | --- | --- |
| 悬停提示注册缝 | `apps/web/src/ui/hint/registry.ts:14-47`、`ui/hint/card.ts:34-106`、`ui/hint/builtin.ts:22-31` | 提供者只给内容，延迟/宿主/落位/撤卡归引擎。选段浮标/文件预览若做成 hover，可直接注册提供者（先例：rail 富卡片 `ui/rail.ts:257-268` + `ui/rail-card.ts:53-85`）。 |
| 锚定弹层落位 | `apps/web/src/ui/anchor-popup.ts:68-75` + `ui/grants/geom.ts`（`panelGeom`） | 「贴着锚点上方弹出、越界回退、max-height 内部滚动」的唯一算式。选段浮标/预览浮层落位直接复用。 |
| 浮层 Esc 层级栈 | `apps/web/src/utils/overlays.ts:63-103` | 一次 Esc 只关栈顶一层；预览面板可 `pushOverlay`。 |
| **文本附件注入范式（关键先例）** | `apps/web/src/ui/text-attach.ts:109-145` | `TEXT_BLOCK_DELIMITER`（`:121`）+ `escapeDelimiterLines`（`:123-129`）+ `injectTextAttachments`（`:136-145`）。引用块序列化照抄这一套即可防边界伪造。 |
| 文本读取/二进制嗅探/扩展名判定 | `ui/text-attach.ts:14-34,66-74` | `MAX_TEXT_FILE_BYTES`=256KiB、`readTextFile`（NUL/C0 控制字符即判二进制）、`TEXT_FILE_EXTS`。文件预览的「能不能当文本预览」可直接复用。 |
| 按会话隔离的待发状态 + objectURL 回收 | `ui/attachments.ts:154-346` | `drafts: Map<session, PendingAttachment[]>`、`addFiles/takePending/restorePending/clearPending`、`MAX_PREVIEWS` 回收。引用 chip 可做成它的兄弟 `pendingQuotes`。 |
| 乐观发送 + 失败完整回滚 | `ui/send.ts:83-118`（`startTurn`）、`:163-193`（`failTurn`） | 引用随文本一起发：失败时把引用放回待发区（与附件同路径）。 |
| 输入栏与展示夹 | `ui/inputbar.ts:120-157`、`ui/attach-tray.ts`、`ui/attachment-view.ts:31-88` | 纯 textarea（无富文本）；展示夹是「悬浮在输入框上方、单行横向滚动、可整体折叠」的成熟形态。引用 chip 直接沿用。 |
| Markdown/HTML 唯一安全出口 | `ui/messages/markdown.ts:16-28`、`utils/sanitize.ts:374-397`、`utils/markdown.ts:82-97,409-509` | 所有不可信 HTML → DOM 必须走 `sanitizeNodes/renderHtmlSafe/renderMarkdownSafe`；引用快照、预览内容一律经此。 |
| 代码高亮 | `utils/hljs.ts:91`（`highlightCode`） | 14 种语言、单块 >32KB 跳过、带缓存。代码预览直接调用。 |
| 消息 DOM 结构（选区/锚点） | `ui/messages/user.ts:42-59`、`ui/messages/assistant.ts:194-205`、`ui/toolcards.ts:161-170` | `.mcol > .msg > .bubble > .content`；工具结果在 `.tool-out`（`pre`）。选区取文本与来源定位都在这几个节点上。 |
| 图片预览/放大 | `ui/attachment-view.ts:116-154`（`thumb/openLightbox`） | 图片文件预览可复用（objectURL + overlays）。 |
| 文件/目录浏览弹窗 | `ui/fsbrowser.ts:61-231`（`openFsBrowser/pickDirectory`） | 目录选择已有；可作「在文件管理器中打开」的降级出口。 |
| #main 内绝对定位留白带先例 | `ui/worker-strip.ts`（`styles/workerstrip.css`）、`ui/rail.ts`（`styles/rail.css:16-23`） | 「绝对定位于 #main、钉在正文列一侧空白带、留白不足整条隐藏、指针穿透」。侧边预览面板可沿用同款几何。 |
| 布局骨架 | `apps/web/index.html:27-54`、`styles/layout.css:33,84` | `#layout` flex = `#sidebar` + `#sidebarResizer` + `#main`（flex column）。真正的第三栏要动 #layout；浮层/覆盖式预览零布局改动。 |
| 模块体积棘轮 | `apps/web/tools/module-size-baseline.json`、`tools/check-module-size.mjs` | 新模块默认 ≤400 行；已登记文件只许降。新能力必须拆成小模块。 |

### 1.2 线格式现状（决定设计边界）

- 发送：`api.turn(input, session, mode, attachments?)`（`apps/web/src/api.ts:207-211`），请求体见 `types.ts:389-423`；**无 context/quote 字段**。
- 历史：`HistoryMsg`（`types/history.ts:17-50`）只有 `content?: string` + 可选 `attachments?: AttachmentRef[]`（图片元数据）；`user` 消息 `content` 是纯文本，历史渲染走 `addUserMessage(...)` 的 `body.textContent`（`ui/messages/user.ts:51`、`ui/restore.ts:183-185`）。
- 工具结果：`ToolResultPayload.value` 里 `read_image` 的图片走 `attachments`（`ui/attachments.ts:409-435`）；`read_file` 是文本，进 `.tool-out`。
- 工具面：`read_file / write_file / list_dir / run_shell / run_code / …`（`packages/tools/src/index.ts:27-29`）；`read_file` 契约是 **UTF-8 文本专用**（`docs/feature-multimodal-attachments.md:43-48`）。
- **结论**：P0 选段必须序列化进 `input` 文本；P0 文件预览只能吃「会话内已出现的文本/附件」。

### 1.3 需要新建

| 缺口 | 建议落点（≤400 行/模块） |
| --- | --- |
| 选区监听 + 浮标（`getSelection` 全仓当前 0 处使用，已 grep 确认） | `ui/quote/select.ts`（监听/判定/取文本与来源） |
| 引用数据模型 + 序列化/反序列化/转义/截断（纯函数，零 DOM） | `ui/quote/model.ts` |
| 引用 chip 待发区（可复用 attach-tray 形态） | `ui/quote/tray.ts` 或并入 `attach-tray` |
| 历史回放解析引用块并渲染引用条 | `ui/messages/user.ts` 增引用渲染 + `ui/restore.ts` 解析 |
| 文件路径识别（消息 markdown 链接 / tool args.path / 行内反引号） | `ui/preview/detect.ts`（纯函数） |
| 预览面板容器 + 预览器分派 + 降级 | `ui/preview/panel.ts` + `ui/preview/renderers.ts` |
| 预览内容来源（P0：DOM 内文本；P1：`GET /api/fs/read`） | P0 `ui/preview/source.ts`；P1 需后端契约 |
| 引用/预览的样式 | `styles/quote.css`、`styles/preview.css` |

---

## 2. 同类做法对比

### 2.1 对比表（闭源产品 + 开源项目）

闭源产品部分来自本轮联网调研（来源见 §6）；开源项目 stars/license 用 shields.io 与仓库 LICENSE 文件实测（stars 为约数，以仓库页为准）。

| 产品 / 项目 | stars（约） | 许可证 | 关键交互 | 引用/上下文编码 | 侧边/内联预览 | 可借鉴点 |
| --- | --- | --- | --- | --- | --- | --- |
| ChatGPT (web) | — | 闭源 | 选中 → 浮动「引用」图标 → 进输入框 | 快照文本 + `>` 引用块；无回链 | — | 单手势「选中→引用→输入框」 |
| Claude Code (VS Code) | — | 闭源 | 选中 → `Option/Alt+K`；`@` 补全 | `@file.ts#5-10`（发送时解析） | 内联 diff / plan 文档 | `path#start-end` 紧凑锚点 |
| Claude 桌面端 | — | 闭源 | 「Attach selection as context」 | `>` 快照行 | 并排 diff | 选区直接进 composer |
| Cursor | — | 闭源 | 选中 → `Cmd+Shift+L`/`Cmd+L`；`@` 补全 | `@file`；**复制=活引用 / 复制为文本=快照** | 内联编辑 / diff | 「引用 vs 快照」显式二选一 + 上下文计量环 |
| Zed | — | 闭源 | 选中 → `ctrl-enter`；`@` | 选区范围 + 文件；临时片段 | 内联替换 | 临时自动片段：下次选择即替换、每轮清空 |
| VS Code | — | 闭源 | `Alt+F12` peek；`Ctrl+Alt+Click` 开侧边 | 符号范围 | 覆盖式 peek / 侧边 tab / 预览 tab | stable-peek、开侧边、临时预览 tab |
| Sourcegraph | — | 闭源 | hover 符号 → 跳转/引用 | 索引锚点（LSIF/SCIP） | 侧栏文件预览 | 锚点抗重排（索引而非文本匹配） |
| Obsidian | — | 闭源 | hover 内链弹预览（编辑态需 `Ctrl/Cmd`） | wikilink + 标题/块 | hover 浮层 | 「处处可 hover 预览 + 编辑态修饰键门控」 |
| Slack | — | 闭源 | 无原生引用：`>` 标记 / 复制消息链接 / 转发 | 消息时间戳 permalink | 线程父消息 | 每条消息稳定 permalink |
| Linear | — | 闭源 | hover 评论 → Reply | 评论 URL | 线程 | 评论级永久链接 |
| GitHub | — | 闭源 | 对话里选中按 `R`；`...` → Quote reply | `#L10-L20` + commit SHA | 渲染出的代码片段 | 范围锚点钉住版本；引用整条评论 |
| Lobe Chat（lobehub/lobehub，原 lobe-chat） | ~82.6k | LobeHub Community License（Apache-2.0 + 附加条款） | 选区浮标 `TextSelectionActionLayer`（portal pill，仅会话根内）→ 结构化 `ContextSelection` | `metadata.contextSelections`；发送时 `ContextSelectionsInjector` 注入 XML | `FileViewer` 模态（90vw×80vh）、`@` 本地文件 tag、`LocalFileLink` 行内文件 chip | **结构最完整**：`{id, content, format, lineRange, filePath, language, anchor}` + 按消息存 metadata |
| Open WebUI | ~152.5k | Open WebUI License（BSD-3 风格 + 品牌条款） | **当前 main 无「选段引用」**（chat 组件里 grep 不到 quote）；引用靠手写 `>` | 消息 `sources`/`citations`（RAG 编号 chip） | 真·侧栏 `FileNav/FilePreview.svelte`：code/md/image/PDF/docx/pptx/xlsx/json tree/notebook/sqlite/音视频 | 预览按 MIME 分派的完整清单；代码块自带复制/折叠/编辑/运行 |
| assistant-ui | ~12.2k | MIT | `SelectionToolbar`（portal，选区必须归属唯一消息）+ `ComposerQuotePreview` | `QuoteInfo {text, messageId}` 存 `metadata.custom.quote`；`injectQuoteContext()` 把每行转 `> line` 后前插（带去重守卫） | `file` 类型 message part（MIME 图标/名/大小/下载） | **特征（1）的最佳蓝图**：quote 是 metadata 里的一等 part，渲染/注入分离 |
| Vercel AI SDK | ~26.8k | Apache-2.0 | 不是 UI 功能；消息模型是 `UIMessage {parts[]}` | parts：`text`/`reasoning`/`tool-*`/`source-url`/`source-document`/`file`/`data-*` | `FileUIPart`；AI Elements `Sources`/`InlineCitation` | **parts 数组**作为消息数据模型；引用可映射 `data-quote`、预览 `file`、引用来源 `source-document` |
| Continue | ~36.0k | Apache-2.0 | tiptap `@` Mention → provider → `ContextItem`；`@Code`/`@Git Diff`/`@Current File` | provider 解析为活上下文 | 交互式 diff（Accept/Reject/Apply）；`CodeBlockPreview` | 可插拔 context provider 命名法 + 可交互 diff |

> 上表开源部分来自本轮对仓库源码/文档的核实（LICENSE 与 star 数实测；Lobe Chat 仓库已更名为 lobehub/lobehub）。
> **一个被证伪的前提**：Open WebUI **没有**「选中文本→引用」原语（其 chat 组件里不存在 quote），它做的是 **sources/citations + 文件预览侧栏**；引用靠手写 `>`。

### 2.1b 开源细节（仓库源码/文档核实）

- **Lobe Chat**：选区用 `TextSelectionActionLayer`（`createPortal` 的 pill，按选区 rect 定位，只在会话根内）；数据模型是本组最完整的 —— `ContextSelectionBase {id, content, format: markdown|text|xml, title?, preview?, lineRange?{startLine,endLine}}`，并有判别变体 `CodeContextSelection {filePath, language, side, workingDirectory}` 与 `PageContextSelection {pageId, anchor{startNodeId,startOffset,endNodeId,endOffset}, xml}`；按消息存 `metadata.contextSelections`，发送时 `ContextSelectionsInjector` 注入 `<user_context_selections count=N><context_selection source=… filePath=… lines="10-20">…</context_selection></user_context_selections>`。文件预览走 `createFilePreviewModal` + `FileViewer`；agent 改过的文件用 `EditedFilesCard` 汇总；markdown 的 `LocalFileLink` 插件渲染行内文件 chip。
- **Open WebUI**：**没有选段引用**；强项是 **sources/citations**（`Markdown/SourceToken.svelte`、`Messages/Citations.svelte` + `CitationModal`，编号行内 chip，存在 `message.sources`/`message.citations`）与 **文件侧栏**（`FileNav/FilePreview.svelte` 按 MIME 分派到 `FileCodeEditor`/`PdfPagesPreview`/`DocxPreview`/`PptxPreview`/`JsonTreeView`/`NotebookView`/`SqliteView` + panzoom/媒体）。代码块 `CodeBlock.svelte` 自带复制/折叠/编辑/运行/预览（mermaid/vega/svg）。
- **assistant-ui**：特征（1）的最佳蓝图，三件独立件 —— `MessagePrimitive.Quote`（消息带 quote 才渲染）、`SelectionToolbar`（portal，选区必须归属唯一消息）、`ComposerQuotePreview`；quote 存 metadata（`QuoteInfo {text, messageId}` → `metadata.custom.quote`），`injectQuoteContext(messages)` 把每行转 `> line` 前插为 text part，并**带重复注入守卫**。附件走 `AttachmentAdapter`/`AttachmentRuntime`；file part `{type:'file', filename, mimeType, data, sourceType:'url'|'id'|'base64'}`；source part `{type:'source', sourceType, id, url?, title, status}`。
- **Vercel AI SDK**：`UIMessage {id, role, metadata, parts[]}`；parts = `text`/`reasoning`/`tool-*`/`source-url {sourceId,url,title,providerMetadata}`/`source-document {sourceId,mediaType,title,filename,providerMetadata}`/`file {mediaType,filename,url}`/`data-*`/`step-start`。`convertToModelMessages()` 是边界，`data-*` 默认只给 UI（要显式映射才进模型）。→ 引用天然映射 `data-quote`，预览 URL 映射 `file`，引用来源映射 `source-document`。
- **Continue**：`@` 是 tiptap `Mention` 节点（Suggestion 插件、atom、`data-id/label/itemType/query`）；provider 把 query 解析成 `ContextItem {name, description, content}`（`CodeContextProvider` 返回索引片段、`DiffContextProvider` 返回 git diff 围栏）；高亮代码作为 context item 附加；diff 预览可交互（`ApplyActions` 的 Accept/Reject + `CodeBlockPreview`/`StyledMarkdownPreview`）。

### 2.2 提炼：交互范式

- **hover = 零提交预览**（VS Code peek、Sourcegraph、Obsidian）；**click / 快捷键 = 提交进上下文**（Cursor、Zed、Claude Code）。最强组合是「hover 检查 + 一个动作把检查对象提升进上下文」。
- 选中文本→引用通常是**一个手势**（浮动图标或一个快捷键），落到 **composer 上方的 chip/引用块**，不是直接改写正文。
- 编辑态需要**修饰键门控**（Obsidian），否则 hover 预览会干扰选区操作。
- 预览的落点有三档：**覆盖式 peek**（临时、Esc 关）、**侧边栏**（持久、可 pin）、**预览 tab**（不占正式 tab）。本项目的 rail 悬停卡≈覆盖式 peek；文件侧边预览应做成**侧边面板**。

### 2.3 提炼：数据模型（引用片段在消息里怎么表示）

| 方案 | 形态 | 优点 | 缺点 | 本仓适配 |
| --- | --- | --- | --- | --- |
| (a) 纯文本快照 | `> 选中的话` + 正文 | 零契约、老后端可用、历史可读 | 无来源、无法检测过期、重复占 token | ✅ P0 首选 |
| (b) 结构化 `{sourceId, range, snapshot, hash}` | 消息 part / 新字段 | 可回链、可判「内容已变」、可去重 | 要改 wire/history 契约、要前端渲染新 part | ⚠️ P1（需后端） |
| (c) Markdown 引用块 + 隐藏元数据 | `> …` + `<!-- quote:… -->` | 老后端可用 + 保留来源 | 注释会被 marked 丢弃/需自解析 | ✅ 折中（P0.5） |
| (d) 附件式 part | `attachments[]` 新 variant | 与图片同构、最干净 | 现有 attachments 是图片专用（魔数嗅探 + 尺寸），扩展要动 core/日志/契约 | ❌ P0 不推荐 |

**业界共识（推荐混合方案）**：像 Lobe Chat / assistant-ui 那样把引用存成**结构化 part/metadata**（`{id, sourceId, filePath?, lineRange?, snapshot, hash, format}`），**渲染**用专门组件，**发送时**再序列化成模型可读文本（assistant-ui 的 `> line`、Lobe 的 XML，本仓用 W869 定界块）。这样兼得快照（`snapshot` 保内容不变）与结构化（`hash`/来源可判过期、可去重、可回链）。

本项目落地：

- **存储**：`pendingQuotes`（按会话隔离）用结构化对象；**发送**时序列化进 `input` 文本（turn 只收文本）。
- **去重**：`sha256(snapshot)`（或 `(sourceId, hash)`）去重；chip 显示字节数。
- **过期**：来源仍在且 hash 不同 → 标「来源已更新」并提供「重新引用」（对齐 Cursor 的 ref vs text）。
- **计费**：chip 显示大小（未来可换算 token），对齐 Cursor 的上下文环与 Claude 的 context 指示器。
- **幂等**：注入只在发送那一刻做一次；流式过程中绝不重复注入（assistant-ui 的守卫先例）。

### 2.4 提炼：边缘情况

- **跨消息/多段引用**：ChatGPT、Claude 均长期被请求而缺失 ⇒ 本项目应一次支持「一轮多个引用片段」（列表 + 去重）。
- **代码块内/跨代码块引用**：ChatGPT macOS 版选区不能跨围栏代码块 ⇒ 取选区时要保留原始文本（含围栏），不要尝试智能合并。
- **被引用内容后来变了**：快照会过期。存 `hash` + 来源锚点；再次展示时若来源仍在且 hash 不同，标「来源已更新」并提供「重新引用」（对齐 Cursor 的 ref vs text）。
- **超长选段**：必须截断并如实标注（本仓已有 256KiB 文本附件上限先例 `text-attach.ts:14`）；建议选段上限 ~8KB 且 chip 显示「已截断」。
- **引用自身（composer）文本 / 输入框内选区**：必须排除，否则自我引用死循环。
- **运行中车道**：插话/排队只支持文字（`ui/send.ts:67-73`）⇒ 引用序列化进文本后天然可用；图片附件在运行中会被拦，引用不能被同样拦掉。
- **安全**：模型输出/工具结果不可信 ⇒ 渲染引用与预览一律 `sanitizeNodes`。
- **死链**：引用来源的消息被 clear/切换会话后，快照仍在（这是快照的优点）；锚点失效只影响回链，不影响内容。
- **流式重复注入**：若在流式过程中反复「注入引用」，每个 chunk 都会再插一遍（assistant-ui 专门有去重守卫）⇒ 引用只在**发送时**序列化一次，渲染态与发送态分离。
- **隐私/导出**：本地文件路径会随对话导出/分享泄露（Open WebUI 社区反复提）⇒ 引用 chip 与预览头只显示**基名**（或用户可选的相对路径），完整路径只在本地 tooltip。
- **无障碍/键盘**：浮动引用按钮必须可键盘触发（消息级「引用整条」按钮 + 快捷键），portal 的 z-index 按层级栈管理（`utils/overlays.ts`）。

---

## 3. 「选段提及」设计

### 3.1 交互

1. **选中**：在 `.sess-pane` 内的 `.content`（assistant markdown / user 文本）、`.tool-out`、`.think-seg-body` 上 `mouseup`/`selectionchange`。判定：`getSelection()` 非折叠、锚点与焦点都在同一消息节点内、且不在 `textarea/input` 内。
2. **浮标**：在选区 rect 上方弹一个小按钮「引用」（`anchor-popup.placeAnchoredPopup` 或 `panelGeom` 现算视口坐标 + `position:fixed`）。键盘可达：给消息气泡加「引用整条」按钮；`Ctrl/Cmd+Shift+Q` 引用当前选区。
3. **落地**：点击 → 文本快照进 `pendingQuotes`（按会话隔离），输入框上方出现 chip（复用 `attach-tray` 形态）：来源标签（`你 · 第 N 轮` / `Studio` / `工具 read_file`）+ 首行前 40 字 + 字符数 + 移除键。同一段重复引用按 hash 去重。
4. **发送**：`dispatchSend` 里在 `withTextAttachments` 之前/之后拼接引用块；发送失败时与附件一起回滚（`restorePending` 的兄弟 `restoreQuotes`）。
5. **历史回放**：`restore.ts` 渲染 user 消息前，用 `parseQuoteBlocks(content)` 拆出引用块 → 在气泡内先渲染 `.quote-block`（blockquote 样式，`styles/components.css:236-239` 已有），正文照旧 `textContent`。

### 3.2 数据模型

```ts
// ui/quote/model.ts（纯函数，零 DOM；≤400 行）
export interface QuoteSource {
  kind: 'user' | 'assistant' | 'tool' | 'inbox';
  session: string;
  turn?: number;          // 轮次（能取到就记）
  label: string;          // 展示用，如 'Studio · 第 3 轮'
  anchor?: string;        // 可选：消息在 DOM 里的稳定 id（未来回链用）
}
export interface QuoteRef {
  id: string;             // 会话内唯一（递增或 hash 前缀）
  source: QuoteSource;
  text: string;           // 快照正文（已截断）
  hash: string;           // sha256(text) 十六进制；去重 + 过期判定
  bytes: number;          // UTF-8 字节数（展示/限额）
  truncated: boolean;
  range?: { start: number; end: number }; // 可选：源文本内的字符偏移
  format?: 'text' | 'markdown' | 'code';   // 片段形态（代码引用可据此高亮）
  filePath?: string;                        // 代码引用：来源文件（可选，展示用基名）
  lineRange?: { startLine: number; endLine: number }; // 代码引用：行范围（可选）
}
export const QUOTE_BLOCK_DELIMITER = '===== W### 引用 ====='; // 全仓唯一 ASCII 字面量
export function serializeQuotes(text: string, quotes: readonly QuoteRef[]): string;
export function parseQuoteBlocks(content: string): { quotes: QuoteRef[]; rest: string };
export function escapeDelimiterLines(text: string): string;   // 同 text-attach.ts:123-129
export function capQuote(text: string, maxBytes: number): { text: string; truncated: boolean };
```

序列化形态（与 W869 文本附件同构，防边界伪造）：
```
===== W### 引用 =====
[引用 1 · 来源：Studio · 第 3 轮 · 128 字节]
> 第一行
> 第二行
===== W### 引用 =====
```
（正文里与定界行同形的行加后缀转义；解析时反向剥离。）

### 3.3 与现有 attachment / 消息格式的关系

- **不改 `attachments`**：它被图片专用链路（魔数嗅探、`ImageRef` 宽高、core `Content` 联合）绑死；把引用塞进去会波及 `packages/core`、会话日志编解码与契约，成本远大于收益（参考 `docs/feature-multimodal-attachments.md:25` 的「契约成本」段）。
- **与文本附件并列**：引用是「结构化的文本附件」——同一个注入点（`send.ts:105-107` 的 `withTextAttachments` 链），同一套定界/转义，只是块内多了来源行与 `>` 前缀。
- **历史格式零变更**：引用块就是 `content` 里的一段文本；老后端原样存、原样回，前端解析渲染。**不需要新增 history 字段**。
- **与 rail/预览卡的关系**：rail 预览卡是「轮次级」摘要；引用是「片段级」精确快照，两者互补、不冲突。

### 3.4 第一个可交付切片（P0，零后端改动）

1. 新建 `ui/quote/model.ts`：`QuoteRef`、序列化/解析/转义/截断/去重（纯函数 + 单测）。
2. 新建 `ui/quote/select.ts`：监听 `.sess-pane` 的 `mouseup`/`selectionchange`，浮标「引用」（复用 `panelGeom` 落位），排除 composer。
3. 新建 `ui/quote/tray.ts`（或并入 `attach-tray`）：输入框上方引用 chip（复用 `renderTray` 形态），按会话隔离、可移除。
4. 接线 `ui/send.ts`：`serializeQuotes` 注入；失败回滚；运行中车道同样可用。
5. 接线 `ui/restore.ts` + `ui/messages/user.ts`：解析并渲染 `.quote-block`。
6. 样式 `styles/quote.css`（引用块 + chip），沿用既有 token。
7. 测试：纯函数（转义/解析/截断/去重）、jsdom 交互（选中→chip→发送文本含块→历史解析回渲染）、以及「不注入 composer 自身选区」的负例。

验收口径：发送后模型确实看到引用文本；刷新后引用块仍可见；不违反 8 条铁律。

---

## 4. 「文件侧边弹出预览」设计

### 4.1 触发方式（三档，从零风险到需后端）

| 档 | 触发 | 数据来源 | 是否需后端 |
| --- | --- | --- | --- |
| A（P0） | 工具卡上的「预览」按钮（`read_file`/`write_file`/`list_dir` 结果），或点击消息里的文件路径 token | 已在 DOM 的 `.tool-out` / 消息文本 | 否 |
| B（P0.5） | hover 文件路径 token → 弹轻量浮卡（前 N 行） | 同上 | 否 |
| C（P1） | 任意工作区路径 → 侧边面板读全文 | 新端点 `GET /api/fs/read?path=`（或复用 `run_code`？不推荐） | **是** |

触发识别（`ui/preview/detect.ts` 纯函数）：
- 工具事件：`tool.name` ∈ {`read_file`,`write_file`,`list_dir`} 且 `args.path` 是绝对/工作区相对路径（`ui/toolcards.ts:215-227` 已有 args 全文）。
- 消息文本：markdown 链接 `[名](路径)`、行内反引号包裹的路径（`/…`、`./…`、`a/b.ts`）、以及「文件：xxx」句式（需收窄，避免误报）。
- 附件：图片已是预览（`attachment-view.ts`），无需新做。

### 4.2 预览器种类与降级

| 类型 | 判定 | 渲染 | 降级 |
| --- | --- | --- | --- |
| 代码 | 扩展名在 `TEXT_FILE_EXTS`（`text-attach.ts:18-24`）或语言可识别 | `renderHtmlSafe` + `highlightCode`（`hljs.ts:91`），等宽 `pre` | 高亮失败 → 纯文本 `pre` |
| Markdown | `.md/.markdown/.mdx` | `renderMarkdownSafe`（`sanitize.ts:396`） | 渲染异常 → 纯文本 |
| 图片 | `looksLikeImage`（`attachment-view.ts:111-113`） | `openLightbox`（`:140`）或内联 `<img>`（objectURL/attachment URL） | 无字节回读 → 「仅元数据」占位（现状 `attachments.ts:409-435`） |
| diff | 文件名 `.diff/.patch` 或内容以 `@@`/`---` 开头 | P0：纯文本 `pre` + 行级 CSS 着色（`+`/`-`）；**无现成 diff 库** | 不做逐行对齐，明说「原始 diff」 |
| 其他/二进制 | `readTextFile` 判二进制（`text-attach.ts:66-74`）或超 256KiB | 不渲染内容 | 「二进制/过大，无法预览」+「复制路径」+「在文件管理器中打开」(`openFsBrowser`) |

### 4.3 与现有 rail / anchor-popup 的关系

- **rail**（`ui/rail.ts`）是 #main 左侧留白带的**轮次级 hover 预览**（选择条 + 悬停卡）；文件侧边预览是**片段级、持久、可 pin 的面板**，语义不同，应是**独立容器**，但复用其几何先例（绝对定位于 #main、留白不足隐藏，见 `worker-strip.ts` 顶注）。
- **anchor-popup**（`ui/anchor-popup.ts:68-75`）是**落位适配器**：B 档 hover 浮卡、A 档的按钮浮层都复用它；C 档侧边面板不需要贴锚点，可用固定侧栏几何。
- **hint 注册缝**：B 档 hover 预览可注册成 `HintPlugin`（priority 高于内置纯文本卡），内容由 `ui/preview/renderers.ts` 给，落位/撤卡归引擎——与 rail 富卡片同构。
- **overlays**：A/C 档面板 `pushOverlay(close)`，Esc 只关它一层；与设置页/弹窗共存不打架。
- **布局选择**：P0 用**覆盖式右栏浮层**（`position:fixed` 或 #main 内 absolute，不动 #layout），零背景重排（铁律 5）；若未来要真·第三栏，再动 `#layout` 与 `#sidebarResizer`（成本高，不建议 P0）。

### 4.4 第一个可交付切片（P0，零后端改动）

1. 新建 `ui/preview/detect.ts`：从 tool 事件/消息文本提取「候选文件」（纯函数 + 单测）。
2. 新建 `ui/preview/panel.ts`：右侧覆盖式面板（离屏构建 + 单次 `replaceChildren`；`seq` 竞态守卫；`pushOverlay` 关栈）。
3. 新建 `ui/preview/renderers.ts`：按类型分派 code/markdown/image/diff/降级；内容一律 `sanitizeNodes` + `highlightCode`。
4. `ui/toolcards.ts` 给 `read_file` 结果加「预览」按钮（不改卡片既有几何与折叠逻辑）。
5. 样式 `styles/preview.css`。
6. 测试：detect 纯函数、面板开关不重建背景、竞态丢弃、二进制/超大降级文案、Esc 层级。

**明确不做（P0）**：新增 `GET /api/fs/read`、真·第三栏布局、逐行 diff 算法。任意路径预览列 P1，需要后端契约 + golden + 文档。

---

## 5. 反模式清单

1. **不要 `innerHTML` 引用/预览内容**：模型输出与工具结果是不可信输入，必须 `sanitizeNodes`（`utils/sanitize.ts:374`）。
2. **不要把引用存成活 DOM 引用**：会话切换是整批节点搬家（`ui/rail.ts` 的多会话机制、`ui/viewctx.ts` 的 hidden 切换），存元素会跨会话串味；存文本快照 + hash + 来源标签。
3. **不要用字符串拼接序列化引用而不定界/转义**：正文可伪造边界（W869 用唯一定界行 + 同形行转义解决，`text-attach.ts:121-129`）；照抄。
4. **不要把引用塞进 `attachments`**：那是图片专用线（魔数 + 宽高 + core `Content`），会引发跨层契约变更。
5. **不要依赖不存在的「context/quote」入参**：`POST /api/turn` 只有 `input` + `attachments`（`api.ts:207-211`）；引用必须进文本。
6. **不要在 composer 自身的选区上弹引用**：会自我引用；判定选区必须在 `.sess-pane` 的消息节点内。
7. **不要 hover 即发请求/即重建面板**：hover 只读 DOM；需要时加修饰键门控（Obsidian 做法），请求要 debounce + 缓存。
8. **不要「先清空面板再加载」**：违反铁律 1（`apps/web/FRONTEND-RULES.md:8-11`）；离屏构建 + 单次替换。
9. **不要不加竞态守卫**：快速切换文件/会话时晚到结果会覆盖新状态（铁律 3，`FRONTEND-RULES.md:18-21`）。
10. **不要用「加载中…」占位整区替换**：允许轻量指示（顶部细进度条/状态栏），不允许空白帧（`FRONTEND-RULES.md:42-48`）。
11. **不要静默重复引用同一段**：按 hash 去重；chip 上显示大小，避免 token 无声膨胀（对齐 Cursor 上下文环 / Claude context 指示器）。
12. **不要为预览新开端点而不走契约流程**：新端点要改 `contracts/endpoints.json`、`API_ENDPOINT_COUNT`、golden，并显式评审；本轮不做。
13. **不要相信扩展名判类型**：内容嗅探优先（`readTextFile` 的 NUL/C0 判定），扩展名只作初筛。
14. **不要破坏 rail/worker-strip 的留白带**：新增侧边元素要沿用「留白不足隐藏、指针穿透空白」的既有约定，别压在正文上。
15. **不要把新能力塞进已登记的超大模块**：模块体积棘轮只许降（`module-size-baseline.json`），新代码拆到新模块（≤400 行）。

---

## 6. 来源链接

**闭源产品（本轮联网调研）**
- ChatGPT 引用：https://community.openai.com/t/quoting-feature-in-macos-app/763816 ；原生引用诉求 https://community.openai.com/t/add-native-message-quoting-in-chatgpt/1381628
- Claude Code VS Code：https://code.claude.com/docs/en/vs-code ；引用 UI 诉求 https://github.com/anthropics/claude-code/issues/26716 ；重复插入 bug https://github.com/anthropics/claude-code/issues/60035 ；Citations API https://platform.claude.com/docs/en/build-with-claude/citations
- Cursor：https://cursor.com/docs/reference/keyboard-shortcuts ；https://cursor.com/docs/agent/prompting ；https://cursor.com/help/ai-features/inline-edit ；上下文 https://cursor.com/help/customization/context
- Zed：https://zed.dev/docs/ai/inline-assistant ；https://zed.dev/docs/ai/agent-panel ；自动上下文 https://github.com/zed-industries/zed/discussions/51107
- VS Code：https://code.visualstudio.com/docs/editing/editingevolved
- Sourcegraph：https://sourcegraph.com/changelog/deep-search-code-navigation ；https://sourcegraph.com/blog/code-navigation-in-github-pull-requests
- Obsidian：https://obsidian.md/help/plugins/page-preview
- Slack：https://slack.com/help/articles/360039953113-Format-your-messages-in-Slack-with-markup ；https://zapier.com/blog/slack-quote-message-in-reply/
- Linear：https://linear.app/docs/comment-on-issues
- GitHub：https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet ；https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax ；Copilot code referencing https://docs.github.com/en/copilot/concepts/completions/code-referencing

**开源项目**
- Lobe Chat（仓库已更名 lobehub/lobehub）：https://github.com/lobehub/lobehub （stars ~82.6k；LobeHub Community License，LICENSE 实测）；`ContextSelection` 类型 https://github.com/lobehub/lobe-chat/blob/main/packages/types/src/message/common/contextSelection.ts ；XML 注入 https://github.com/lobehub/lobe-chat/blob/main/packages/prompts/src/agents/contextSelectionContext.ts
- Open WebUI：https://github.com/open-webui/open-webui （stars ~152.5k；Open WebUI License，LICENSE 实测）；文件侧栏 `FileNav/FilePreview.svelte`、引用 `Messages/Citations.svelte`；https://docs.openwebui.com
- assistant-ui：https://github.com/assistant-ui/assistant-ui （stars ~12.2k；MIT）；`QuoteInfo` https://github.com/assistant-ui/assistant-ui/blob/main/packages/core/src/types/quote.ts ；`injectQuoteContext` https://github.com/assistant-ui/assistant-ui/blob/main/packages/ai-sdk/src/model-context/injectQuoteContext.ts ；https://www.assistant-ui.com/elements/quote.md ；https://www.assistant-ui.com/elements/sources.md
- Continue：https://github.com/continuedev/continue （stars ~36.0k；Apache-2.0）；`core/context/providers/{Code,Diff}ContextProvider.ts`、`gui/.../extensions/Mention.ts`；https://docs.continue.dev/
- Vercel AI SDK：https://github.com/vercel/ai （stars ~26.8k；Apache-2.0）；`UIMessage` parts https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message.md ；Sources 组件 https://elements.ai-sdk.dev/components/sources ；RAG + citations 指南 https://vercel.com/kb/guide/building-ai-chat-app-with-rag-and-citations-on-vercel

**本仓代码/文档（file:line 见正文）**
- `apps/web/src/ui/text-attach.ts`、`ui/attachments.ts`、`ui/send.ts`、`ui/inputbar.ts`、`ui/attach-tray.ts`、`ui/attachment-view.ts`、`ui/toolcards.ts`、`ui/rail.ts`、`ui/rail-card.ts`、`ui/rail-doc.ts`、`ui/fsbrowser.ts`、`ui/worker-strip.ts`、`ui/anchor-popup.ts`、`ui/hint/*`、`ui/messages.ts`、`ui/messages/*`、`ui/restore.ts`、`ui/viewctx.ts`、`utils/markdown.ts`、`utils/sanitize.ts`、`utils/hljs.ts`、`utils/overlays.ts`、`types.ts`、`types/history.ts`、`api.ts`
- `apps/web/FRONTEND-RULES.md`（8 条铁律）、`docs/pitfalls.md` P9、`docs/feature-multimodal-attachments.md`（W869 文本附件先例）
- `packages/tools/src/index.ts`（工具清单）、`apps/web/tools/module-size-baseline.json`（模块体积棘轮）

**开源「宝藏」库（形态参考；本仓无 React/框架，实际优先原生 DOM + 已有 hljs/marked，不新增依赖）**

- 选区/浮层：tiptap（~38.4k, MIT）、floating-ui（~32.8k, MIT）
- 代码/差异：monaco-editor（~46.8k, MIT）、shiki（~13.8k, MIT）、jsdiff（~9.2k, BSD-3）、react-diff-view（~1.0k, MIT）、diff2html（~3.4k, MIT）
- markdown/媒体/图：react-markdown（~15.9k, MIT）、react-pdf（~11.2k, MIT）、mermaid（~90.3k, MIT）、codehike（~5.4k, MIT）

---

## 附：待用户裁决的开放问题

1. 选段提及的 P0 是否接受「序列化进消息文本」（历史里以引用块呈现、无独立 context 字段）？
2. 文件侧边预览是否接受「P0 只预览会话内已出现的文本/图片」，把任意工作区文件预览列为需要 `GET /api/fs/read` 的 P1？
3. 侧边预览做成「覆盖式右栏浮层」（零布局改动）还是「真·第三栏」（动 #layout / 拖宽条）？
4. 引用是否需要「内容已变」检测（存 hash + 来源锚点），还是 P0 只做纯快照？
