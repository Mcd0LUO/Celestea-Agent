# 清单 3 · 共用前端「面向用户可见的技术文案」审计

> 状态：**清单（只读审计，未改任何代码）**。
> 范围：`/src/celestea_studio/frontend/src/**/*.ts`（27 个文件）+ 附加：`/src/celestea_studio/frontend/index.html`（同一份 dist，见 §5）。
> 背景：架构师已完成一处清理——`frontend/src/ui/config.ts:215-218` 的
> `'数据源：GET /api/config · 窗口补充：GET /api/status · 保存 POST /api/config（后端需支持热调）'` 已删除
> （commit `3f9bc29`）。本清单是**其余**同类文案的完整清点。
> 判定原则：**会渲染到用户界面上**且内容涉及**实现细节而非用户概念**的字符串。
> 纯注释、`console.*` 参数、`api.ts` 里作为 `fetch` 入参的 URL 常量、以及真正的安全告知/可操作指引**一律排除**（§6）。

---

## 0. 统计

| 分组 | 条目数 | 性质 |
|---|---|---|
| A · 端点 / HTTP / 协议字样 | 17 | 必须删或改（用户不需要知道实现通道） |
| B · 实现名词（后端 / 前端 / 接口 / 热应用 / 引擎 Worker / lagged） | 25 | 改写成用户语言 |
| C · 内部标识与实现视角计数（`ev:` / 会话 id / 落盘文件名 / `turn`·`step`） | 9 | 删除或改写成用户单位 |
| D · 底层错误原文直接拼接（1 个源头 + 37 处落点） | 38 | **优先修源头**，一次性消除 37 处泄漏 |
| **小计（`src/**`）** | **89** | 其中「删除类」6 条、「改写类」83 条 |
| E · 附加发现（超出 `src/**`，同一 dist 的 `index.html`） | 1 | 与 A 同款，需一并处理 |
| **合计** | **90** | — |

---

## 1. 分组 A · 端点 / HTTP / 协议字样（17 条）

| # | 文件:行 | 原文（逐字） | 渲染位置 | 判定 | 建议文案 |
|---|---|---|---|---|---|
| A1 | `src/api.ts:63` | `'HTTP ' + res.status + ' · 后端未开放该接口'` | `ApiError.message` → 41 处 UI 报错（状态栏 / 设置页 `.cfg-status` / 侧栏 `#sideFoot` / `.ws-fs-status` / 消息流信息块） | 改写 | `当前版本不支持该操作` |
| A2 | `src/api.ts:64` | `'HTTP ' + res.status` | 同上 | 改写 | `服务暂时无法完成请求，请稍后重试` |
| A3 | `src/main.ts:36` | `(h.base_url \|\| '') + ' · ' + h.model` | 侧栏脚注 `#sideFoot`（`textContent`）——**把 API 基址暴露给用户** | 改写 | 只显示模型名（必要时空值不显示分隔符） |
| A4 | `src/statusline.ts:77` | `'上下文占用 · 模型 · 思考强度 · 吞吐 · 缓存命中（GET /api/status + SSE 增量）'` | `#statusline` 的 `title` | 删除 | 保留 `上下文占用 · 模型 · 思考强度 · 吞吐 · 缓存命中` |
| A5 | `src/statusline.ts:185` | `'无法读取 /api/config：' + (err instanceof Error ? err.message : String(err))` | 快速切换弹层 `.sl-popup-error` | 改写 | `无法读取当前配置，请稍后重试` |
| A6 | `src/statusline.ts:214` | `'模型 id（后端未提供可选清单）'` | 弹层输入框 `placeholder` | 改写 | `模型名称` |
| A7 | `src/statusline.ts:224` | `'后端未返回 available.models，手动输入'` | 弹层 `.sl-popup-note` | 改写 | `请输入模型名称` |
| A8 | `src/statusline.ts:345` | `'状态接口暂不可用'` | `#slHint`（`staleMsg`） | 改写 | `状态信息暂不可用` |
| A9 | `src/statusline.ts:348` | `'GET /api/status 失败：' + msg` | `#statusline` 的 `title` | 改写 | `状态信息暂不可用` |
| A10 | `src/statusline.ts:394` | `'缓存命中：暂无引擎用量数据（GET /api/status 的 usage）'` | `#slCache` 的 `title` | 改写 | `暂无缓存命中数据` |
| A11 | `src/statusline.ts:400-408` | `'最近一次请求：命中 ' + u.cache_read + ' / 提示 ' + u.prompt_tokens + ' tokens' + (t ? '（累计 ' + …*100).toFixed(1) + '%，命中 ' + t.cache_read + ' / 提示 ' + t.prompt_tokens + ' tokens）' : '')` | `#slCache` 的 `title`（引擎 usage 字段口径） | 改写 | `缓存命中 78%`（或 `本次命中 N / 输入 M`，用用户单位，不暴露 `cache_read`/`prompt_tokens` 字段名） |
| A12 | `src/ui/config.ts:174` | `'轮次进行中（409）：配置将在本轮结束后生效，请稍后重新保存。'` | 设置页 `.cfg-status` | 改写 | `本轮对话仍在进行，请在结束后再保存。` |
| A13 | `src/ui/config.ts:176` | `'后端未开放配置保存（HTTP ' + err.status + '）：当前后端无 POST /api/config 端点，请更新后端或编辑 celestea.toml 重启。'` | 设置页 `.cfg-status` | 改写 | `当前版本不支持在线保存配置，请升级后重试` |
| A14 | `src/ui/providers.ts:134` | `'切换即热应用（POST /api/providers/default）'` | `.prov-default-note` | 改写 | `切换后立即生效` |
| A15 | `src/ui/providers.ts:540` | `'据请求地址+Key 调用 models/fetch 快速填入（将先保存该提供商）'` | 「获取模型」按钮 `title` | 改写 | `从服务商拉取可用模型（会先保存当前填写内容）` |
| A16 | `src/ui/sessions.ts:374` | `id + (s.file ? ' · ' + s.file : '')` | 会话叶子 `title`（hover）——显示**内部会话 id 与落盘文件名** | 删除 | 改为会话标题；不显示 id 与文件名 |
| A17 | `src/ui/sessions.ts:474` | `id + (w.model ? ' · ' + w.model : '')` | 后台任务行 `title` | 改写 | 只显示名称与模型 |

---

## 2. 分组 B · 实现名词（25 条）

| # | 文件:行 | 原文（逐字） | 渲染位置 | 判定 | 建议文案 |
|---|---|---|---|---|---|
| B1 | `src/main.ts:42` | `'后端不可达'` | 状态栏 `#statusText`（`setStatus`） | 改写 | `无法连接服务` |
| B2 | `src/main.ts:68` | `'Celestea Studio 前端 · 构建于 ' + BUILD_TIME` | 顶栏 `#brandVersion` 的 `title` | 改写 | `Celestea Studio · 构建于 <日期>`（去掉"前端"） |
| B3 | `src/ui/config.ts:87` | `'模型名（后端未提供可选清单，手动输入）'` | 「模型」输入框 `placeholder` | 改写 | `模型名称` |
| B4 | `src/ui/config.ts:88` | `'后端未返回 available.models'` | 「模型」字段 `.cfg-hint` | 删除 | 删除（或 `请手动填写模型名称`） |
| B5 | `src/ui/config.ts:95` | `'后端未返回 available.efforts'` | 「推理档位」字段 `.cfg-hint` | 删除 | 删除（或 `请手动填写档位`） |
| B6 | `src/ui/config.ts:100` | `'留空保持不变（后端不会回传密钥）'` | API Key 输入框 `placeholder` | 改写 | `留空则保持当前密钥不变`——**必须保留"不会回读密钥"的安全语义** |
| B7 | `src/ui/config.ts:101` | `'仅用于热调；不会从后端读取明文'` | 「API Key」字段 `.cfg-hint` | 改写 | `不会读取或显示已保存的密钥明文`——**必须保留该安全承诺**，仅去掉"热调/后端" |
| B8 | `src/ui/config.ts:167` | `d.ok === false ? '保存失败：' + (d.error \|\| '后端拒绝') : '已保存 · 后端已应用'` | 设置页 `.cfg-status` | 改写 | `保存失败，请重试` / `已保存` |
| B9 | `src/ui/config.ts:203` | `'配置接口不可用'` | 设置页 `.side-note.err` | 改写 | `配置暂不可用` |
| B10 | `src/ui/config.ts:222` | `'配置接口不可用'` | 设置页 `.side-note.err`（`renderForm` 异常分支） | 改写 | `配置暂不可用` |
| B11 | `src/ui/providers.ts:167` | `'已切换默认模型 · 热应用'` | `.prov-default-msg` | 改写 | `已切换默认模型` |
| B12 | `src/ui/providers.ts:199` | `'提供商接口暂不可用'` | `.side-note.err` | 改写 | `提供商列表暂不可用` |
| B13 | `src/ui/providers.ts:661` | `'保存失败：' + (r.error \|\| '后端拒绝')` | `.prov-editor-status` | 改写 | `保存失败，请检查填写内容` |
| B14 | `src/ui/prompts.ts:86` | `'已设为默认并热应用：' + (p.name \|\| p.id)` | `#sideFoot`（`note`） | 改写 | `已设为默认：<名称>` |
| B15 | `src/ui/prompts.ts:104` | `'已删除并热应用：' + (p.name \|\| p.id)` | `#sideFoot` | 改写 | `已删除：<名称>` |
| B16 | `src/ui/prompts.ts:165` | `'（后端未返回段定义，覆盖编辑暂不可用；可直接保存名称级提示词）'` | 编辑弹窗 `.side-note` | 改写 | `暂不支持分段编辑，可直接保存整体提示词` |
| B17 | `src/ui/prompts.ts:271` | `'已保存并热应用：' + name` | `#sideFoot` | 改写 | `已保存：<名称>` |
| B18 | `src/ui/prompts.ts:302` | `'后端未开放提示词注册'` | `.side-note.err` | 改写 | `当前版本不支持提示词管理` |
| B19 | `src/ui/sessions.ts:460` | `'引擎 Worker'` | 侧栏分组标题 `.ws-worker-head` | 改写 | `后台任务` |
| B20 | `src/ui/sessions.ts:663` | `throw new Error(r.error \|\| '后端拒绝')` | 经 `:700` 渲染为 `.ws-fs-status` 的 `'创建成功，但激活失败：…'` | 改写 | 不抛含"后端"的消息；`后端拒绝` → `服务拒绝了该操作` |
| B21 | `src/ui/sessions.ts:907` | `'会话接口不可用'` | `.side-note.err` | 改写 | `会话列表暂不可用` |
| B22 | `src/ui/tools.ts:56` | `'工具接口不可用'` | `.side-note.err` | 改写 | `工具列表暂不可用` |
| B23 | `src/chat.ts:121` | `'检测到慢客户端事件（lagged），已合并跳过'` | `renderInfoBlock` → 消息流信息块 | 删除 | 删除，或改为用户语言：`部分输出因网络延迟被合并`（不出现 `lagged`） |
| B24 | `src/chat.ts:307` | `'已压缩：摘要轮 + 最近4轮'` | `flashStatus` → 状态栏 | 改写 | `历史已压缩` |
| B25 | `src/ui/sessions.ts:679` | `'会话已创建，但无法定位其 id——请刷新会话树后手动激活'` | 新建会话弹窗 `.ws-fs-status` | 改写 | `会话已创建，请刷新列表后手动打开` |

---

## 3. 分组 C · 内部标识与实现视角（9 条）

| # | 文件:行 | 原文（逐字） | 渲染位置 | 判定 | 建议文案 |
|---|---|---|---|---|---|
| C1 | `src/ui/sessions.ts:371` | `'ev:' + s.events` | 会话叶子 meta 行 `.sess-leaf-meta`（经 `bits.join(' · ')`） | 改写 | 移入 `title` 并写全 `N 次事件`，或直接删除 |
| C2 | `src/ui/sessions.ts:373` | `bits.join(' · ')`（其中一项是 `truncateName(id)`，即内部会话 id 如 `cli-main`） | 会话叶子 meta 行 | 改写 | 不显示内部会话 id；只显示用户可读的标题与体量 |
| C3 | `src/ui/sessions.ts:472` | `'ev:' + w.events` | 后台任务行 meta 行 `.ws-worker-meta` | 改写 | 同 C1 |
| C4 | `src/ui/sessions.ts:312` | `'排序：' + (sortMode === 'active' ? '最近活跃（modified）' : '名称') + ' · 点击切换'` | 排序按钮 `title` | 改写 | `排序：最近活跃 · 点击切换`（去掉后端字段名 `modified`） |
| C5 | `src/ui/restore.ts:253` | `'上方为刷新前恢复的存量消息'` | `.live-sep` 的 `title` | 改写 | `上方为更早的消息`（"刷新前恢复的存量消息"是前端实现视角） |
| C6 | `src/ui/statusbar.ts:20` | `'turn ' + n` / `'turn —'` | 状态栏 `#statusTurn` | 改写 | `第 N 轮` / `第 — 轮`（`turn` 是引擎概念） |
| C7 | `src/ui/statusbar.ts:24` | `'step ' + (n && String(n) !== '' ? String(n) : '—')` | 状态栏 `#statusStep` | 改写 | `N 步` / `— 步` |
| C8 | `src/statusline.ts:383` | `'step ' + steps` / `'step —'` | `#slSteps` | 改写 | 同 C7 |
| C9 | `src/ui/toolcards.ts:88` | `'step ' + d.step` | 工具卡 `row1` 的 `.step-tag` | 改写 | `第 N 步`（与 C7/C8 统一） |

---

## 4. 分组 D · 底层错误原文直接拼接（1 个源头 + 37 处落点 = 38 条）

**这是一个系统性问题，不是 37 个独立错误。** 技术文本全部来自被拼接进来的 `ApiError.message`（源头 3 处，其中 A1/A2 已列在分组 A）或后端 `error` 字段。

### D.0 源头（1 条新增 + 2 条已在 A）

| # | 文件:行 | 原文 | 说明 |
|---|---|---|---|
| D0 | `src/api.ts:49` | `'网络不可达（' + (e instanceof Error ? e.message : String(e)) + '）'` | 把浏览器原始异常文本拼进用户提示 |
| — | `src/api.ts:63` / `:64` | 见 A1 / A2 | 同一源头家族 |

**修复策略**：改 `api.ts:49`、`:63`、`:64` 三处，把 `ApiError.message` 变成**面向用户的固定短语**（可按状态码映射），并保留一个 `technical`/`cause` 字段给控制台与日志。**一次修复即可消除下表的 37 处泄漏**。

### D.1 落点（37 处；模式均为 `'X失败：' + <err.message \| r.error \| fmtErr(err)>`）

| # | 文件:行 | 原文（逐字） | 渲染位置 |
|---|---|---|---|
| D1 | `src/chat.ts:311` | `'压缩失败：' + (err instanceof Error ? err.message : String(err))` | 状态栏 `flashStatus` |
| D2 | `src/chat.ts:331` | `'取消失败：' + (err instanceof Error ? err.message : String(err))` | 状态栏 `setStatus` |
| D3 | `src/chat.ts:368` | `'发送失败：' + (err instanceof Error ? err.message : String(err))` | 状态栏 `setStatus` |
| D4 | `src/statusline.ts:139` | `'切换失败：' + (err instanceof Error ? err.message : String(err))` | `#slHint`（`setNote`） |
| D5 | `src/statusline.ts:303` | `'切换失败：' + (err instanceof Error ? err.message : String(err))` | 弹层 `.sl-popup-status` |
| D6 | `src/statusline.ts:305` | `'切换失败：' + (err instanceof Error ? err.message : String(err))` | `#slHint`（`setNote`） |
| D7 | `src/ui/config.ts:178` | `'保存失败：' + (e.message \|\| String(err))` | 设置页 `.cfg-status` |
| D8 | `src/ui/providers.ts:172` | `'切换失败：' + fmtErr(err)` | `.prov-default-msg` |
| D9 | `src/ui/providers.ts:581` | `'测试失败：' + (r.error \|\| '—')` | `.prov-editor-status` |
| D10 | `src/ui/providers.ts:590` | `'测试失败：' + fmtErr(err)` | `.prov-editor-status` |
| D11 | `src/ui/providers.ts:613` | `'获取失败：' + (r.error \|\| '—')` | `.prov-editor-status` |
| D12 | `src/ui/providers.ts:620` | `'上游未返回任何模型'`（"上游"是拓扑概念） | `.prov-editor-status` |
| D13 | `src/ui/providers.ts:642` | `'获取模型失败：' + fmtErr(err)` | `.prov-editor-status` |
| D14 | `src/ui/providers.ts:672` | `'保存失败：' + fmtErr(err)` | `.prov-editor-status` |
| D15 | `src/ui/providers.ts:879` | `'删除失败：' + fmtErr(err)` | `.prov-list-msg` |
| D16 | `src/ui/prompts.ts:89` | `'设为默认失败：' + fmtErr(err)` | `#sideFoot` |
| D17 | `src/ui/prompts.ts:107` | `'删除失败：' + fmtErr(err)` | `#sideFoot` |
| D18 | `src/ui/prompts.ts:263` | `'保存失败：' + (r.error \|\| '—')` | `.ws-fs-status` |
| D19 | `src/ui/prompts.ts:276` | `'保存失败：' + fmtErr(err)` | `.ws-fs-status` |
| D20 | `src/ui/sessions.ts:130` | `'批量删除失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D21 | `src/ui/sessions.ts:179` | `'激活失败：' + (r.error \|\| '—')` | `#sideFoot` |
| D22 | `src/ui/sessions.ts:189` | `'激活失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D23 | `src/ui/sessions.ts:200` | `'归档失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D24 | `src/ui/sessions.ts:216` | `'删除失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D25 | `src/ui/sessions.ts:229` | `'重命名失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D26 | `src/ui/sessions.ts:239` | `'分支失败：' + (r.error \|\| '—')` | `#sideFoot` |
| D27 | `src/ui/sessions.ts:247` | `'分支失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D28 | `src/ui/sessions.ts:264` | `'删除失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D29 | `src/ui/sessions.ts:277` | `'重命名失败：' + (err instanceof Error ? err.message : String(err))` | `#sideFoot` |
| D30 | `src/ui/sessions.ts:689` | `'创建成功，但激活失败：' + (ar.error \|\| '—')` | `.ws-fs-status` |
| D31 | `src/ui/sessions.ts:700` | `'创建成功，但激活失败：' + (err instanceof Error ? err.message : String(err))` | `.ws-fs-status` |
| D32 | `src/ui/sessions.ts:707` | `'创建失败：' + (err instanceof Error ? err.message : String(err))` | `.ws-fs-status` |
| D33 | `src/ui/sessions.ts:779` | `'文件浏览暂不可用（' + (err instanceof Error ? err.message : String(err)) + '）· 请直接在下方输入路径'` | `.ws-fs-status` |
| D34 | `src/ui/sessions.ts:789` | `'浏览失败：' + r.error` | `.ws-fs-status` |
| D35 | `src/ui/sessions.ts:854` | `'注册失败：' + (r.error \|\| '—')` | `.ws-fs-status` |
| D36 | `src/ui/sessions.ts:865` | `'注册失败：' + (err instanceof Error ? err.message : String(err))` | `.ws-fs-status` |
| D37 | `src/ui/restore.ts:226` | `'历史恢复暂不可用（' + (err instanceof Error ? err.message : String(err)) + '）'` | 消息流 `.restore-note` |

> 说明：这些落点的**前缀本身**已经是用户语言（"保存失败：""删除失败："），问题在于后缀。修源头后后缀变成固定短语即可；若某些场景需要更具体的原因，应在 `api.ts` 里按状态码/错误类别映射成**有限的用户短语**，而不是透传原文。

---

## 5. 分组 E · 附加发现（超出 `src/**`，但同一 dist）

| # | 文件:行 | 原文（逐字） | 渲染位置 | 判定 | 建议文案 |
|---|---|---|---|---|---|
| E1 | `index.html:59` | `<div id="statusline" class="statusline" title="上下文占用 · 模型 · 思考强度 · 吞吐 · 缓存命中（GET /api/status + SSE 增量）">` | `#statusline` 的**初始** `title`（JS 加载后被 `statusline.ts:77` 覆盖，但加载前/JS 失败时可见） | 删除 | 与 A4 同步删除括号内容 |

**另发现一处非文案但同源的开发者内容**（不在清单内，登记备查）：`apps/studio/src/static.ts:36-41` 的 `HINT_PAGE`
（`frontend/dist is missing — build the frontend first (pnpm build in frontend/).` / `The HTTP API is available at /api/*.`）
是构建缺失时的兜底页。它对**运维**有用，对**终端用户**是技术文案——建议保留但明确标注它是"部署自检页"，或改成部署文档链接。

---

## 6. 明确排除项（刻意保留 / 不算文案）

### 6.1 结构性排除

| 类别 | 示例 | 理由 |
|---|---|---|
| 纯注释 | `chat.ts:2-4`、`types.ts:3-7` 的全部 JSDoc、`statusline.ts:2-8`（含 `GET /api/status`/`SSE`/`409`）、`ui/restore.ts:92`（`不落盘`） | 注释不渲染；注释里怎么写都不影响用户 |
| `api.ts` 的 35 条 URL 常量 + `sse.ts:67` 的 `'/api/events'` 默认参数 | `requestJson('/api/config')` 等（逐条确认均为 `fetch`/`EventSource` 的第 1 入参） | 仅代码用，不拼进任何用户可见字符串 |
| `console.warn` 参数 | `chat.ts:199/206/213/220/227/235/243/250`、`sse.ts:95/115` | 开发者控制台，非 UI |
| CSS | `src/styles/*.css` | 超出审计范围 |
| 动态用户数据 | 工具参数/结果 JSON、模型名、会话标题、提示词正文 | 是数据不是文案 |

### 6.2 刻意保留（**不要动**）

| 文案 | 位置 | 为什么保留 |
|---|---|---|
| `'不会从后端读取明文'` / `'后端不会回传密钥'` 的**安全语义** | `ui/config.ts:100`、`:101` | "只写不读"的安全承诺，用户需要知道。**改写时必须原样保留该承诺**，只去掉"热调/后端"字样（见 B6/B7） |
| `'未找到活跃会话 · 发送第一条消息后自动建立'` | `ui/restore.ts:306` | 可操作指引 |
| `'在下方输入消息开始对话 · Enter 发送 · Shift+Enter 换行'` | `ui/messages.ts:90` | 上手指引 |
| `'轮次进行中，请稍后重试'` / `'轮次进行中，将在本轮结束后生效'` | `ui/sessions.ts:188`、`statusline.ts:298` | 用户可理解的时机约束（本来就没有 `409` 字样） |
| `'请勾选要添加的模型（默认不勾选；已存在的模型不可重复添加）'` | `ui/providers.ts:706` | 可操作指引 |
| 表单校验指引 | `ui/providers.ts:601`、`ui/sessions.ts:843/639`、`ui/prompts.ts:228` | 例如 `请先选择/输入目录路径`、`标题不能为空` |
| `'思考已折叠，点击展开'` / `'（无结果记录）'` / `'工具结果（无对应调用记录）：…'` | `ui/messages.ts:274`、`ui/restore.ts:191/148/246` | 交互说明与数据完整性提示 |
| `'✓ 延迟 Nms · 模型数 M'` | `ui/providers.ts:586` | 连接测试结果，用户可理解 |
| 状态徽章 | `ui/providers.ts:64-65`、`ui/prompts.ts:68/72`、`statusline.ts:278` | `已配 Key` / `默认` / `活跃` / `当前`——用户概念 |
| 会话结构说明 | `ui/restore.ts:238/252/266`、`ui/rail.ts:159/249` | `以下为本次会话` / `更早的历史已折叠 · 仅显示最近 200 条` / `更早的 N 轮已折叠` |
| 提示词变量帮助表（9 条） | `ui/prompts.ts:19-29` | `{{model}}` → `当前模型` 等，本就是给用户看的 |
| 选项文案 | `ui/sessions.ts:532/553/575/725`、`ui/sessions.ts:590-608` | `root（默认工作区）` / `跟随默认` / `（暂无可选模型）` / `选中目录即注册该目录为工作区（名称 = 文件夹名）` |
| 纯 UI 文案 | `theme.ts:52`、`ui/sidebar.ts:51-52`、`ui/confirm.ts:28/30` | `主题 · …` / `展开·收起左侧面板` / `确认`·`取消` |
| `token` 作为用户可理解单位 | `ui/config.ts:104/108`、`ui/providers.ts:449` | `默认 1M（1000000 tokens）`、`最大输出 tokens`——上下文窗口/输出上限的标准单位（**例外**：`statusline.ts:400-408` 的 `prompt_tokens`/`cache_read` 字段名属实现口径，已列为 A11） |

---

## 7. 执行建议（按性价比排序）

1. **先修 3 处源头**（`api.ts:49/63/64`）→ 一次性解决分组 D 的 37 处泄漏，改动最小、收益最大。
2. **再清分组 A 的 17 条**：端点/HTTP 码是"绝不该出现"的一类，且大多在设置页与状态栏这种高曝光位置。
3. **分组 B/C 的 34 条**：属"改写"性质，可批量做，但需逐条确认用户语言是否准确（尤其 B6/B7 的安全语义必须保留）。
4. **同步改 `index.html:59`**（E1），否则状态栏在 JS 加载前仍会闪出端点字样。
5. 改完后建议在 CI 加一条**正则门禁**（例如禁止在 `src/**` 的**非注释行字符串字面量**里出现 `/api/`、`SSE`、`HTTP `、`409`、`jsonl`、`热调`、`后端`、`前端`、`接口`、`modified`、`ev:`、`lagged`、`available.models`、`cache_read`、`prompt_tokens`）——这类文案会不断被新功能带回来，靠人工 review 不可靠。（本仓库前端无测试基建，可加在 `pnpm check` 的脚本里。）
