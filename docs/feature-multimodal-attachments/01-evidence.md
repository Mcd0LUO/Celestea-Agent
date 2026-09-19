# 多模态附件 · 证据与上游实测（§1–§2）

> 状态：**设计（已实现 P0）** ｜ 本册是 [`README.md`](./README.md) 的分册：现状证据与上游视觉能力逐模型实测。
> 章节编号沿用原文；跨册引用（如「§7」）见分册导航。

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

