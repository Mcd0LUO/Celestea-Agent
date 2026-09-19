# 多模态附件 · 能力位与前端（§7–§8）

> 状态：**设计（已实现 P0）** ｜ 本册是 [`README.md`](./README.md) 的分册：能力位与端点成本、前端三入口与渲染。
> 章节编号沿用原文；跨册引用（如「§7」）见分册导航。

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

