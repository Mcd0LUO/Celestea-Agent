# 多模态附件（用户上传图片/文件 + 模型侧 `read_image`）调研与设计

| 项 | 值 |
| --- | --- |
| 任务 | W801（多模态附件链路：设计，不实现） |
| 工作区 | `/src/celestea_studio-ts` |
| 日期 | 2026-09-16 |
| 状态 | **设计稿 / 未实现**（本轮只读探针 + 文档；未改任何代码、contracts、tests、fixtures） |
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

## 1. 现状证据（逐条复核）

任务书给的 5 条现状我逐条复核，全部成立，证据如下。

### 1.1 工具面：11 个工具，无 `read_image`

```
$ jq -r '.count' contracts/tools.json
11
$ jq -r '.tools[] | .name' contracts/tools.json
ask_user_question / http_request / list_dir / process_control / read_file /
run_code / run_shell / session_send_message / spawn_worker / worker_status / write_file
```

`read_file` 的契约是 **UTF-8 文本专用**，且实现里有硬性的二进制嗅探：

- `contracts/tools.json`：`read_file.description = "Read a UTF-8 text file and return its contents as a string."`
- `packages/tools/src/tools/read-file.ts:17` 同上文案。
- `packages/tools/src/fs/file-io.ts:21` `BINARY_SNIFF_BYTES = 8192`；`:56` 命中 NUL 字节即 `throw ioFailure("read_file", "binary_file", …)`。

结论：**图片走 `read_file` 一定失败**（PNG 头含 NUL）。需要独立工具。

### 1.2 内容模型：`Content` 无 image 变体

`packages/core/src/message.ts:45`：

```ts
export type Content = TextContent | ToolCallContent;   // line 45
```

`Content` 只有 `TextContent`（`:34-37`，`{type:"text",content:string}`）与 `ToolCallContent`（`:40-43`）。构造器 `userMessage/systemMessage/assistantText/toolResultMessage`（`:63-85`）**全部只产 text 块**。

### 1.3 HTTP 入口：`POST /api/turn` 只收 `input: string`

`apps/studio/src/handlers/dialog.ts:64-68`：

```ts
const input = strField(c, read.body, "input");
const asked = strField(c, read.body, "session");
const text = (input.ok ? (input.value ?? "") : "").trim();
if (text === "") return errorOnly(c, 400, "input must not be empty");
```

`contracts/endpoints.json` 的 `post_turn.request.fields` 只有 `input`（`required:true`，note `non-empty after trim`）。**没有任何附件字段**。

### 1.4 wire 层：纯文本

`packages/llm/src/wire.ts:29-34`：

```ts
export interface WireMessage { role: string; content: string | null; … }
```

`mapMessage`（`:57-86`）对 system/user/tool 一律 `collectMessageText(msg.content)`；`collectMessageText`（`packages/llm/src/seam.ts:114-119`）只把 `type==="text"` 的块按 `
` 拼接，**非 text 块被静默丢弃**。

### 1.5 前端：零附件入口

```
$ grep -rniE "paste|dragover|dragenter|datatransfer|clipboarddata|type=.file.|FileReader|createObjectURL" apps/web/src --include=*.ts | wc -l
0
```

`apps/web/src/ui/inputbar.ts` 只有 textarea + Enter/Shift+Enter/Ctrl+Enter 车道逻辑；`apps/web/src/ui/messages/user.ts:33-62` 用 `body.textContent = text` 渲染纯文本气泡；`apps/web/src/api.ts:180-186` 的 `turn()` 只发 `{input, session, mode}`。

### 1.6 因此链路断点有 5 处

```
GUI ──✗── HTTP /api/turn ──✗── runtime.startTurn ──✗── SessionEvent ──✗── deriveMessages ──✗── wire ──> 上游
         (不入参)            (input:string)        (user_message.text)   (Content 无 image)   (content:string)
```

---

## 2. 上游视觉能力实测（逐模型结论 + 原始响应）

### 2.1 探针方法

- **实例**：`POST http://127.0.0.1:3001/v1/chat/completions`，`stream:false`，`max_tokens:200`。**只读**，未消费任何会话（不碰 3777）。
- **凭据**：从运行中的 studio 进程**环境变量**读取 `CELESTEA_API_KEY`（`/proc/2741249/environ`），全程只经内存/管道传递，**未打印、未落盘**（响应体不含任何 key 片段）。
- **测试图**：PIL 现场生成 128×128 PNG，1062 字节，sha256 前缀 `4158fbf8b6244d76`：**左上红圆 + 右下蓝方块 + 左下黑色数字 7**（三个互相独立的可证伪特征）。
- **对照组**：同一 prompt 去掉图片（`baseline_text`）。若模型无视觉，正确行为是回 `NO_IMAGE`；若模型瞎编，会在无图时也报形状/颜色。
- **prompt**：`Look at the attached image. Answer strictly: SHAPES=<…>; COLORS=<…>; DIGIT=<…>. If no image … answer exactly: NO_IMAGE`

### 2.2 逐模型结论

| # | provider | 模型 id | 带图 HTTP | 模型回答（原文） | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | celestea | `deepseek-v4-flash-0731` | **400** | `multimodal input is not supported by this chat renderer` | **❌ 无视觉** |
| 2 | celestea | `glm-5.3-flash` | 200 | `SHAPES=<a red circle in the upper-left and a blue square in the lower-right>; COLORS=<red circle, blue square>; DIGIT=<7>` | **✅ 有视觉** |
| 3 | celestea | `deepseek-flash` | 200 | `SHAPES=red circle top left, blue square bottom right, black digit 7 bottom left; COLORS=red circle, blue square; DIGIT=7` | **✅ 有视觉**（网关回 `model=deepseek-v4.1-flash`，见 §2.4） |
| 4 | celestea | `deepseek-v4-pro` | 200 | `SHAPES=A red circle at the top-left and a blue square at the bottom-right; COLORS=red circle and blue square; DIGIT=7` | **✅ 有视觉** |
| 5 | celestea | `deepseek-v4.1-flash` | 200 | `SHAPES=circle at top-left, square at bottom-right, digit at bottom-left; COLORS=red circle, blue square; DIGIT=7` | **✅ 有视觉** |
| 6 | celestea | `deepseek-v4-flash` | **400** | `Error from provider (Console Go): Upstream request failed: [400] Model only supports text input; received unsupported content type image_url.` | **❌ 无视觉** |
| 7 | 基元 | `deepseek-flash` | **401** | `{"code":"UNAUTHORIZED","message":"未认证或登录已过期"}` | **⏳ 待验证（凭据不可得）** |

**对照组（无图）**：`glm-5.3-flash`、`deepseek-flash`、`deepseek-v4.1-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-0731` 全部回 `NO_IMAGE`（未瞎编）；`deepseek-v4-pro` 无图时 `content:""` + `finish_reason:"length"`（推理段吃掉了 200 token 预算），**带图时回答具体且正确**，故判有视觉。

### 2.3 基元 `deepseek-flash` 为什么是「待验证」而不是「无」

- `基元` 的 `base_url = https://tokenrhythm.studio/v1`，与 celestea 网关**不同源**；用 studio 环境里的 `CELESTEA_API_KEY` 打它是 **401**（实测，见上表第 7 行）——说明它需要自己的 key。
- 其 key 只存在于 `/var/lib/celestea-agent/providers.json` 内联字段（该文件 mode `0600`，schema `contracts/data-files/providers.schema.json` 明确标注 `api_key: PLAINTEXT secret`）。
- 本轮边界明确要求「**不读 providers.json 明文 key（用 env）**」。env 里没有基元的 key，故**不做探针**，按验收要求标注 **待验证**，并列入 §9 需用户裁决的开放问题。
- 间接旁证（**不作为结论**）：`基元/deepseek-flash` 与 `celestea/deepseek-flash` 同名，而后者是网关别名到 `deepseek-v4.1-flash`（§2.4），两者视觉能力**可能**一致，但未实测，不得写成既成事实。
- **策略更新（用户裁决 2026-09-16）**：能力位改为「乐观默认 + 可配置」后，**不再需要**为基元做探针；此行保留为**事实证据**，默认值不依赖它。该开放问题**已关闭**（§9.5）。

### 2.4 网关别名现象（重要，影响能力位设计）

请求 `model: "deepseek-flash"` 时，3001 返回体里的 `model` 字段是 **`deepseek-v4.1-flash`**（实测）。也就是说 **`celestea` 的模型 id 是网关路由名，不是真实后端模型名**。后果：

- 能力位**不能**用「真实后端模型名」推断，只能**按我们发现请求配置里的模型 id 逐条登记**；
- 未来网关换后端时，能力位会**静默失效**（旧 id 仍在，视觉能力可能变了）——见 §9 开放问题（是否引入 `GET /api/models` 能力探测作为运行时真源）。

### 2.5 原始响应证据（逐字，未删改）

```json
// [1] deepseek-v4-flash-0731  with_image  HTTP 400
{"error":{"message":"multimodal input is not supported by this chat renderer","type":"invalid_request_error","param":"","code":"invalid_request_error"}}

// [2] glm-5.3-flash  with_image  HTTP 200
{"model":"glm-5.3-flash","choices":[{"finish_reason":"stop","message":{"content":"SHAPES=<a red circle in the upper-left and a blue square in the lower-right>; COLORS=<red circle, blue square>; DIGIT=<7>"}}]}

// [3] deepseek-flash  with_image  HTTP 200  (reported_model = deepseek-v4.1-flash)
{"model":"deepseek-v4.1-flash","choices":[{"finish_reason":"stop","message":{"content":"SHAPES=red circle top left, blue square bottom right, black digit 7 bottom left; COLORS=red circle, blue square; DIGIT=7"}}]}

// [4] deepseek-v4-pro  with_image  HTTP 200
{"model":"deepseek-v4-pro","choices":[{"finish_reason":"stop","message":{"content":"SHAPES=A red circle at the top-left and a blue square at the bottom-right; COLORS=red circle and blue square; DIGIT=7"}}]}

// [5] deepseek-v4.1-flash  with_image  HTTP 200
{"model":"deepseek-v4.1-flash","choices":[{"finish_reason":"stop","message":{"content":"SHAPES=circle at top-left, square at bottom-right, digit at bottom-left; COLORS=red circle, blue square; DIGIT=7"}}]}

// [6] deepseek-v4-flash  with_image  HTTP 400
{"error":{"message":"Error from provider (Console Go): Upstream request failed: [400] Model only supports text input; received unsupported content type 'image_url'.","type":"invalid_request_error","param":"","code":null}}

// [7] 基元/deepseek-flash  with_image  HTTP 401（未持凭据）
{"code":"UNAUTHORIZED","message":"未认证或登录已过期","traceId":"trace_93ccb4d7-649d-4c60-9cd4-f5b7448738fd"}
```

（为版面只保留了 `content` / `error` / `model` / `finish_reason` 字段；`usage`、`id`、`created` 等无关字段省略。完整脚本见 §11 复现命令。）

### 2.6 数据 URL 形状的附加实测

- `{type:"image_url", image_url:{url: DATA_URL}}` —— **4/4 视觉模型接受**（§2.2）。
- `{type:"image_url", image_url:{url: DATA_URL, detail:"high"}}` —— `glm-5.3-flash`、`deepseek-v4-pro` 正常识图；`deepseek-flash` 回 `content:""` + `finish_reason:"length"`（疑似推理段吃预算，非拒绝）。**`detail` 字段不是必需**，P0 不必发。
- 未测：远程 http(s) URL 图片。**待验证** —— 且设计上不打算用（会让上游回源抓取，引入 SSRF/出口依赖，见 §3.3）。

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
| `session/src/log/persistent.ts:73-90` | `append` 落盘 | 无需改（`value` 自动带） |
| `session/src/parity.test.ts` / `log/derive.test.ts` | 与旧实现的字节对拍 | **会红**，需要按新契约更新（§4.5） |

#### E. `packages/llm` —— wire 映射

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `llm/src/seam.ts:114-119` | `collectMessageText` 静默丢弃非 text 块 | **保留**（它只答「文本是什么」）；新增 `collectMessageParts(content)` 产出 `WireContentPart[]`，并在注释里写明「切勿用它处理带图消息」 |
| `llm/src/wire.ts:29-34` | `WireMessage.content: string \| null` | 放宽为 `string \| WireContentPart[] \| null` |
| `llm/src/wire.ts:57-86` | `mapMessage` 四个 role 分支 | `user`：有图则产数组；`tool`：有图则**不在这里产**（交给 buildRequestBody 拆分）；`system`/`assistant` 保持纯文本 |
| `llm/src/wire.ts:110-130` | `buildRequestBody` 逐条 push `mapMessage` | 新增：单个 seam message 可能展开成 **2 条** wire message（tool 文本 + user 图片），并保持顺序 |
| `llm/src/index.ts:32-34` | 导出 `collectMessageText` 等 | 导出新 helper |
| `llm/src/stream.ts:82` | `doneMessage` 只产 text/tool_call | **不改**（本轮不处理「模型回图」；OpenAI chat 流式本就不回图） |

#### F. `packages/agent-loop` —— 上下文与事件

| 文件:行 | 现状 | 必须怎么改 |
| --- | --- | --- |
| `agent-loop/src/context-trim.ts:56-57` | `if isTextContent … else if isToolCallContent …` | **加 image 分支**：图片必须有 token 估算（例如按尺寸/固定值），否则上下文裁减**系统性低估**，可能把超窗请求发给上游 |
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
| `web/src/chat.ts:450-520` | `injectInput` 发送/回滚 | 附件随消息一并乐观渲染与回滚 |
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

1. `contracts/tools.json`：`count 11 → 12`，追加 `read_image` 定义（形状见 §6.2）；`sourceRef` 写 `docs/feature-multimodal-attachments.md#62`（新工具，非移植）。
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
| `scripts/compare-replay.ts:98-102` | 与 `fixtures/sessions/*/{messages,derive-messages}-expected.json` 逐字节对拍 | **只有含附件的会话才会真正不同**；现有 5 个 fixture 都没有附件 → **理论上不变**。但 `StudioMessage.user` 若新增恒在字段（`attachments: []`）就会**全体变红**。**设计约束：可选字段必须「无则完全省略」（serde 风格），不得写 `null`/`[]`。** |
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

实测确认会话目录的物理布局是 **`<workspace>/<session-dir>/`**（例如 `/server-center/center-架构师-1788940601.93642104/cli-main.jsonl`；`workspaces.json` 的 workspace 路径 + `session.schema.json` 的 sessionDir）。因此：

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
  "sourceRef": "docs/feature-multimodal-attachments.md#6"
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

## 7. 能力位与端点成本

### 7.1 需要三层能力位（缺一不可）

| 层 | 载体 | 作用 | 契约影响 |
| --- | --- | --- | --- |
| **部署级** | `GET /api/health.capabilities.multimodal = true` | 前端决定**是否显示**附件入口（粘贴/拖拽/选文件） | `handlers/health.ts:59` 加一个布尔；**PURE ADDITION**，与 W516/W725/W729/W767 完全同构。旧客户端看不到就降级为「无附件」 |
| **模型级** | `providers.json` 的 `models[].input_modalities` / `models[].output_modalities` | 后端 `read_image` 的**配置判据**；前端选模型时决定附件入口是否可用 | `providers.schema.json` 的 `models[].properties` 加两个可选字段；`publicView.fields` 加 `models[].input_modalities` / `models[].output_modalities`；`providers.ts` 的 public_view 映射同步 |
| **会话级** | 前端由当前会话的 model → provider → model 行推导；不新增端点 | 乐观默认=允许；只有当该模型被**显式**排除 `image` 时才禁用入口并提示 | 无（纯前端推导） |

**为什么能力位必须在模型级**：§2 实测同一个 provider 的 6 个模型里 4 个有视觉、2 个明确拒绝。放在 provider 级**一定是错的**。

**默认值 = 乐观（用户裁决 2026-09-16）**：`input_modalities` 缺省 = `["text","image"]`，`output_modalities` 缺省 = `["text"]`。**不 fail-closed、不由代码硬判**某个模型有没有视觉；某模型无视觉由**用户配置**关闭（`input_modalities: ["text"]`）。§2.2 的「4 有 / 2 无」保留为**事实证据**，但**不作为默认值的依据**。猜错的兜底见 §7.6。

### 7.2 `providers.json` 字段（schema 已是 `additionalProperties:true`，向后兼容）

```json
{
  "id": "glm-5.3-flash",
  "name": "GLM 5.3 Flash",
  "input_modalities": ["text", "image"],   // 缺省即此值（乐观）
  "output_modalities": ["text"]            // 缺省即此值
}
```

`publicView`（`providers.schema.json` 的 `publicView.fields`）必须同步加 `models[].input_modalities` 与 `models[].output_modalities`，否则前端拿不到。schema 的 `models[].properties` 是 `additionalProperties: true`，新增字段对旧数据向后兼容。

### 7.3 `GET /api/health.capabilities`

```json
"capabilities": { "grants": true, "context": true, "session_mode": true, "session_mode_tools": true, "multimodal": true }
```

**PURE ADDITION**：`handlers/health.ts:59` 一处改动；旧前端忽略未知字段。**不新增端点**。

### 7.4 `API_ENDPOINT_COUNT 51 → 52？`—— 直接回答：**P0 保持 51 不变**

**用户裁决（2026-09-16）：P0 零新端点。**

| 阶段 | 方案 | 新端点数 | `API_ENDPOINT_COUNT` |
| --- | --- | --- | --- |
| **P0** | `POST /api/turn` body 内联 base64 附件；`read_image` 直接读本地文件 | **0** | **51（不变）** |
| P1（仅当大图/历史回放成为问题） | 追加 `POST /api/upload`（或 `POST /api/sessions/{id}/attachments`）+ 一个按 `attachment_id` 回读字节的 GET | +1～2 | 51 → 52（或 53） |

**P0 的直接后果（必须写清，否则是隐性缺陷）**：

- 前端在**同一次 `POST /api/turn`** 里把附件 base64 一起发出 ⇒ 一次请求 = 一个乐观帧（§8），无需 upload 往返。
- **P0 没有「按 id 回读附件字节」的端点**：刷新/其它客户端回放历史时，图片只能渲染为**附件元数据**（文件名 + 尺寸 + MIME），不能内联显示；本会话内可继续用 `URL.createObjectURL` 显示。**这是 P0 的已知限制**，不是 bug；字节回读端点随 P1 一并加。
- `read_image` 读**本地文件**不需要任何上传端点；它产出的附件写入 `<session-dir>/attachments/`，模型可见性由 §6.4 的 wire 拆分保证。
- `contracts/endpoints.json` 的 `count`、`packages/core/src/contracts/index.ts:128-130` 的硬断言、`apps/studio/src/routes.ts:54`、`tests/contracts.test.ts` 的 51 —— **P0 全部不动**。

### 7.5 逐条契约改动清单（P0，端点计数不变）

| # | 文件:行 | 改动 | 端点计数影响 |
| --- | --- | --- | --- |
| 1 | `contracts/endpoints.json` `post_turn.request.fields` | 加 `attachments`（optional，array；内联 base64 形状） | 0 |
| 2 | `contracts/endpoints.json` `source.routeTable` | 追加 W801 说明（P0 不新增端点） | 0 |
| 3 | `contracts/endpoints.json` `count` / `endpoints[]` | **P0 不动** | 0 |
| 4 | `packages/core/src/contracts/index.ts:128-130` | **P0 不动**（硬断言仍是 51） | 0 |
| 5 | `apps/studio/src/routes.ts:54` | **P0 不动**（`API_ENDPOINT_COUNT = 51`） | 0 |
| 6 | `tests/contracts.test.ts` | **51 相关断言不动**；`:23-25` 工具数 11 → 12 | 0 |
| 7 | `apps/studio/src/handlers/health.ts:59` | capabilities 加 `multimodal: true` | 0 |
| 8 | `contracts/data-files/providers.schema.json` | model 加 `input_modalities` / `output_modalities`；`publicView.fields` 同步 | 0 |
| 9 | `contracts/route-table.snapshot.json` | **P0 不动** | 0 |
| 10 | `contracts/tools.json` | `count 11 → 12`，追加 `read_image` | 0 |

**成本结论**：P0 的契约改动**不碰任何端点计数**（只加一个可选请求字段 + 两个能力字段 + 一个新工具），风险集中在 §4.2C 的事件序列化。

### 7.6 乐观默认下「猜错」是常态：上游 400 → 用户可见降级（**新增设计**）

**前提**：默认 `input_modalities = ["text","image"]` 意味着**我们默认假设每个模型都能看图**。§2.2 已证明该假设对 `deepseek-v4-flash-0731` / `deepseek-v4-flash` 是**错的**（上游 400）。因此「配置乐观 + 上游拒绝」不是异常，而是**必须一等公民处理的常态路径**。

**原则（按重要性排序）**：

1. **绝不静默失败**：不得吞掉上游 400、不得假装图片已送达、不得只写日志。
2. **绝不让整个回合炸掉**：一次图片拒绝不能让用户的文本输入、工具调用、整轮对话全部丢失。
3. **必须给出可执行的下一步**：告诉用户是哪个模型拒绝、可换哪个模型、或怎么改配置。

**处理流程（一次自动降级 + 可见提示）**：

```
请求装配（wire）发现本次请求含 image 块
        │
        ├─ 上游 2xx           → 正常，图片已送达
        │
        └─ 上游 4xx 且被识别为「图像不支持」
                 │
                 ├─ ① 分类：上游报文含以下任一特征 → IMAGE_UNSUPPORTED
                 │     "multimodal input is not supported"
                 │     "Model only supports text input"
                 │     "unsupported content type 'image_url'"
                 │     （未能识别时按普通上游错误处理，不做猜测）
                 │
                 ├─ ② 降级重试一次：把本次请求里的**全部 ImageContent**
                 │     替换为文本占位块：
                 │     [图片已省略：模型 "<model>" 未接受图像输入（上游 400）；
                 │      attachment <attachment_id>，本地文件 <path>]
                 │     其余消息、工具调用、文本**逐字节不变**
                 │
                 ├─ ③ 可见提示（三重，确保用户看得到）：
                 │     - SSE / 信息块：明确文案（下）
                 │     - 状态栏：一次 err 提示
                 │     - 会话日志 / 审计：记一条「图片未送达」事件（不改既有事件类型语义）
                 │
                 └─ ④ 降级重试若仍失败 → 才按普通 turn 失败处理
                       （此时错误原因已随 ② 的请求与 ③ 的提示一并呈现）
```

**用户可见文案（定稿）**：

```
模型 "<model>" 拒绝了图像输入（上游 400），本轮已自动降级为「仅文本 + 图片占位」继续，
图片内容未送达模型。
下一步可选：
  · 切换到已配置支持图像输入的模型（在模型选择器里切换）；
  · 或在该模型的 provider 设置里确认 input_modalities 含 "image"；
  · 若该模型确实不支持视觉，请把它设为 input_modalities = ["text"]，
    这样附件入口会自动禁用，不再产生必然失败的请求。
```

**各层落点**：

- **错误分类**：`packages/llm/src/errors.ts` 新增 `ImageUnsupportedError`，由 `stream.ts` / `client.ts` 从上游报文映射；**只认已知报文特征**，不猜。
- **降级重试**：`packages/llm/src/fallback.ts` 已有「一次重试」的骨架，复用其位置；降级后的请求体由 wire 层重新装配（把 image 块换成占位文本）。
- **可见提示**：`apps/studio` 的 SSE `status` / info 通道 + 前端 `renderInfoBlock`（与「发送失败」同一条通道）。
- **不炸回合**：降级后模型仍能基于文本与占位继续回答；用户的输入**不丢**（§8 的乐观回执仍然成立，只是被标注为「图片未送达」）。
- **`read_image` 工具路径**：工具本身已成功返回（附件已落盘），降级只影响**下一次请求**；模型会看到占位文本，并可在文本里说明「图片不可见」。
- **与「显式排除」的区别**：若用户已把 `input_modalities` 配成 `["text"]`，则**根本不会发出带图请求**（前端禁用 + 工具 gate 拒绝，§6.6），走不到这里。本节 400 路径专门服务**乐观默认下的猜错**。

---

## 8. 前端设计

### 8.1 三种入口（对齐用户预期的「粘贴/拖拽/文件选择」）

| 入口 | 事件 | 关键点 |
| --- | --- | --- |
| **粘贴** | `paste` on textarea（或文档） | 从 `e.clipboardData.items` 取 `kind==="file"` 且 `type.startsWith("image/")` 的项；**同时含文字与图片时两者都收**（不吞文本）；无附件支持时**不** `preventDefault`（保留原生粘贴） |
| **拖拽** | `dragenter/dragover`（`preventDefault` 才能收 `drop`）+ `drop` | 全窗口高亮投放区；`drop` 时 `e.dataTransfer.files`；拖入非图片 → 明确提示（不静默）；**must** 阻止浏览器默认打开文件 |
| **文件选择** | 隐藏 `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>` + 📎 按钮 | 按钮上要有 `title`；`accept` 只是便利，服务端仍按魔数嗅探（§5.4） |

入口全部落在 `apps/web/src/ui/inputbar.ts`（现有 textarea 的宿主），把 `File[]` 交给新的 pending 附件状态。

### 8.2 消息里渲染附件

- **待发**：输入栏上方一条横向缩略图条（可删除单个），随草稿一起跨会话保存/恢复。
- **已发送**：`ui/messages/user.ts` 的气泡内，文本下方渲染附件网格（缩略图 + 文件名 + 尺寸）。
- **历史回放**：`GET messages` 的 `attachments` 只有引用 → 前端按需 `GET /api/sessions/{id}/attachments/{id}` 取字节，用 `URL.createObjectURL` 显示，**在消息卸载/会话切换时 `revokeObjectURL`**（否则内存泄漏，长会话尤甚）。
- **工具卡片**：`read_image` 的 tool_result 带 `attachments`，`ui/toolcards.ts` 用同一套缩略图组件渲染（对齐 DSH 的 tool-card image results）。
- 非图片「文件附件」**明确不做**（P0 范围外，见 §9）：本轮只处理 PNG/JPEG/WebP/GIF。

### 8.3 乐观原则（用户近期定调：当帧见终态、无「上传中…」、失败完整回滚）

项目已有两处可援引的先例：

- `apps/web/src/ui/optimistic.ts:1-10`（W792）：「用户一确认，该行**立即**从界面消失（不做『删除中…』占位、不阻塞），请求在后台发；**失败才把行插回原位**」。
- `apps/web/src/statusline/optimistic.ts:1-14`（W795）：「能立即推出终态的交互**先画终态**，请求后台跑；失败回滚到动作前的值并说明原因。乐观只改**显示**……绝不假装成功」。

把同一口径落到附件：

1. **选择/粘贴/拖入的那一刻就是「终态」**：立刻在输入栏渲染缩略图（`URL.createObjectURL(file)`）。**不转圈、不显示「上传中…」、不发任何请求**。
2. **发送即终态**：点击发送时，用户气泡（文本 + 附件缩略图）**立即**以最终样式入场（沿用 `addUserMessage`，见 `chat.ts:450` 的 `injectInput`），输入栏清空。请求在后台发。
3. **成功**：什么都不用改（界面已经是终态）；`URL.createObjectURL` 的 URL 可保留到消息卸载，或换成服务端 URL。
4. **失败 = 完整回滚**：
   - 移除刚插入的整个用户气泡（`col.remove()`，与 `injectInput` 的失败路径一致）；
   - 文本还原输入框（`restoreDraft`）；
   - **附件还原到待发列表**（不丢文件，用户可直接重试）；
   - 信息块 + 状态栏给**明确原因**（例如「附件过大：12.4 MiB > 20 MiB」「模型 deepseek-v4-flash 不支持图像输入」「上传失败：HTTP 413」）；
   - **绝不**保留一个「看起来发出去了」的假气泡。
5. **前置校验也在「那一帧」**：格式/大小/数量超限时，附件**当场标红**并给原因，**不发请求**（避免必然失败的往返）。
6. **能力位禁用（仅显式排除时）**：乐观默认下**不**预先禁用；只有当该模型被**显式**配成 `input_modalities=["text"]` 时才禁用入口并给出原因。若配置乐观但上游实际 400，走 §7.6 的可见降级（气泡上标注「图片未送达」，文本照常）。
7. **多会话**：待发附件属于**会话草稿**的一部分，切会话时随 `inputValue/setInputValue`（`inputbar.ts:141-151`）一起保存/恢复；避免「在 A 会话选的图出现在 B 会话」。

### 8.4 需要新增的前端状态

| 位置 | 内容 |
| --- | --- |
| `inputbar.ts`（或新 `ui/attachments.ts`） | 待发 `File[]` + 每个的本地预览 URL + 校验状态 |
| `viewctx.ts`（`SessionPane`） | 会话级草稿附件（与 `draft` 并列） |
| `state.ts` / `types.ts` | `attachments` 字段类型 |
| `styles/*.css` | 缩略图条、气泡内网格、拖拽高亮、lightbox |

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
| R10 | 并发任务（W798 rust 全删 / W802 DSH 动态工具披露）导致的 `pnpm check` 红灯 | 低 | 本任务未改代码；若复现按协议登记 `git status --porcelain`（本轮**不跑** `pnpm check`，见 §11.4） |

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

## 11. 附录：复现命令与证据

### 11.1 视觉能力探针（无 key 外泄）

```python
#!/usr/bin/env python3
# 从 studio 进程 env 读 key；只打印响应；不落盘 key。临时脚本，跑完即删。
import base64, json, time, urllib.request, urllib.error
from PIL import Image, ImageDraw, ImageFont

def env_key():
    with open("/proc/2741249/environ","rb") as f:
        for part in f.read().split(b"\x00"):
            if part.startswith(b"CELESTEA_API_KEY="):
                return part.split(b"=",1)[1].decode()
    raise SystemExit("no key")

API="http://127.0.0.1:3001/v1/chat/completions"
MODELS=["deepseek-v4-flash-0731","glm-5.3-flash","deepseek-flash",
        "deepseek-v4-pro","deepseek-v4.1-flash","deepseek-v4-flash"]

img = Image.new("RGB",(128,128),(255,255,255)); d = ImageDraw.Draw(img)
d.ellipse([8,8,56,56], fill=(220,20,20))
d.rectangle([72,72,120,120], fill=(20,40,220))
d.text((22,80),"7", fill=(0,0,0), font=ImageFont.load_default(size=34))
img.save("/tmp/_w801_vision.png")
DATA="data:image/png;base64,"+base64.b64encode(open("/tmp/_w801_vision.png","rb").read()).decode()
Q=("Look at the attached image. Answer strictly: SHAPES=...; COLORS=...; DIGIT=...; "
   "If no image is attached or you cannot see images, answer exactly: NO_IMAGE")
KEY=env_key()
for m in MODELS:
    body={"model":m,"max_tokens":200,"stream":False,"messages":[{"role":"user","content":[
          {"type":"text","text":Q},{"type":"image_url","image_url":{"url":DATA}}]}]}
    req=urllib.request.Request(API, data=json.dumps(body).encode(), method="POST",
          headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r: print(m, r.status, r.read().decode()[:400])
    except urllib.error.HTTPError as e: print(m, e.code, e.read().decode()[:400])
    time.sleep(1)
```

### 11.2 工具结果携带图片的形状探针

见 §3.2：把同一张图分别放进 `role:"tool"` 的 content 数组（形状 A）与紧随其后的 `role:"user"` 消息（形状 B），比较四个模型的回答。关键复现点：`deepseek-v4-pro` 对 A 回 `NO_IMAGE`、对 B 正确识图。

### 11.3 代码面穷举命令

```bash
# Content 联合的类型级匹配点
grep -rn 'type === "text"\|type === "tool_call"\|part.type\|c.type ===\|content.type ===' \
  packages apps --include=*.ts | grep -v \.test\. | grep -v node_modules
# Content helper 调用点
grep -rn 'isTextContent\|isToolCallContent\|messageTexts\|messageText(\|collectMessageText\|messageToolCalls\|hasToolCalls' \
  packages apps --include=*.ts | grep -v \.test\. | grep -v node_modules
# 端点计数硬断言
grep -rn 'API_ENDPOINT_COUNT\|must hold 51\|50 -> 51' packages apps tests contracts --include=*.ts --include=*.json
```

### 11.4 本轮**没有**做的事（重要）

- **未跑 `pnpm check`**：本轮是设计稿，未改任何代码、contracts、tests、fixtures（`git status` 里与本任务相关的改动**只有本文件**）。跑全量检查只会看到 W798（rust 全删）与其它并发任务的路径噪声，无诊断价值。若验收方要求，可单独跑并登记 `git status --porcelain`。
- **未探测基元**（凭据边界，§2.3）。
- **未实测**上游的单消息图片数/体积上限、远程 URL 图片、Files API（均标 **待验证**）。

### 11.5 环境事实（实测）

```
studio 进程: node tsx src/main.ts (pid 2741249, user celestea)
CELESTEA_PROVIDERS_FILE=/var/lib/celestea-agent/providers.json  (mode 0600, plaintext api_key)
CELESTEA_TOOL_ROOTS=/src/celestea_studio-ts:/src/celestea_harness:/tmp
workspaces: /src/CelesteaTeamAPI, /src/celestea_harness, /server-center
会话目录: <workspace>/<session-dir>/{cli-main.jsonl, session.json, ...}
上游: http://127.0.0.1:3001/v1 (celestea) / https://tokenrhythm.studio/v1 (基元)
仓库图像库: 无 (grep sharp|jimp|image-size|file-type = 0 命中)
```

