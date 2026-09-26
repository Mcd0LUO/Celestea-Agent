# Celestea Studio · 踩坑档案

> 状态：**当前**。踩坑档案：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证；每条来自真实修复。

> **W1518 清理说明**：本页原先的条目大多描述**已退役的 Rust 后端**（`src/providers.rs` /
> `src/workspaces.rs` / `src/compact.rs` …）。W1518 逐条复核了每一条在现役 TypeScript 实现
> （`apps/studio/src/**`、`apps/web/src/**`、`packages/**`）里是否仍然成立：
> **行为仍存在的条目保留下来，并把 `file:line` 换成 TS 的真源**；只有退役后端才有的条目已删除。
> 判定口径见 [`feature-docs-drift-cleanup.md`](./feature-docs-drift-cleanup.md) §3；逐条证据在 W1518 交付报告里。

> **每条都来自真实修复**。改相关代码之前先读对应条目。
> 格式：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证。

## 索引

| # | 主题 | 关键结论 |
|---|---|---|
| P1 | 提供商身份 | `id` 是身份，`name` 只是显示名 |
| P1b | provider 部分更新 | 只有 `api_key` 缺省保留，`models`/`note`/`request_format` 缺省会清空 |
| P2 | keyless 同源借用引擎 key | 请求级、不落盘、不回显 |
| P3 | 获取模型流程 | 先保存 → 拉上游 → 二级勾选（默认不勾） |
| P4 | 数值字段 `k`/`m` | 前端输入糖；后端只收 number |
| P5 | `reasoning_effort` | 自由字符串，不得折叠/重命名 |
| P6 | `/compact` | 409 守卫 + K=4 重编号 + 原子写 + 重绑 |
| P7 | SSE 信封 `turn` | 只发 payload 会丢 `turn` |
| P8 | 主题与版本号 | 主题是 `mono` + `dark`；版本号由 git tag 构建期派生 |
| P9 | 前端渲染铁律 | 见 `apps/web/FRONTEND-RULES.md` |
| P10 | session id 编码 | 路径参数必须 `%2F` |
| P11 | `/api/clear` | 有 409 守卫、**无**备份 |
| P12 | 重绑失败的回滚边界 | compact 不回滚日志；rename 会回滚目录移动 |

---

## P1 · 提供商身份：`id` 是身份，`name` 只是显示名

**症状**：在设置页改了一个已有提供商的名称后保存，列表里出现**两条同名网关**（一条旧 id、一条按新名称派生的新 id），模型也重复。

**根因**：后端 `POST /api/providers` 按 `id` upsert（`apps/studio/src/store/providers.ts:241`）。编辑器如果拿**名称**当 id 提交，就等于新建了一条记录。这正是"同名两条网关"的根因。

**正确做法**：编辑既有记录时必须沿用原始 `id`。前端在编辑器里保存了 `originalId`，只在新建时才由名称派生：

```ts
// apps/web/src/ui/providers/form.ts:36, 130；类型见 apps/web/src/ui/providers/types.ts:53
id: e.originalId ?? e.name.value.trim(),   // 提交时优先用原 id
originalId: p?.id                          // 打开编辑器时记录
```

后端侧只保证"`name` 缺省/空 → 回退为 `id`"（`apps/studio/src/store/providers.ts:246`），**不**做名称去重。

**验证**：`apps/web/src/ui/providers/form.ts` 里改名的路径必须命中 `originalId`；后端测试见 `apps/studio/src/store/providers.test.ts`。

---

## P1b · provider 部分更新会清空字段（真陷阱）

**症状**：用 curl 只发 `{"id":"x","base_url":"...","api_key":"..."}` 更新一个已有 provider，结果它的 `models` 全没了、`note` 被清空、`request_format` 从 `anthropic_messages` 变回 `chat_completions`。

**根因**：`api_key` 是**唯一**的"缺省保留"字段，其余可选字段缺省时是**重置**语义（`apps/studio/src/store/providers.ts:12-15` 的注释即契约正文；实现在同文件 `upsert()`）。

**正确做法**：做部分更新时**带上所有要保留的字段**；前端编辑器本来每次都发全字段，所以只有手写 curl / 新客户端会踩。

**另一面（W815-7）**：`models` **存在但类型不对**（不是数组）必须是 400，不能当成 `undefined` —— 后者会被 store 读成"缺省"从而**清空**列表（`apps/studio/src/handlers/providers.ts:58-63`）。

**验证**：`apps/studio/src/store/providers.test.ts` 的 upsert 用例。

---

## P2 · 无 key 的同源 provider 借用引擎 key

**症状**：`providers.json` 里有一条指向**引擎自己网关**的记录（比如 `http://127.0.0.1:3001/v1`）但没填 key，点"测试"报"未配置 api_key"，可引擎明明能用。

**根因**：探测上游 `/models` 需要 Authorization，而该记录没有 key。

**正确做法（已实现）**：若 `base_url` 归一化后**等于当前代际的 `base_url`**，则借用引擎自己的 key。**借用是请求级的**：

- 绝不写入 `providers.json`；
- 绝不出现在任何响应体；
- 绝不打日志。

实现在 `apps/studio/src/store/provider-probe.ts:105-112`（`resolveProbeKey`：先用 provider 自己的 key，同源且引擎 key 非空才借用）。引擎 key 的读取口在 `apps/studio/src/handlers/providers.ts:22`。非同源无 key → 仍然报 `该提供商未配置 api_key` 且**不发请求**。

**验证**：`apps/studio/src/provider-probe-ssrf.test.ts` 与 `apps/studio/src/store/providers.test.ts`。

---

## P3 · 获取模型流程：先保存 → 拉上游 → 二级勾选

**症状（旧）**：点"获取模型"直接 400 `each model needs a non-empty id`；或者获取回来的模型被自动勾上、把用户原有配置冲掉。

**根因与约定**：

1. **先保存表单**再拉上游——`models/fetch` 是按 `{id}` 读**已落盘**的记录，不落盘就查不到 provider（404 `unknown provider`，`apps/studio/src/handlers/providers.ts:110-113`）；
2. 上游返回的模型 id 列表进**二级勾选窗**，**默认一个都不勾**，用户确认后才写进表单的模型行；
3. 前端 `buildPayload` **跳过完全空白的模型行**（点了「+ 添加模型」但没填 id/名称的行），否则保存/获取模型会被后端 400 拒绝（`apps/web/src/ui/providers/form.ts:23-24`）；
4. **后端不跳过**空行——它整请求失败。所以"跳过"是前端责任。

**竞态**：连点「获取模型」时晚到的旧响应必须丢弃（`apps/web/src/ui/providers/form.ts:196-246` 的 `fetchSeq` 守卫，铁律 3）。

---

## P4 · 数值字段支持 `k`/`m` 后缀（前端糖）

**症状**：填 `1m` 保存上下文窗口，后端 400 或值变成 1。

**根因**：后端 `context_window` / `max_output_tokens` 只接受 JSON number。

**正确做法**：后缀解析在**前端** `numOrNull`（`apps/web/src/ui/providers/form.ts:46-58`）：小写化 + 去空白，正则 `^(\d+(?:\.\d+)?)([km])?$`，`k = ×1000`、`m = ×1_000_000`，`Math.round`；非法/负数 → `null`（即"留空 = 不限制"）。调用点在同文件 `:30-31`。

---

## P5 · `reasoning_effort` 是自由字符串，不得折叠或重命名

**症状（旧）**：用户选 `max`，实际发出去变成 `high`；自定义档位（比如 `xhigh`）被吞掉。

**根因**：早期实现把 `max` 映射成固定档位，并只认固定枚举。

**正确做法**：现在是**原样透传**——只有空串 / `"off"`（大小写不敏感）表示清除，其他值 verbatim 送给上游（`apps/studio/src/handlers/config.ts:37-42`）。前端「+」内联输入可以新增任意自定义档位。

**验证**：`POST /api/config {"reasoning_effort":"max"}` 后 `GET /api/config` 必须回 `"max"`。

> 注意：仍有一条**推理能力**校验——给已知的**非推理模型**配 effort 会 400（`apps/studio/src/handlers/config.ts:95-96`，判定见同文件 `:147`：`reasoning_efforts` 非空才算可推理）；未知 id 视为可推理。

---

## P6 · `/compact` 上下文压缩

**契约**（常量真源 `packages/runtime/src/compact/plan.ts`；重写真源 `packages/runtime/src/compact/rewrite.ts`）：

1. **409 守卫**：turn 进行中时 `POST /api/sessions/{id}/compact` 返回 409（与 `/api/turn` / activate / rename 共用 busy 槽；`contracts/endpoints.json` 的 `post_session_compact` 记有 `singleConcurrency`）。
2. **阈值**：完整 assistant 轮数 `<= COMPACT_THRESHOLD`（`packages/runtime/src/compact/plan.ts:22`，= 8）→ 200 `{"ok":true,"compacted":false,...}`（无 `kept_turns`）。
3. **摘要轮**：四段式摘要（正在进行的任务 / 已做的决策 / 关键事实与文件改动 / 待办），输入是截断后的 transcript（保留尾部），**所有错误串经 `redact` 抹掉 api key**。
4. **重编号**：新日志 = 合成压缩轮 + 最近 **K = 4** 个完整轮（`packages/runtime/src/compact/plan.ts:24` 的 `COMPACT_KEEP_TURNS`），只改 `turn_start`/`turn_end` 的 id，其余事件与 `outcome` 原样。
5. **原子写 + 备份**：旧文件先复制成 `cli-main.jsonl.precompact`（单副本、覆盖式，`packages/runtime/src/compact/rewrite.ts:21` 的 `COMPACT_BACKUP_FILE`）→ 写同目录临时文件 → `rename` 原子替换（同目录，避免跨设备）。
6. **引擎重绑**：压缩的是活动会话时，实例先被**驱逐**、压缩后再重新 compose（`apps/studio/src/runtime/session-lifecycle.ts:10-13`）；非活动会话不重绑，下次激活/启动自然重放。
7. **SSE**：广播 `event: compact`（`contracts/sse-events.json`）。

**踩坑点**：
- **重绑失败不回滚日志**：重写成功之后才做重绑，之后的失败会保留已压缩的日志，唯一恢复途径是 `.precompact`；
- `.precompact` **从不自动清理**；
- 摘要失败时**不要**把 api key 带进错误串（已有 `redact`，别绕过它）；
- **有活跃 worker 工作的会话会被 pin，压缩直接跳过**（`apps/studio/src/runtime/session-lifecycle.ts:29-36` 的 `PINNED_NOTE`）。

---

## P7 · SSE 信封的 `turn` 字段必须一起传

**症状**：前端拿到的 SSE 事件里 `turn` 一直是 `undefined`，多轮并发时事件串轮。

**根因**：服务端事件 `data` 是信封 `{v:2, session, turn, seq, payload}`（`apps/studio/src/sse.ts:5-9`）；如果前端（或某个转发层）只把 `payload` 发出去，`turn` 就丢了。

**正确做法**：`apps/web/src/sse.ts` 解析时保留信封，把 `payload` 派发给业务处理器、把 `turn`/`seq` **合并进** payload（`withEnvelope`，同文件 `:39-53`）而不丢任何 payload 字段。新增任何转发/封装都不得只透传 `payload`。

**验证**：`curl -N /api/events` 看每个事件都带 `"turn"`。

---

## P8 · 主题与版本号

- **主题**：`apps/web/src/theme.ts:15-22` 的 `themes()` 是**两个**主题 —— `mono`（黑白）与 `dark`（深色，只覆盖 static/alias token，见 `apps/web/src/styles/tokens.css`，组件零改动）。新增主题要同时改 `themes()` 与 CSS `[data-theme]` 块；`localStorage` 里的未知主题 id 会回落。
- **版本号（W887 起自动派生）**：真源是 git tag，构建期由 `scripts/version.mjs` 派生后经 vite 注入 `window.__CELESTEA_BUILD__`，由 `apps/web/src/version.ts` 读取（读不到一律回落 `'dev'/0/''/false`）。**不要再往 `version.ts` 写版本字面量**——`tests/w887-version.test.ts` 会机械失败；`pnpm version:sync` 同步 `package.json`。

---

## P9 · 前端渲染铁律（验收硬性标准）

权威正文：[`apps/web/FRONTEND-RULES.md`](../apps/web/FRONTEND-RULES.md)。核心 8 条：

1. **禁止"先清空后加载"**：离屏构建 + 单次 `replaceChildren`，旧内容可见到新内容就绪；
2. 树/列表刷新**禁止整树 `innerHTML` 重建**，要增量或双缓冲 + 恢复展开态与焦点；
3. 切换类操作**必须防竞态**（`seq` 递增 + 返回时校验），晚到的旧结果丢弃；
4. 折叠/展开只切 class + CSS transition，不重建 DOM；
5. 弹窗开关**不得**触发背景视图重渲染；
6. 轮询只做局部更新；
7. 设置页 pane 切换零重建（首次加载后缓存）；
8. 新增 UI 一律沿用本套纪律。

**验收口径**：出现"空白帧 / 整树闪动 / 旧结果覆盖新状态"任一现象即不合格。

---

## P10 · session id 里的 `/` 必须 `%2F` 编码

**症状**：`GET /api/sessions/server-center/my-session/messages` → 404 / 路由不匹配。

**根因**：session id 是 `"<workspace>/<session>"`，而路由的 `{id}` 是**单段**路径参数；未编码的 `/` 会被当成路径分隔符。

**正确做法**：路径里 `encodeURIComponent(id)`（`apps/web/src/api.ts:191`、`:197`、`:241` 等），路由层会自动解码回带斜杠的值。`curl` 里同样要写 `%2F`。

---

## P11 · `/api/clear` 无备份（但有 409 守卫）

**事实**：`POST /api/clear` 清空目标会话日志 + 轮号归零。

- **有** busy 409 守卫：turn 进行中时返回 409 `a turn is already running`，且**不会**截断在飞轮次的日志（`apps/studio/src/handlers/dialog.ts:272-289`；测试 `apps/studio/src/runtime/turnbusy-identity.test.ts`）。
- **没有**备份；**不**动 `session.json`；**不**影响 worker 会话（`apps/studio/src/runtime/session-lifecycle.ts:46-53` 只清目标那一个实例）。

**正确做法**：把它当"破坏性操作"——前端已有二次确认；API 使用者（脚本、e2e）在生产实例上**不要**调它。要清空历史又保留回滚，先手工 `cp cli-main.jsonl cli-main.jsonl.bak`。

---

## P12 · 重绑失败的回滚边界

| 路径 | 顺序 | 失败后 |
|---|---|---|
| `POST /api/sessions/{id}/compact` | 先原子重写日志 → 再重绑引擎 | 重绑失败**日志保持压缩后状态**，只有 `.precompact` 能回滚（`packages/runtime/src/compact/rewrite.ts:21`） |
| session / workspace rename | 先移目录 → 再写 `session.json` 的 title | 写 title 失败会**回滚目录移动**（`apps/studio/src/store/session-ops.ts:78-89`）；回滚本身再失败才报 `rollback failed` |

新增任何"换绑"路径时，明确写出失败回滚语义，并加测试。

---

## 附：容易误记的几件事

| 误记 | 事实 |
|---|---|
| `GET /api/health` 的 `bind` 是常量 | 是**实际监听地址**：服务起监听后回写，跟随 `--bind`/`--port`（`--port 0` 报真实端口）；仅在无服务器的组合（测试）里才停留在 `DEFAULT_BIND`（`apps/studio/src/handlers/health.ts:4-8`） |
| `POST /api/clear` 会清空 worker 会话 | 不会，只清目标那一个实例（`apps/studio/src/runtime/session-lifecycle.ts:46-53`） |
| `GET /api/fs/browse` 受 `CELESTEA_TOOL_ROOTS` 限制 | **不受**；`roots` 字段只是建议起点（`apps/studio/src/handlers/fs.ts:19`） |
| 改 `apps/web/src/**` 要重启后端 | **不用**，`pnpm build` 即可（静态资源每次读磁盘，`apps/studio/src/static.ts:99`） |
| 前端还在监听 `context` 事件 | 不再监听：`context` 不可发射，已从 `EVENT_NAMES` 移除，并有门禁 `apps/web/tools/check-sse-events.mjs` 盯着（`apps/web/src/sse.ts:63-79`） |
