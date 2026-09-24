# 多模态附件（用户上传图片/文件 + 模型侧 `read_image`）调研与设计

| 项 | 值 |
| --- | --- |
| 任务 | W801（多模态附件链路：设计，不实现） |
| 工作区 | 本仓（见 [`../../README.md`](../../README.md)） |
| 日期 | 2026-09-16 |
| 状态 | **已实现（P0）**。本文件是设计依据与验收标准的记录；落地见 `apps/web/src/ui/attachments.ts`、`packages/core/src/attachments.ts`。本表写于 W801（当时只做调研），功能已随 W805 落地。 |
| 上游实例 | `http://127.0.0.1:3001/v1`（newapi 网关，provider id=`celestea`） |
| 参考实现 | DSH `/opt/dsh-src-015`、`/opt/dsh-src-013`（`/opt/dsh/profiles/web` 对 worker 不可读：`Permission denied`，已避开） |

> 本轮边界：只写本文件与 worker 报告；不动生产 3777 的会话；不新增依赖；不重启服务；探针只读；临时脚本已删除。
> 凡未经本机实测的结论一律标注 **待验证**。

---

## 0. 结论摘要（TL;DR）

1. **图片当前确实没有任何入口**：11 个工具无 `read_image`；`Content` 联合无 image 变体；`POST /api/turn` 只收 `input: string`；wire 层 `content` 是纯字符串；前端没有 file input / 拖拽 / 粘贴。四层都要动，但**真正的冻结契约只有 `Content`（core）与 session 事件行**两处。
2. **上游视觉能力是「按模型」而非「按 provider」**：实测 6 个 `celestea` 模型中 **4 个有视觉**（`glm-5.3-flash`、`deepseek-flash`、`deepseek-v4-pro`、`deepseek-v4.1-flash`），**2 个明确拒绝**（`deepseek-v4-flash-0731`、`deepseek-v4-flash`）。因此**必须有逐模型能力位**，不能假设「provider 支持视觉」。该实测只作**事实证据**：设计上采用「乐观默认 + 可配置」，**不由代码硬判**某个模型有没有视觉（见 §7）。
3. **线格式**：OpenAI 风格 `content: [{type:"text"},{type:"image_url",image_url:{url:"data:image/png;base64,…"}}]` 被 4 个视觉模型**全部接受并正确识图**（实测）。file id / Files API 本轮**不推荐**（见 §3）。
4. **一个关键坑**：把图片放在 `role:"tool"` 的 content 数组里，`deepseek-v4-pro` **HTTP 200 但静默忽略图片**（回 `NO_IMAGE`）。因此 `read_image` 的工具结果图片**必须在 wire 层改走 `user` 角色消息**（实测 3/3 视觉模型可用），不能依赖 tool-role 多模态。
5. **存储**：建议 `<workspace>/<session-dir>/attachments/<sha256>.<ext>`。会话目录整体被 `.celestea-trash` / `.celestea-archived` `rename` 搬走，附件天然跟随，无需额外 GC 逻辑。
6. **红线**：`scripts/export-golden.ts` 的脱敏器目前只处理文本与已知 secret；附件字节**绝不允许**进入 `fixtures/`（见 §5.6）。
7. **契约成本**：`Content` 加 `ImageContent` 会波及 **24 个非测试文件 / 40+ 处**（含 contracts 与脚本另计）（§4 逐处列出）；`contracts` 需改 4 个文件；CSS/前端另计。**端点成本：P0 零新端点，`API_ENDPOINT_COUNT` 保持 51 不变**（`POST /api/turn` body 内联 base64；见 §7）。

---

## 分册导航

| 分册 | 章节 |
| --- | --- |
| 本文件 | §0 结论摘要、§9 分期建议与开放问题、§10 参考实现（DSH）借鉴 |
| [`01-evidence.md`](./01-evidence.md) | §1 现状证据、§2 上游视觉能力实测 |
| [`02-design.md`](./02-design.md) | §3 线格式定稿、§4 内容模型改动面、§5 存储设计、§6 `read_image` 工具设计 |
| [`03-frontend.md`](./03-frontend.md) | §7 能力位与端点成本、§8 前端设计 |
| [`04-appendix.md`](./04-appendix.md) | §11 附录：复现命令与证据 |

> 章节编号沿用原文（分册之间引用「§3.2」仍指同一节）；拆分为满足 `docs` 单篇 ≤ 700 行的硬上限。

---

## 9. 分期建议（P0 / P1 / P2）+ 风险 + 需用户裁决的开放问题

### 9.1 P0 —— 最小可用闭环（用户上传看图 + `read_image` 看图）

| # | 内容 | 触及文件（概览） |
| --- | --- | --- |
| P0-1 | `Content` 加 `ImageContent` + `ImageRef` + helper + 构造器 | `packages/core/src/message.ts` |
| P0-2 | session 事件 `user_message.attachments`（校验 + **显式序列化分支** + round-trip 测试） | `packages/core/src/session-event.ts`、`contracts/session-event.schema.json` |
| P0-3 | `deriveMessagesFrom` 把附件引用投影成 image 块 | `packages/core/src/projection.ts` |
| P0-4 | wire：user 图片走 content 数组；tool 图片**拆成 user 消息** | `packages/llm/src/{wire.ts,seam.ts}` |
| P0-5 | `read_image` 工具（`path` \| `attachment_id`、魔数嗅探、尺寸、能力位 gate、明确拒绝文案） | `packages/tools/src/{tools/read-image.ts,builtin.ts}`、`contracts/tools.json` |
| P0-6 | 逐模型 `input_modalities` / `output_modalities`（乐观默认）+ `health.capabilities.multimodal` | `providers.schema.json`、`handlers/health.ts`、`store/providers.ts` |
| P0-7 | HTTP：`POST /api/turn` 可选内联 base64 附件（**零新端点，51 不变**） | `handlers/dialog.ts`、`endpoints.json`（只加请求字段）、`runtime-adapter.ts` |
| P0-8 | 前端三入口 + 乐观渲染 + 完整回滚 + 历史附件渲染 | `apps/web/src/ui/{inputbar.ts,messages/user.ts,toolcards.ts}`、`chat.ts`、`api.ts`、`state.ts`、CSS |
| P0-9 | 附件存储（内容寻址、原子写、去重、魔数嗅探） | 新 `packages/session/src/attachments/*` 或 `packages/runtime` |
| P0-10 | golden 红线：脱敏器扩展 + 禁止附件入 fixtures | `scripts/export-golden.ts`、`packages/core/src/redact.ts` |
| P0-11 | 逐处测试：`derive` 字节不变（无附件）、wire 拆分、serialize round-trip、契约计数 | 见 §4.5 |
| P0-12 | §7.6 上游 400「图像不支持」分类 + 一次降级重试 + 可见提示 | `packages/llm/src/{errors.ts,fallback.ts,stream.ts}`、前端 info 通道 |

P0 **明确不做**：图片规范化/降码、请求期二次缩放、Files API、跨会话去重、孤儿 GC、非图片文件附件、`run_code` 内 `read_image`、**附件上传/回读端点**。

### 9.2 P1 —— 质量与治理

1. **规范化/降采样**（引入 `sharp`）：EXIF 方向、去元数据、8-bit sRGB、质量阶梯（85/75/60）、`originalDimensions`。
2. **请求期像素预算**（逐模型）：`scale = min(1, sqrt(maxPixels/(w*h)))`，不放大；请求版本缓存。
3. **上传端点 + 附件字节回读端点**（51 → 52，仅当大图/历史回放成为问题时）：`POST /api/upload`（或 `POST /api/sessions/{id}/attachments`）+ 一个按 `attachment_id` 回读字节的 GET；`/api/turn` 改为只带 `attachment_id`。
4. **文本模型的历史占位符投影**：无视觉模型仍能消费带图历史（`[图片已省略：模型仅接受文本；attachment sha256:<id>]`），而不是硬失败（DSH 的 `projectImagesForTextModel` 语义）。
5. **工具卡片图片渲染** + lightbox + 失败重试。
6. **compact 占位符**细化（`transcriptLine` 的 image 分支）。

### 9.3 P2 —— 优化与扩展

1. DeepSeek/OpenAI **Files API**（`file_id` 复用、过期治理）——**待验证**网关是否支持。
2. **跨会话去重**（中央对象库 + 引用计数）与孤儿 GC（可逆、仅活跃会话）。
3. `run_code` SDK 内 `read_image`（需解决 `parent_id` 被 derive 跳过的问题）。
4. 感知哈希去重、PDF 等非图片文件附件、粘贴截图以外的录屏/GIF 动图治理。

### 9.4 风险登记

| # | 风险 | 严重度 | 缓解 |
| --- | --- | --- | --- |
| R1 | `serializeSessionEvent` 手写逐字段，漏加 `attachments` 分支 ⇒ `/compact` 重写时**静默丢附件** | **高** | 显式分支 + 「读→写→再读」字节对拍测试；`/compact` 前后断言附件引用数不变 |
| R2 | tool-role 图片被上游**静默丢弃**（`deepseek-v4-pro` 实测） | 中 | 定稿用 shape B（image 走 user 消息）；对每个视觉模型补一次「工具结果图片」实测 |
| R3 | 附件字节泄入 `fixtures/`（红线） | **高** | 脱敏器加 `data:image` 规则 + `assertClean`；导出器加硬拒绝；`redaction-audit.json` 留证 |
| R4 | 图像库依赖：P0 新增 `image-size`（纯 JS，风险低）；P1 若引入 `sharp` 则带原生二进制风险 | 低→中 | P0 已裁决用 `image-size`；`sharp` 留到 P1 评估并做可选降级 |
| R5 | P0 turn body 内联 base64 ⇒ 内存/超时/网关体积上限；且 P0 **无附件字节回读端点** ⇒ 历史只能显示元数据 | 中 | §5.3 上限 + JSON body 大小上限显式配置并测试；P1 加 `POST /api/upload` 与回读端点 |
| R6 | 会话目录不在 `CELESTEA_TOOL_ROOTS` ⇒ `read_image(path)` 对上传图失败 | 中 | `attachment_id` 入口绕开沙箱；文档写清两个入口的语义差异 |
| R7 | 网关别名（`deepseek-flash` → `deepseek-v4.1-flash`）使静态能力位**静默失效** | 中 | 乐观默认下由 §7.6 的 400 降级兜底；用户可把实际无视觉的模型配成 `["text"]` |
| R8 | 上下文 token 估算低估图片（`context-trim.ts`） | 中 | 加 image 估算分支 + 单测 |
| R9 | 前端 `createObjectURL` 泄漏 | 低 | 消息卸载/会话切换时 `revokeObjectURL`；加内存测试 |
| R10 | 并发任务（W798 全仓退役后端词汇清理 / W802 DSH 动态工具披露）导致的 `pnpm check` 红灯 | 低 | 本任务未改代码；若复现按协议登记 `git status --porcelain`（本轮**不跑** `pnpm check`，见 §11.4） |

### 9.5 开放问题（用户裁决后更新 2026-09-16）

**已裁决 / 已关闭**：

| 原 # | 问题 | 裁决 |
| --- | --- | --- |
| #1 | `input_modalities` 默认值 fail-closed 还是乐观 | ✅ **乐观默认 + 可配置**：缺省 `["text","image"]` / `["text"]`；某模型无视觉由**配置**关闭，代码不硬判（§7.1） |
| #2 | 图像解码依赖 | ✅ **P0 用 `image-size`**（纯 JS、读头部、无原生依赖）；P1 再评估 `sharp`（§6.5） |
| #3 | 上传方式 / 端点成本 | ✅ **P0 零新端点，`API_ENDPOINT_COUNT` 保持 51**：`POST /api/turn` 内联 base64；P1 才考虑上传端点（§7.4） |
| #4 | 基元 provider 是否授权读 key 探针 | ✅ **不需要**：乐观默认已覆盖；`providers.json` 明文 key 红线不破；§2.2 第 7 行保留为「待验证」事实证据，不再是阻塞项（§2.3） |
| #7 | 文本模型消费历史图片：硬拒绝 vs 占位符 | ✅ 倾向**占位符投影**（与 §7.6 的降级同源）；P1 落地 |

**仍需用户裁决**：

1. **附件目录位置**：会话内 `attachments/`（跟随 trash/archive，零额外生命周期，但不跨会话去重）还是中央对象库（去重好，但删除语义要改）？本设计倾向前者（§5.1）。
2. **范围**：非图片「文件附件」（PDF/文本/代码）是否在本功能范围内？本设计按「只做 PNG/JPEG/WebP/GIF」处理，文本类继续走 `read_file`。
3. **上限数值**：是否直接采用 DSH 的默认（20 MiB / 20 张 / 200 MiB / 64 MP / 8192 px / 2048² / 4 MiB）作为我们 P0 的自限（§5.3）？
4. **`read_image` 的访问面**：只允许「会话附件 + 沙箱 roots 内的路径」，还是也允许任意宿主可读路径（DSH 的 `/api/file` 路线）？后者更灵活但**扩大了模型可读面**（§6.1 / §6.7）。
5. **P0 的历史回放限制**：无回读端点时历史图片只能显示元数据，是否接受这一 P0 限制直到 P1（§7.4）？

---

## 10. 参考实现（DSH）借鉴与差异

来源：`/opt/dsh-src-015`（0.1.5-alpha.1）与 `/opt/dsh-src-013`（0.1.3-alpha.1），**只读**。`/opt/dsh/profiles/web` 对本 worker **不可读**（`Permission denied`），未使用。**两版图像链路逐字节一致**（子代理 diff 结论），下文引用 015 行号。

### 10.1 借鉴的「形状」（不搬运行时代价）

| 维度 | DSH 形状（证据） | 我们的取舍 |
| --- | --- | --- |
| 内容块 | `ImageBlock { type:"image"; attachment: ImageAttachmentRef }`（`packages/llm/llm/src/types.ts:65-75`）；附件引用不内联字节（`packages/attachment/attachment/src/types.ts:11-32`） | **完全采纳**（§4.1 的 `ImageContent` + `ImageRef`），字段名本地化 |
| wire | OpenAI 风格 `image_url.url = "data:<mime>;base64,…"`（`packages/llm/llm-deepseek/src/serialize.ts:157-160`）；`file_id` 走 Files API 失败才回落 base64（`adapter.ts:573-626`） | **P0 只做 data URL**；Files API 列 P2（§3.4） |
| 图片角色限制 | pi-ai 适配器**硬拒绝非 user 消息里的图片**（`llm-pi-ai/src/context.ts:37-47` `assertSupportedImageRoles`）；DeepSeek 同（`serialize.ts:109-126`） | **与我们的 §3.2 实测一致**（tool-role 图片不可靠）⇒ §3.3 的 wire 拆分有独立佐证 |
| `read_image` 返回值 | **结构化 JSON value（无字节）** + `output.render` 产出 `[text, ImageBlock]`（`packages/fs/tool-fs/src/read-image.ts:192-197,218-226,324-338`）；`presentationMeta` **刻意不复制**附件引用（`:228-236`） | **采纳「value 只带引用」**；但我们的日志就是 `value`，所以引用放 `value.attachments`（DSH 的 `message.content` 在这里不存在） |
| 能力 gate | 执行前 `assertImageCapableRoute()`：解析路由模型，要求 `inputModalities` 含 `image`，**未知即拒绝**（`read-image.ts:111-131`） | **刻意分歧**（用户裁决）：我们**乐观默认**（缺省=支持），只在**显式配置排除**时拒绝；上游猜错由 §7.6 的 400 降级兜底（§6.6） |
| 拒绝文案 | `Model "<m>" does not support image input.`（`api/session-controller/src/commands.ts:335-348`）；工具侧 `cannot read "..." as an image: model "..." does not declare image input; switch to an image-capable model to read images`（`read-image.ts:119-131`） | **采纳结构**（模型 id + 可执行建议），文案按项目中文风格定稿（§6.6） |
| 存储 | 中央对象库 `~/.dsh/attachments/v1/objects/<sha[0:2]>/<sha>`，硬链接发布 + `chmod 0400`（`packages/attachment/attachment-local/src/{index.ts:174, store.ts:51-54,350-388}`） | **改成每会话 `attachments/`**（§5.1）：我们的删除/归档是整目录 `rename`，中央库会与删除语义冲突 |
| 上限 | 20 MiB / 20 张 / 200 MiB / 64 MP / 8192 px / 2048² / 4 MiB（`attachment-local/src/index.ts:33-58`） | **作为候选默认**（§5.3），但标注是我们的自限、非上游实测 |
| 文本模型历史 | 把图片投影成占位文本 `[image omitted because this model accepts text only; attachment sha256:<digest>]`（`llm/llm/src/content.ts:75-77`, `index.ts:1048-1052`） | **P1 采纳**（§9.2 #4），避免「历史里有图就整轮失败」 |
| 前端入口 | 粘贴 `keymap.ts:130-149`；拖拽 `ComposerAttachments.tsx:31-80`；文件选择 `InputBar.tsx:496-515`；客户端**先**按 `imageLimits` 整批预校验（`InputBar.tsx:231-253`） | **采纳三入口 + 预校验**（§8.1） |
| 乐观 UI | 图片：`URL.createObjectURL` 立即预览 + **提交时同步本地回显**（`service.ts:228-296`，`beginSubmission` 在序列化之前）+ 成功时把 preview URL 交给持久缓存（`:543-572`）+ 失败时 drafts 保留可重试（`:468-483`）。**文件**（非图片）**才**有 `uploading` 占位（`:351-407`） | **采纳图片的部分**；我们对**图片也**不显示「上传中」——与用户口径一致 |
| 工具卡片 | `image-card-model.ts:113-240` 从**已落定**的 tool result 内容块取图 | **P1**（§9.2 #5） |

### 10.2 明确**不**照搬的部分

- **Files API 生命周期治理**（上传索引、过期、配额、陈旧重传）：我们上游是网关，代价不成比例（§3.4）。
- **中央对象库 + 请求版本缓存（variantId）**：P0/P1 不做；等 P1 有 `sharp` 且确有成本压力再评估。
- **pi-ai 双适配器**：我们 provider 的 `request_format` 目前只有 `chat_completions`，不需要第二套映射。
- **`output.render` / `presentationMeta` 双轨**：我们的工具结果模型只有 `value`（+`render`），不引入第三概念。

---

