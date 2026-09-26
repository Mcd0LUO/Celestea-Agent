# 多模态附件 · 设计定稿（§3–§6）

> 状态：**设计（已实现 P0）** ｜ 本册是 [`README.md`](./README.md) 的分册：线格式、内容模型改动面、存储设计、`read_image` 工具设计。
> 章节编号沿用原文；跨册引用（如「§7」）见分册导航。

---

## 3. 线格式定稿

### 3.1 决策（一句话）

> **我们发往上游的消息，图片一律表示为 OpenAI chat-completions 的内容块**：
> `content: [{"type":"text","text":"…"},{"type":"image_url","image_url":{"url":"data:image/<mime>;base64,<…>"}}]`，
> **且承载图片的消息角色是 `user`**。
> 会话日志里只存**附件引用**（`attachment_id` / sha256），**绝不存 base64 字节**；inline 字节是**请求期投影**，不是持久格式。

这条决策同时满足三个约束：（a）4 个视觉模型全部实测接受；（b）日志不被 base64 撑爆、golden 可脱敏；（c）上游仍是纯 OpenAI 兼容 `chat/completions`（`providers.schema.json` 的 `request_format` 枚举里 `chat_completions` 是当前两个 provider 的唯一取值）。

### 3.2 形状探测证据（决定「图片能放在哪」）

以下实验都在 §2 那 4 个视觉模型 + `deepseek-v4-flash`（文本模型，作负对照）上做：

| 形状 | 请求结构 | glm-5.3-flash | deepseek-flash | deepseek-v4-pro | deepseek-v4-flash（文本） |
| --- | --- | --- | --- | --- | --- |
| **A** | `role:"tool"`，`content:[{text},{image_url}]`，后跟 `user` 追问 | ✅ 正确识图 | ✅ 正确识图 | ❌ **HTTP 200 但回 `NO_IMAGE`（静默丢弃）** | 400 `unsupported content type image_url` |
| **B** | `role:"tool"` 纯文本 + **紧随其后的 `role:"user"` 带 image** | ✅ 正确识图 | ✅ 正确识图 | ✅ 正确识图 | 400 同上 |
| **C** | `role:"user"`，`image_url` 带 `detail:"high"` | ✅ | `finish_reason:"length"`（非拒绝） | ✅ | 400 同上 |
| **D** | 无前导 `user` 消息、`tool` 里塞图（`assistant.content:null`） | 未测 | 未测 | **HTTP 500** | 未测 |

形状 A 的 `deepseek-v4-pro` 结果**复现两次**（`NO_IMAGE`），形状 B 同模型同图正确识图，故不是随机性。形状 D 的 500 只出现在「消息序列以 assistant tool_call 开头」时，说明**网关对消息序列本身也有校验**；生产链路永远以 `user_message` 开头，D 不是真实场景，仅记录。

**A 的失败是静默的**：HTTP 200、`finish_reason:"stop"`、模型自己回 `NO_IMAGE`。这意味着**运行时无法自动判别**「图片被丢」还是「模型真没看见」，因此**不能**把 A 作为主投递形状。

### 3.3 定稿：两条投递规则

```
用户上传的图片   → 直接进该 user 消息的 content 数组（形状 B 的 user 半边）
read_image 结果  → wire 层拆成两条 wire message：
                     (1) role:"tool"   纯文本（含附件元数据 + 一句占位说明）
                     (2) role:"user"   content 数组带 image_url（紧随其后）
```

关键：**拆分只发生在 wire 层**（`packages/llm/src/wire.ts` 的 `buildRequestBody` / `mapMessage`），**不是**内容模型的一部分。内容模型里 `tool_result` 的 `Message` 仍然可以自然地带一个 image 块（见 §6），但**上游传输形状**由 wire 决定。这样：

- 内容模型 / 日志 / derive 保持「一条 tool_result → 一条 tool 消息」的现有不变量（§4 的 golden 破坏面因此可控）；
- provider 怪癖（A vs B）**只污染一个文件**；
- 将来某 provider 支持 tool-role 图片时，只改 wire 的一个分支。

### 3.4 为什么不选 file id / Files API / 远程 URL

| 方案 | 为什么不选（本轮） |
| --- | --- |
| OpenAI Files API + `file_id` 内容块 | 我们两个 provider 的 `request_format` 都是 `chat_completions`（3001 是 newapi 网关，不是 OpenAI 官方）；**没有实测证据**表明网关支持 `file_id` 内容块。**待验证**，列为 P2 候选。 |
| DeepSeek 官方 Files API | DSH 的 `deepseek-official` 适配器走这条（`/opt/dsh-src-015` 的 unified-image-request-pipeline 笔记），但那是**官方直连 + 带缓存/过期/配额治理**的一整套生命周期；本轮上游是网关，代价不成比例。**不在 P0/P1**。 |
| 远程 `http(s)` 图片 URL | 会让上游回源抓取：引入 SSRF 面、出口依赖、以及「图片是私有的」语义矛盾。**明确否掉**。 |
| 把 base64 直接写进 session 日志 | 日志体积爆炸 + golden 脱敏无法覆盖 + compact 复制粘贴；**红线禁止**（§5.6）。 |

### 3.5 线格式定稿（TypeScript 形状）

```ts
// packages/llm/src/wire.ts —— 新增
export interface WireTextPart   { type: "text"; text: string }
export interface WireImagePart  { type: "image_url"; image_url: { url: string } }
export type WireContentPart = WireTextPart | WireImagePart;

export interface WireMessage {
  role: string;
  content: string | WireContentPart[] | null;   // ← 由 string | null 放宽
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}
```

要点：
1. `content` 是**联合类型**，不是「永远数组」。纯文本消息继续发字符串 `"…"`（避免给所有历史消息引入数组形状、无谓地改变请求体）。
2. `data:` URL 的 MIME 必须与真实嗅探结果一致（见 §5.4）。
3. 图片块顺序：**文本在前、图片在后**（与实测一致）。
4. 一个 `user` 消息可带多张图（实测允许；上限见 §5.3）。

### 3.6 本节「待验证」清单

- 基元 provider 的线格式（未实测，§2.3）。
- `deepseek-v4-pro` 的 tool-role 图片在**其他消息组合**下是否有可用的变体（只测了 A/B/D）；不打算依赖。
- 单条 `user` 消息的图片数量上限、总 base64 体积上限（§5.3 定的是我们的自限，不是上游实测值）。**待验证**。

---

## 4. 内容模型改动面（动 core 冻结契约）

### 4.1 提议的内容模型

```ts
// packages/core/src/message.ts
export interface ImageContent {
  type: "image";
  content: ImageRef;
}
export interface ImageRef {
  /** 内容寻址 id：sha256(规范化后的字节) 的 hex。日志里只存这个。 */
  attachment_id: string;
  /** 规范化后的媒体类型（嗅探得出，不信任扩展名/客户端声明）。 */
  media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** 规范化后的像素尺寸（用于上游预算与 UI 占位）。 */
  width: number;
  height: number;
  /** 原始上传文件名，仅用于 UI 与模型可读标签；不参与寻址。 */
  name?: string;
  /** 原图被下采样/改码时记录原始尺寸（对齐 DSH 的 originalDimensions 语义）。 */
  original?: { width: number; height: number; bytes: number; media_type: string };
}

export type Content = TextContent | ToolCallContent | ImageContent;   // ← 唯一必改的一行
```

`ImageContent` 用 `type:"image"`、`content:ImageRef`，与现有 `{type, content}` 的 serde 风格一致（tag 在外、载荷在 `content`）。**注意**：`ImageRef` 是**引用**，不是字节；字节永远在附件存储里（§5）。

### 4.2 逐处改动清单（非测试代码，含 `file:line` 证据）

下列清单由 `packages/core/src/message.ts:45` 的联合类型出发，用穷举 grep 得到（§4.6 附命令与输出），不是凭印象列举。

#### A. `packages/core` —— 真正的冻结契约

| 文件:行 | 现状 | 必须怎么改 | 不改的后果 |
| --- | --- | --- | --- |
| `message.ts:34-43` | 只有 `TextContent` / `ToolCallContent` | 新增 `ImageContent` + `ImageRef` | 无处表达图片 |
| `message.ts:45` | `Content = Text \| ToolCall` | 加 `\| ImageContent` | 类型层面出现图片就编译失败 |
| `message.ts:100-106` | `isTextContent` / `isToolCallContent` | 加 `isImageContent` | 消费方只能手写 `c.type ==="image"` |
| `message.ts:63-85` | 5 个构造函数只产 text | 加 `userMessageWithImages` / `toolResultWithImages`（或让现有构造器可选收 parts） | 每个调用点手搓对象 |
| `message.ts:121-131` | `messageTexts` / `messageText` 只看 text | **语义确认**：继续只看 text（图片不是「文本」），但要在注释里写清 | 阅读者误以为图片会被当文本拼接 |
| `projection.ts:31-34` | import `userMessage` / `toolResultMessage` | 增加图片版构造器 import | — |
| `projection.ts:81-105` | `projectEvent`：`user_message`→`userMessage(event.text)`（`:84`）；`tool_result`→`toolResultMessage(event.id, toolResultText(...))`（`:89`）；switch 无 default | 两个分支必须把 `event.attachments` / `value.images` 解析成 `ImageContent` | **derive 后图片彻底消失，模型永远看不到** |
| `projection.ts:107-111` | `toolResultText` 把 `value` 序列化成 JSON 文本 | 需与图片共存：文本里保留元数据，图片走独立 content 块 | 要么丢元数据、要么丢图 |
| `projection.ts:129-155` | `balanceToolCalls` 造合成文本 tool 结果 | **无需改**（合成结果无图），但它的 cursor quirk 会与「tool 消息后跟 user 图片消息」交互，需补一条测试 | 对拍回归不可见 |

#### B. `packages/core/src/types.ts` —— Studio 投影与 SSE

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `types.ts:42-46` | `UserMessageEvent { type:"user_message"; text:string }` | 加 `attachments?: AttachmentRef[]` |
| `types.ts:62-74` | `ToolResultEvent { value; error }` | `value` 是 `unknown`，**类型不用改**；但契约要约定 `value.attachments`（见 §6） |
| `types.ts:121-133` | `UserMessageOut { role:"user"; content:string }` | 加可选 `attachments?: AttachmentRef[]`（Studio 投影要能渲染历史附件） |
| `types.ts:189-196` | `StudioMessage` 联合 | 若新增独立 `AttachmentMessageOut` 则并入；若内嵌则只改上面 |
| `types.ts:307-321` | `LoopEvent.tool_result` 带 `value:unknown` / `render:unknown` | 约定 `value.attachments`；`render` 可留给 UI 卡片 |

#### C. `packages/core/src/session-event.ts` —— JSONL 行编解码（**最容易漏**）

| 文件:行 | 现状 | 必须怎么改 | 不改的后果 |
| --- | --- | --- | --- |
| `session-event.ts:83-86` | `user_message/assistant_message/thinking_delta` 一律 `requireString(raw,"text")` | `user_message` 允许 `attachments`（可选数组），并做形状校验 | 带附件的行被当成非法 → **被判为 torn tail 截断** |
| `session-event.ts:133-177` | `normalizeSessionEvent` **没有** `user_message` 分支，落到 `:176 return raw as unknown as SessionEvent` | 显式加 `user_message` 分支，规范化 `attachments`（`null`→省略，字段白名单） | 额外字段现在**能存活**（靠 fallthrough），但一旦加分支就退化成丢弃 |
| `session-event.ts:230-272` | `serializeSessionEvent` 的 `user_message/assistant_message/thinking_delta` 共用 `:240-244` 只写 `text` | `user_message` **必须单独分支**写出 `attachments`（`parent_id` 式：None 省略） | **`/compact` 原子重写日志时把附件全丢掉**（静默数据丢失） |
| `session-event.ts:251-256` | tool_result 写 `id/value/error/(parent_id)` | `value` 已是 `serdeJsonString`，attachments 作为 `value` 内字段自动保留——**但要有 round-trip 测试** | 序列化顺序变化会破坏对拍 |

> **加粗警告**：`serializeSessionEvent` 是**逐字段手写**的（不是通用 JSON 序列化）。任何新字段**不显式添加就会在重写时无声消失**。这是本次改动里风险最高的一处，必须有「读→写→再读」字节对拍测试。

#### D. `packages/session` —— 投影与文件级回放

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `session/src/messages.ts:21-78` | `sessionEventToMessage`：`user_message`→`{role:"user",content:ev.text}`（`:26-27`）；`tool_result`→`tool_value`（`:43-53`） | `user_message` 带上 `attachments`（Studio 投影）；tool_result 的 value 原样带（已自动保留） |
| `session/src/messages.ts:81-88` | `projectMessages` 逐事件 | 无需改，但 golden 会变（附件字段出现） |
| `session/src/log/derive.ts:13-19` | 纯 re-export | **无需改**（算法在 core） |
| `session/src/jsonl.ts:54-79` | `parseSessionJsonl` 走 `parseSessionEvent` | 无需改（继承 core 的校验改动） |
| `session/src/log/file.ts:70-105` | `replayFile` 最长有效前缀 | 无需改；但「带附件行被误判非法」会把日志从该行起截断 → 依赖 C 的正确性 |
| `session/src/log/persistent.ts:127-144` | `append` 落盘 | 无需改（`value` 自动带） |
| `session/src/parity.test.ts` / `log/derive.test.ts` | 与旧实现的字节对拍 | **会红**，需要按新契约更新（§4.5） |

#### E. `packages/llm` —— wire 映射

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `llm/src/seam.ts:114-119` | `collectMessageText` 静默丢弃非 text 块 | **保留**（它只答「文本是什么」）；新增 `collectMessageParts(content)` 产出 `WireContentPart[]`，并在注释里写明「切勿用它处理带图消息」 |
| `llm/src/wire.ts:29-34` | `WireMessage.content: string \| null` | 放宽为 `string \| WireContentPart[] \| null` |
| `llm/src/wire.ts:200` | `mapMessage` 四个 role 分支 | `user`：有图则产数组；`tool`：有图则**不在这里产**（交给 buildRequestBody 拆分）；`system`/`assistant` 保持纯文本 |
| `llm/src/wire.ts:110-130` | `buildRequestBody` 逐条 push `mapMessage` | 新增：单个 seam message 可能展开成 **2 条** wire message（tool 文本 + user 图片），并保持顺序 |
| `llm/src/index.ts:32-34` | 导出 `collectMessageText` 等 | 导出新 helper |
| `llm/src/stream.ts:82` | `doneMessage` 只产 text/tool_call | **不改**（本轮不处理「模型回图」；OpenAI chat 流式本就不回图） |

#### F. `packages/agent-loop` —— 上下文与事件

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `agent-loop/src/context-trim.ts:61` | `if isTextContent … else if isToolCallContent …` | **加 image 分支**：图片必须有 token 估算（例如按尺寸/固定值），否则上下文裁减**系统性低估**，可能把超窗请求发给上游 |
| `agent-loop/src/step.ts:43-44` | `messageTexts` / `messageToolCalls` | 无需改（图片不进 assistant 文本、也不是 tool_call） |
| `agent-loop/src/events.ts:58-59` | `messageTexts(message).join("")` | 无需改；但 `done` 事件的文本等于「可见文本」，图片不参与 |
| `agent-loop/src/loop.ts:313,327` | `session.append({type:"tool_result", value: output.value, …})` | 工具返回的 `value.attachments` 自动入日志；**不需要 loop 特判** |

#### G. `packages/runtime` —— compact

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `runtime/src/compact/transcript.ts:57-70` | `transcriptLine`：`user_message`→`【用户】${ev.text}`（`:60`）；`tool_result`→`serdeJsonString(ev.value)`（`:67`） | 附件必须渲染成**占位符**（如 `【图 1：image/png 1024x768】`），**绝不能**把 base64 塞进摘要输入 |
| `runtime/src/compact/transcript.ts:16-20` | 字符级裁剪常数 | 无需改 |

#### H. `apps/studio` —— HTTP 与适配器

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `handlers/dialog.ts:64-68` | 只读 `input` / `session` | 读可选 `attachments`（或先上传拿 id）；空文本 + 有附件必须**合法**（当前 `text === ""` 直接 400） |
| `handlers/dialog.ts:72-89` | `startTurn({input,session})` / `inject` | `TurnRequest` 加附件字段，两条路径都要传 |
| `runtime-adapter.ts:304-309` | `startTurn(req: TurnRequest)` / `inject(req)` | `TurnRequest` 定义加 `attachments?` |
| `real-runtime-adapter.ts:412,439` | 实现 `startTurn` / `inject` | 把附件转成 `SessionEvent.user_message` 的 `attachments` |
| `handlers/sessions.ts:105-115` | `GET /api/sessions/{id}/messages` | 返回体自动带 StudioMessage 的 `attachments`（依赖 §4.2B） |
| `runtime/context-snapshot.ts:33-35` | `renderContent`：`block.type==="text" ? … : callText(block.content)` | **必须加 image 分支**；否则 `callText` 会对 `ImageRef` 做错事（当前会把对象当 ToolCall 读 `.name/.args`→ 显示 `undefined`） |
| `runtime/context-snapshot.ts:100` | `firstCall` 找 tool_call | 无需改 |
| `runtime/offline-llm.ts:79,87` | `c.type==="text" ? c.content : ""`、token 估算 | 图片分支（至少不要算 0 长度导致上下文视图错误） |
| `store/sessions.ts:278` | `projectMessages(parseSessionJsonl(text).events)` | 无需改 |

#### I. `apps/web` —— 前端

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `web/src/api.ts:180-186` | `turn(input, session?, mode?)` 只发 `{input}` | 加 `attachments`（或先上传） |
| `web/src/ui/inputbar.ts` | 只有 textarea | 加 3 个入口（§8） |
| `web/src/ui/messages/user.ts:33-62` | `body.textContent = text` | 渲染附件块（缩略图/文件名 + 点击放大） |
| `web/src/chat.ts` | 发送/回滚 | 附件随消息一并乐观渲染与回滚 |
| `web/src/state.ts` / `types.ts` | 消息响应类型 | 加 `attachments` |
| `web/src/styles/*.css` | — | 新增附件样式 |

#### J. `contracts/` 与脚本（详见 §4.4）

| 文件 | 必须怎么改 |
| --- | --- |
| `contracts/session-event.schema.json:122-138` | `user_message` 加 `attachments`（`additionalProperties` 已是 `true`，schema 层向后兼容） |
| `contracts/session-event.schema.json:201-229` | `tool_result` 的 `value` 是 `{}`（任意），无需改；但 `projections.studioMapping`（`:333+`）要补附件说明 |
| `contracts/data-files/cli-main-jsonl.schema.json:13` | `$ref` 到 session-event.schema.json，**改一处即两处生效** |
| `contracts/tools.json` | 加第 12 个工具 `read_image`（`count: 11 → 12`） |
| `contracts/endpoints.json` | `post_turn.request.fields` 加 `attachments`；若新增端点则 `count` 与 `endpoints` 同步 |
| `contracts/route-table.snapshot.json:309` | `tsApiEndpoints` 与 `tsOnlyRoutes` 计数（若新增 TS-only 端点） |
| `contracts/data-files/index.json` | 若把附件目录登记为数据文件，加一条 |
| `scripts/export-golden.ts:70-90,185-196` | 脱敏器与导出白名单（§5.6） |

### 4.3 日志行形状（向后兼容分析）

提议的 `user_message` 行（**新增字段，可选**）：

```json
{"type":"user_message","text":"看下这张图","attachments":[{"attachment_id":"<sha256hex>","media_type":"image/png","width":1024,"height":768,"name":"shot.png"}]}
```

兼容性：

1. **老读新**：旧代码 `requireString(text)` 通过；`normalizeSessionEvent` 的 fallthrough 保留 `attachments`；旧 `projectMessages` 忽略它 → 只是**看不见图**，不报错。✅
2. **新读老**：`attachments` 缺省 → 行为与今天完全一致。✅
3. **schema**：`session-event.schema.json` 的每个变体都是 `additionalProperties: true`，加字段不破坏既有校验。✅
4. **唯一真风险**：新代码写出的行被**旧版本的 `serializeSessionEvent`** 重写（例如回滚部署后跑 `/compact`）会丢 `attachments`——但不会报错，只会少图。属可接受的降级，需在发布说明里写明。⚠️

`tool_result` 行：`value` 本就是任意 JSON，**零 schema 改动**；约定 `value.attachments = ImageRef[]`。

### 4.4 `contracts/` 改动清单（逐条）

1. `contracts/tools.json`：`count 11 → 12`，追加 `read_image` 定义（形状见 §6.2）；`sourceRef` 写 `docs/feature-multimodal-attachments/02-design.md#62`（新工具，非移植）。
2. `contracts/session-event.schema.json`：`user_message` 增 `attachments`（数组，items 引用新 `$defs/AttachmentRef`）；`$defs/ToolResult` 的 `value` 不动；`projections.studioMapping.user_message` 补 `attachments` 说明；`note` 记 `W801 adds attachments (9 → 9 event variants, additive field)`。
3. `contracts/data-files/cli-main-jsonl.schema.json`：无需改动（`$ref`）；可在 `notes` 补一句「附件字节不在此文件，见 `attachments/`」。
4. `contracts/data-files/index.json`：新增一行「`<session-dir>/attachments/` — 附件对象存储（非 JSON；内容寻址；不入 fixtures）」。
5. `contracts/endpoints.json`：`post_turn.request.fields` 加 `attachments`（optional）；如采纳 §7 的新端点，则 `count 51 → 53`、`endpoints` 加两条、`source.routeTable` 说明追加。
6. `contracts/route-table.snapshot.json`：`tsApiEndpoints` / `tsOnlyRoutes` 对应 +2（若新端点 TS-only）。

`packages/core/src/contracts/index.ts:128-130` 有**硬编码的 51 断言**，改 count 必须同步；`apps/studio/src/routes.ts:54` 的 `API_ENDPOINT_COUNT = 51` 同理。

### 4.5 golden fixtures / 对拍测试破坏面

**结论：不改 fixtures 内容的话，3 处测试会亮红；导出器重跑一次即可，代价以分钟计。**

| 测试 / 产物 | 为什么会红 | 代价 |
| --- | --- | --- |
| `tests/contracts.test.ts`（51 处硬断言，另 `:23-25,62,207,223-224,255-256,302-304,361-364,385-387`） | 工具数 11→12、端点数 51→53 | 机械改数字 + 快照重生成，**必须**与新 contract 同步 |
| `apps/studio/src/replay/replay.test.ts:52-53`（自写 golden） | `projectMessages` / `deriveMessages` 输出多了 `attachments` 字段 | 自动生成产物，重跑即更新 |
| `scripts/compare-replay.ts:98-102` | 与 `fixtures/sessions/*/{messages,derive-messages}-expected.json` 逐字节对拍 | **只有含附件的会话才会真正不同**；现有 fixture 都没有附件 → **理论上不变**。但 `StudioMessage.user` 若新增恒在字段（`attachments: []`）就会**全体变红**。**设计约束：可选字段必须「无则完全省略」（serde 风格），不得写 `null`/`[]`。** |
| `packages/session/src/parity.test.ts` | 与旧实现的字节对拍 | 新增字段的行需要新对拍向量；旧向量应不变（无附件） |
| `packages/core/src/message.test.ts:54` | `JSON.stringify(assistantText("hi"))` 精确字符串 | 构造器未改则不变；改了构造器签名会红 |
| `packages/core/src/session-log.test.ts:34-54` | 事件编解码精确形状 | 新增可选字段省略时不变 |
| `scripts/export-golden.ts:185-196` | 导出 `messages-expected` / `derive-messages-expected` | 若产物**真的**变化才需重跑导出器（需生产 studio 可达；P0 已禁止驱动真实 turn，导出走只读 HTTP） |

**「重新导出」代价评估**：`export-golden` 是只读 HTTP 抓取（`GET /api/sessions`、`GET /api/sessions/{id}/messages`、`GET /api/health` 等）+ 本地 `deriveMessages`，**不驱动 turn**（`scripts/export-golden.ts:185` 附近；`e2e-replay.ts:52` 明确 P0 禁止 POST /api/turn）。因此重跑**不污染生产日志**。当前 fixture 里没有任何真实图片，所以按「可选字段省略」设计，重导出**预期零字节差异**——这是本次设计的**验收门槛之一**。

**红线（§5.6）**：即使将来有会话带附件，导出器写入 `derive-messages-expected.json` 时也必须只写 `attachment_id`/`media_type`/尺寸，**绝不允许**写入 `data:` URL 或 base64；且**不得**把 `attachments/` 目录复制进 `fixtures/`。

### 4.6 不遗漏自查（grep 命令 + 结果）

```
# 联合类型的全部模式匹配点（非测试）
$ grep -rn 'type === "text"\|type === "tool_call"\|part.type\|c.type ===\|content.type ===' \
    packages apps --include=*.ts | grep -v \.test\. | grep -v node_modules
packages/core/src/projection.ts:45,98,101
packages/core/src/message.ts:101,105
packages/core/src/session-event.ts:134
packages/llm/src/seam.ts:116
packages/llm/src/wire.ts:72
apps/studio/src/runtime/offline-llm.ts:79,87
apps/studio/src/runtime/context-snapshot.ts:34,100
# （message.ts:101/105 是 helper 本身；projection.ts:98/101 是 event.type 的 switch，不是 Content 分支）

# helper 的全部调用点（非测试）
$ grep -rn 'isTextContent\|isToolCallContent\|messageTexts\|messageText(\|collectMessageText\|messageToolCalls\|hasToolCalls' \
    packages apps --include=*.ts | grep -v \.test\. | grep -v node_modules
packages/core/src/message.ts, packages/agent-loop/src/{step.ts:9,43-44, events.ts:19-20,58-59, context-trim.ts:31-32,56-57}
packages/llm/src/{seam.ts:114-119, wire.ts:17,60,62,66,70, index.ts:32,34}
```

结论：**`Content` 的穷举匹配点只有 6 个源文件**（`message.ts`、`projection.ts`、`seam.ts`、`wire.ts`、`context-trim.ts`、`context-snapshot.ts`），另有 `offline-llm.ts` 的内部一致性判断。**但** session 事件编解码（`session-event.ts`）与 wire 拆分（`wire.ts:110-130`）这两条**数据流咽喉**不在「匹配 Content」的 grep 里，必须单独盯——它们正是最容易被漏掉、且后果最严重的两处。

---

## 5. 存储设计

### 5.1 位置：每会话 `attachments/`

实测确认会话目录的物理布局是 **`<workspace>/<session-dir>/`**（例如 `<workspace>/<session-dir>/cli-main.jsonl`；`workspaces.json` 的 workspace 路径 + `session.schema.json` 的 sessionDir）。因此：

```
<workspace>/<session-dir>/
├── cli-main.jsonl
├── cli-main.jsonl.precompact
├── session.json
└── attachments/
    ├── <sha256hex>.png
    ├── <sha256hex>.jpg
    └── <sha256hex>.webp
```

理由：

1. **归档/删除天然正确**：`apps/studio/src/store/session-ops.ts:210` 把整个会话目录 `rename` 进 `<ws>/.celestea-trash/<name>-<ts>`，`sessions.ts:135` 归档同理进 `.celestea-archived/`。附件在会话目录**内部**，于是：移动 = 跟随，恢复 = 跟随，**不需要第二套生命周期**。
2. **删会话 = 附件一起进回收站**（可逆），不会留孤儿。
3. 与 `CELESTEA_SESSION_DIR=/var/lib/celestea-agent/sessions` 不冲突：该 env 只是默认根，实际会话目录在 workspace 下（实测）。

### 5.2 命名与去重

- **文件名**：`<sha256(规范化后的字节)>.{png|jpg|webp|gif}`。内容寻址 ⇒ 同图重复上传**只占一份**；同一会话内引用同一 id 两次也共享一份。
- **不跨会话共享**（P0）：跨会话去重需要中央对象库 + 引用计数，而会话删除是 `rename` 语义（想共享就得改删除逻辑）。**不划算**，列为 P2。
- **去重边界**：去重发生在「规范化之后」。两个字节不同但视觉相同的图不去重（不做感知哈希）。
- **原子写**：`写 .tmp → rename`（与 `providers.json` 的落盘风格一致），避免半写文件被 `read_image` 读到。

### 5.3 大小 / 像素上限（**我们的自限，非上游实测值 → 待验证**）

| 维度 | 建议上限 | 依据 / 备注 |
| --- | --- | --- |
| 单文件原始字节 | **20 MiB** | 与 DSH 的 `maxImageBytes` 默认一致（借鉴形状）；**我们自己的上游上限未实测** |
| 单文件解码像素 | **40 MP** | 防止解压炸弹（一张 200MP PNG 解出 ~800MB） |
| 单边像素 | **8192 px** | 同上；超过则拒绝或下采样 |
| 单条消息图片数 | **20** | 与 DSH 一致；**上游真实上限未测** → 待验证 |
| 单条消息原始字节合计 | **200 MiB** | 与 DSH 一致 |
| 规范化后单文件 | **4 MiB** | 入日志/请求的版本；超出走质量阶梯降码 |
| 规范化后总像素 | **2048×2048** | 参考 DSH 的 `normalizedImageMaxPixels`；**不放大**，只等比缩小 |
| 请求期像素预算 | 每模型可配（如 640k 总像素） | 对齐 DSH 的 `imagePixelBudget` 概念；**我们未测每个模型的真实预算** → P1 才做 |

**P0 简化决策（用户裁决 2026-09-16）**：只做「拒绝超限 + 原样存 PNG/JPEG/WebP（字节 ≤ 4MiB）」，**不做**质量阶梯降码与请求期二次缩放；格式/宽高由 **`image-size`** 只读头部取得（见 §6.5）。

### 5.4 MIME 嗅探（不认扩展名）

- **只看魔数**（magic bytes），**不信任** `Content-Type`、**不看**扩展名：PNG `89 50 4E 47`、JPEG `FF D8 FF`、WebP `RIFF....WEBP`、GIF `GIF87a/GIF89a`。
- 我们**建议与 DSH 相反的一半**：DSH 的 `read_image` 以扩展名作为「声明」，魔数不符就 fail-closed（要求改名）；本设计**直接以魔数为准**（扩展名仅用于展示），因为本项目 `read_file` 已有「嗅探优先」的先例（`packages/tools/src/fs/file-io.ts:37`），且用户上传的文件名不可信。**差异点**：磁盘上的 `read_image(path)` 若扩展名与魔数冲突，**不报错**，按魔数处理并在返回体里标注 `declared_extension_mismatch: true`。
- 非四种格式 → 明确拒绝（文案见 §6.6）。
- SVG **不在白名单**（可执行内容 / XXE 面），文本类「文件附件」由 `read_file` 承担，不进入多模态。

### 5.5 与沙箱 / 回收站 / 归档 / compact 的交互

| 机制 | 交互 | 设计结论 |
| --- | --- | --- |
| `CELESTEA_TOOL_ROOTS=/src/celestea_studio_ts:/src/celestea_harness:/tmp` | 会话目录可能**不在** roots 内（如 `/server-center/...`） | **`read_image(path=...)` 走 `read_file` 同一沙箱守卫**（越界拒绝）；**但 `attachment_id` 形式由宿主直接解析**，不经过沙箱——因为附件本来就是宿主自己写进会话目录的。两个入口并存（§6.1） |
| 上传落盘 | 上传请求由 studio 进程处理，写 `<session-dir>/attachments/`；该路径由会话 id 推导，**不接受客户端指定路径** | 无路径穿越面 |
| `.celestea-trash/` | 会话目录整体 `rename` | 附件跟随；回收站里的附件仍可被管理员手工恢复 |
| `.celestea-archived/` | 同上，可逆 | 归档会话的历史消息仍能渲染图片（读归档目录） |
| `/compact` | 重写 `cli-main.jsonl`，**不动** `attachments/` | compact 后附件引用仍在（`user_message.attachments` / `tool_result.value.attachments`）；**但摘要输入必须用占位符**（§4.2G） |
| 删除会话 | 先 `rename` 进 trash | 无孤儿；**P0 不做 GC**。若将来做，规则是「扫描会话日志引用的 id 集合，删除 `attachments/` 中未被引用的文件」——**只对活跃会话**、且**必须可逆** |
| compact 后引用消失 | 历史被压缩成摘要后，旧图片引用从日志消失 | 文件成为孤儿但**不自动删**（延迟 GC，P2） |

### 5.6 红线：golden 导出与脱敏

**现状**（`scripts/export-golden.ts`）：

- `:70-90` 每个写出的文本都过 `redactor.redact(text)` + `redactor.assertClean(redacted, relPath)`；脱敏 secret 来自 `collectKnownSecrets`（`packages/core/src/redact.ts:178-206`：providers.json 的 `api_key`、npmrc token、4 个 env key）。
- `:278-280` 有一条硬检查：`/api/providers` 响应里出现字符串 `"api_key"` 就**拒绝导出**。
- `:185-196` 导出 `cli-main.jsonl`、`messages-expected.json`、`derive-messages-expected.json`。

**红线要求（写进实现契约）**：

1. **附件字节永不进入 `fixtures/`**：导出器**只写** `ImageRef` 元数据，**不复制** `attachments/` 目录，**不写** `data:` URL / base64。
2. **脱敏器扩展**：`redact.ts` 增加一条规则——把任何 `data:image/...;base64,...` 整体替换为 `data:image/<mime>;base64,<redacted len=N>`，并在 `assertClean` 里把「导出文本中残留 base64 图片」判为**泄漏**。
3. **新增硬检查**（对齐 `:278` 的风格）：`cli-main.jsonl` 若含 `"type":"image"` 且同一行字节数 > 阈值（例如 64 KiB），或含 `data:image/`，**拒绝导出**。
4. **导出清单**：`fixtures/` 里**不得**出现 `attachments/` 路径。可在 `fixtures/index.json` 的 per-session `files` 里显式不列出。
5. **`redaction-audit.json`**（`fixtures/redaction-audit.json`）应新增一条「attachment-bytes-excluded」证据。

---

## 6. `read_image` 工具设计

### 6.1 参数

```json
{
  "type": "object",
  "properties": {
    "path":   { "type": "string", "description": "Filesystem path of the image to read (PNG/JPEG/WebP/GIF; format detected by content, not extension)." },
    "attachment_id": { "type": "string", "description": "Content-addressed id of an already-uploaded attachment (from a user message). Use instead of path." },
    "desc":   { "type": "string", "description": "Optional one-line label (max 80 chars) describing what this call is doing; shown on the tool card in the UI." }
  },
  "required": [],
  "additionalProperties": false
}
```

**约束**：`path` 与 `attachment_id` **恰好给一个**（两个都不给 → `invalid_arg`；两个都给 → `invalid_arg`）。JSON Schema 无法表达 XOR，由执行器校验（参考 `packages/tools/src/args.ts` 的既有风格）。

> 为什么需要 `attachment_id`：用户上传的图在 `<session-dir>/attachments/` 下，而该目录**可能不在** `CELESTEA_TOOL_ROOTS` 内（§5.5）。让模型记住一个内容寻址 id，比放大沙箱 roots 更安全。

### 6.2 工具契约（`contracts/tools.json` 追加，第 12 个）

```json
{
  "name": "read_image",
  "description": "Read an image (PNG/JPEG/WebP/GIF) and attach it to the conversation so a vision-capable model can see it. Returns metadata; the image content block is delivered with the tool result. Fails on models without image input.",
  "parameters": { "...": "见 §6.1" },
  "sourceRef": "docs/feature-multimodal-attachments/02-design.md#6"
}
```

`count: 11 → 12`。工具注册点：`packages/tools/src/builtin.ts`（照 `ask_user_tool` 的「按构造可选」模式：`attachments` 服务不存在就不注册，避免 schema 撒谎）。

### 6.3 返回形状：元数据 + 图片内容块（两条通道）

**通道 1 —— 工具返回值（可持久化、进日志）**，只是一个 JSON 对象：

```json
{
  "ok": true,
  "path": "/src/celestea_studio-ts/logo.png",
  "media_type": "image/png",
  "bytes": 20481,
  "width": 512,
  "height": 512,
  "sha256": "<hex>",
  "attachment_id": "<hex>",
  "normalized": { "media_type": "image/webp", "bytes": 9214, "width": 512, "height": 512 },
  "attachments": [
    { "attachment_id": "<hex>", "media_type": "image/webp", "width": 512, "height": 512, "name": "logo.png" }
  ]
}
```

**通道 2 —— 图片内容块（模型可见）**：工具执行结果里带一个 `ImageContent`，由 agent-loop 写进 `tool_result`，再由 `deriveMessagesFrom` 投影成 `Message{tool}` 的 image 块；**字节不落日志**，日志里只有 `attachments[].attachment_id`。

**两通道的分工（关键设计）**：

- **日志/审计/UI**：只认 `value.attachments`（引用）。
- **模型可见**：`deriveMessagesFrom` 遇到 `tool_result.value.attachments` → 在 tool 消息里补 `ImageContent`；wire 再把 tool 消息里的 image **拆到紧随其后的 `user` 消息**（§3.3）。
- **为什么不让工具直接返回 base64**：日志会膨胀、脱敏失效、compact 复发。**明确否掉**。

> 备选（**列出但未采纳**）：工具返回纯文本 JSON，模型再用新的 `load_attachment(id)` 工具二次取图。缺点是多一次 round trip、且模型得「知道」该调用；优点是日志与 wire 完全不变。列为 P2 备选。

### 6.4 「工具结果 → 模型消息」这一段（**本设计最容易做错的地方**）

现有数据流：

```
tool 执行  →  LoopEvent{tool_result, value:unknown}
           →  seam.session.append({type:"tool_result", id, value, error})   (agent-loop/src/loop.ts:313)
           →  deriveMessagesFrom: toolResultMessage(id, serdeJsonString(value))  (core/projection.ts:87-89,107-111)
           →  mapMessage: {role:"tool", content: <纯字符串>}                     (llm/wire.ts:63-68)
```

`value` 是任意 JSON 且**已经被 `serdeJsonString` 变成字符串**——所以图片**不可能**靠现有路径到达模型。改法（三层，每层一条）：

1. **core/projection.ts**：`projectEvent` 的 `tool_result` 分支读 `value.attachments`，把它们转成 `ImageContent`；tool 消息的 `content = [text, ...images]`。**文本仍保留**（模型需要知道路径/尺寸）。
2. **llm/wire.ts**：`buildRequestBody` 遍历 seam messages 时，遇到「tool 消息带 image」就 push 两条 wire 消息——`{role:"tool", content:<text>, tool_call_id}` 然后 `{role:"user", content:[{text:…},{image_url:…}]}`。**顺序必须紧邻**，否则 §3.2 形状 B 的实测结论不成立。
3. **llm/wire.ts 的 `system`/`assistant`**：保持纯文本；即使意外收到 image，也应**明确报错**而不是静默走 `collectMessageText`（后者会丢图）。

**必须补的测试**：

- `deriveMessagesFrom`：带 `value.attachments` 的 tool_result → tool 消息含 image 块；不带 → 与今天**字节一致**。
- `buildRequestBody`：一条带图 tool 消息 → 展开成 tool + user 两条（顺序、`tool_call_id` 保留、图片在 user 里）。
- `balanceToolCalls`：tool(user) 消息不被误判为「未应答的 tool call」——**注意它的 `i = j + inserted + 1` cursor quirk**（`core/projection.ts:147-153`），插入的 user 图片消息在 **wire 层**，不在 derive 输出里，所以 quirk 不受影响；但要在测试里钉死这一点。

### 6.5 尺寸/像素上限与下采样（**P0 依赖已裁决：`image-size`**）

- **只报宽高也需要图像格式知识**（Node 标准库没有内置能力）：仓库当前**没有任何图像库**（实测：`package.json` 与各 workspace `package.json` 里 grep `sharp|jimp|image-size|file-type` **零命中**），因此 P0 必须新增 `image-size`（用户已裁决）。
- 可选路径：
  1. **`sharp`**：DSH 用的就是它（`libvips`），解码/缩放/转码/EXIF/尺寸一把梭，但引入**原生二进制依赖**（跨平台体积、pnpm 构建脚本、CI 影响）。
  2. **`image-size`**：纯 JS 只读头部，能拿宽高与格式，**不能**下采样/转码。体积小、无原生依赖。
  3. **自己解析 PNG/JPEG/WebP/GIF 头**：零依赖，但 WebP 头较繁、JPEG 需走 SOF 段；维护成本高。
  4. **不做图片，`read_image` 只做「引用 + 原样透传」**：仍需要至少格式+尺寸（错误文案要用），还是要 2 或 3。
- **用户已裁决（2026-09-16）**：**P0 采用 `image-size`**（纯 JS、只读头部拿格式+宽高、无原生依赖；**超限即拒绝**）；**P1 再评估 `sharp`** 做规范化与下采样。P0 不做质量阶梯降码与请求期二次缩放。
- 下采样策略（P1）：`scale = min(1, sqrt(maxPixels / (w*h)))`，**不放大**，向内取整；与 DSH 的 request-version 语义一致（借鉴其公式，不搬其全部预算体系）。

### 6.6 配置显式排除视觉时的明确拒绝（与上游实际拒绝分开）

**工具级拒绝只在配置显式排除时发生**（这是与 DSH `fail-closed` 的**刻意分歧**，见 §7.1 的用户裁决）：工具执行器读目标模型的 `input_modalities`——**缺省/缺失 = 乐观支持**；只有用户**显式**把它配成不含 `image` 时，才在 I/O 之前抛 `ToolFailure("unsupported_modality", …)`，不读文件、不写附件。若配置乐观而**上游实际拒绝**，走 §7.6 的**用户可见降级**，而不是在这里提前拒绝。

文案（定稿，中文；与项目现有工具错误文案风格一致）：

```
当前模型 "<model>" 的 input_modalities 未包含 image（按配置显式排除），read_image 未执行。
请改用文本工具，或在该模型的 provider 设置里打开 input_modalities（加入 "image"）。
```

要点：

- **说出具体模型 id**（便于用户换模型），**不说**「上游可能支持」这种模糊话。
- 能力位**缺省时乐观放行**（用户裁决，**不是** fail-closed）；配置是唯一权威，代码**不替用户判断**某个模型有没有视觉。
- 该拒绝是**工具级失败**（`{ok:false}` 的 tool_result），不中断整轮；与 `read_file` 的 `binary_file` 失败同构。

### 6.7 两个必须注意的既有机制

1. **`run_code` 子调用的 `parent_id` 会被 derive 跳过**（`core/projection.ts:46-50, 88`）。若将来允许 `run_code` 的 SDK 里调 `read_image`，其 tool_result 带 `parent_id`，**图片会被 derive 丢弃**。P0 结论：`read_image` **只能由模型直接调用**；SDK 内调用需显式支持（P2，代价高）。
2. **流式协议**：`run_code` 之外的工具调用是一问一答；`read_image` 图片体积大，`tool_result` SSE 帧不要带 base64（只带 `attachments` 引用），前端用新建的附件读取端点按需拉取（§7）。

---

