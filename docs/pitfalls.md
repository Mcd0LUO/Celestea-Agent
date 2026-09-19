# Celestea Studio · 踩坑档案

> 状态：**当前**。踩坑档案：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证；每条来自真实修复。页内 W781 之前的路径以当时布局读。

> 📦 **W781（2026-09-14）**：旧前端仓 Celestea-Studio（并入前位于同级的 `celestea_studio` 目录）已全量并入本仓，前端 = `apps/web/`，
> 运行数据迁到 `/var/lib/celestea-agent/`。本页所述路径以**并入前**的旧两仓布局为准（历史参考），
> 现役口径见 [`README.md`](./README-frontend.md) 与 [`../README.md`](../README.md)。


> **每条都来自真实修复**（见 git log 的 `fix(studio): ...` 提交）。改相关代码之前先读对应条目。
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
| P8 | 主题与版本号 | 只有 `mono`；版本号 W887 起由 git tag 构建期派生 |
| P9 | 前端渲染铁律 | 见 `apps/web/FRONTEND-RULES.md` |
| P10 | session id 编码 | 路径参数必须 `%2F` |
| P11 | `/api/clear` | 无备份、无 409 守卫 |
| P12 | 重绑失败的回滚边界 | compact 不回滚日志；activate 不回滚 env |
| P13 | 全局 env 竞争 | `CELESTEA_SESSION_DIR` 是进程级，部分路径不互斥（UNCLEAR） |

---

## P1 · 提供商身份：`id` 是身份，`name` 只是显示名

**症状**：在设置页改了一个已有提供商的名称后保存，列表里出现**两条同名网关**（一条旧 id、一条按新名称派生的新 id），模型也重复。

**根因**：后端 `POST /api/providers` 按 `id` upsert（`src/providers.rs:141-148`、`679-698`）。编辑器如果拿**名称**当 id 提交，就等于新建了一条记录。这正是"同名两条网关"的根因。

**正确做法**：编辑既有记录时必须沿用原始 `id`。前端在编辑器里保存了 `originalId`，只在新建时才由名称派生：

```ts
// frontend/src/ui/providers.ts:244-247, 275, 548
originalId?: string;                      // 编辑既有记录时 = p.id；新建 = undefined
id: e.originalId ?? e.name.value.trim()   // 提交时优先用原 id
originalId: p?.id                         // 打开编辑器时记录
```
后端侧只保证"`name` 缺省/空 → 回退为 `id`"（`src/providers.rs:369-375`），**不**做名称去重。

**验证**：`frontend/src/ui/providers.ts` 里改名的路径必须命中 `originalId`；后端测试 `upsert_creates_updates_and_keeps_key_when_absent`（`src/providers.rs:860`）。

**修复提交**：`ce13712`。

---

## P1b · provider 部分更新会清空字段（真陷阱）

**症状**：用 curl 只发 `{"id":"x","base_url":"...","api_key":"..."}` 更新一个已有 provider，结果它的 `models` 全没了、`note` 被清空、`request_format` 从 `anthropic_messages` 变回 `chat_completions`。

**根因**：`provider_from_req` 只对 `api_key` 做了"缺省保留"，其余可选字段缺省时是**重置**语义（`src/providers.rs:351-358`、`376-381`）。源码注释（`src/providers.rs:338-340`）写的是"每个出现的字段生效"，与实现不符。

**正确做法**：做部分更新时**带上所有要保留的字段**；前端编辑器本来每次都发全字段，所以只有手写 curl / 新客户端会踩。

**验证**：`src/providers.rs:860` 的 upsert 测试。

---

## P2 · 无 key 的同源 provider 借用引擎 key

**症状**：`providers.json` 里有一条指向**引擎自己网关**的记录（比如 `http://127.0.0.1:3001/v1`）但没填 key，点"测试"报"未配置 api_key"，可引擎明明能用。

**根因**：探测上游 `/models` 需要 Authorization，而该记录没有 key。

**正确做法（已实现）**：若 `base_url` 归一化（`trim()` + 去掉所有尾部 `/`）后**等于当前代际的 `gen.base_url`**，则借用引擎自己的 key（`resolve_api_key(&gen.profile)` → `env[api_key_env]` 再 `api_key_file`）。**借用是请求级的**：

- 绝不写入 `providers.json`（测试断言磁盘里 `api_key == None` 且不含引擎 key）；
- 绝不出现在任何响应体；
- 绝不打日志。

只有两条路径借用：`POST /api/providers/test` 与 `POST /api/providers/{id}/models/fetch`。`apply_default_model` / `apply_startup_default` **不借用**（只用 provider 自己的 key）。非同源无 key → 仍然报 `该提供商未配置 api_key` 且**不发请求**。

**代码位置**：`base_url_identity` / `engine_self_key` / `probe_key`（`src/providers.rs:523-553`），测试 `1179`、`1226`、`1250`、`1281`。

**修复提交**：`222a390`。

---

## P3 · 获取模型流程：先保存 → 拉上游 → 二级勾选

**症状（旧）**：点"获取模型"直接 400 `each model needs a non-empty id`；或者获取回来的模型被自动勾上、把用户原有配置冲掉。

**根因与约定**：

1. **先保存表单**再拉上游——`models/fetch` 是按 `{id}` 读**已落盘**的记录（`src/providers.rs:741-776`），不落盘就查不到 provider（404 `unknown provider`）；
2. 上游返回的模型 id 列表进**二级勾选窗**，**默认一个都不勾**，用户确认后才写进表单的模型行；
3. 前端 `buildPayload` **跳过完全空白的模型行**（点了「+ 添加模型」但没填 id/名称的行），否则保存/获取模型会被后端 400 拒绝；
4. **后端不跳过**空行——它整请求失败（`src/providers.rs:314-320` 的 `each model needs a non-empty id`）。所以"跳过"是前端责任。

**代码位置**：`frontend/src/ui/providers.ts:262-263`（空行过滤）、`frontend/src/ui/providers.ts` 的获取模型二级窗；后端 `build_models`（`src/providers.rs:314-336`）。

**修复提交**：`be77eab`、`9bf129b`。

---

## P4 · 数值字段支持 `k`/`m` 后缀（前端糖）

**症状**：填 `1m` 保存上下文窗口，后端 400 或值变成 1。

**根因**：后端 `context_window` / `max_output_tokens` 是 `Option<u64>`，只接受 JSON number。

**正确做法**：后缀解析在**前端** `numOrNull`（`frontend/src/ui/providers.ts:285-296`）：小写化 + 去空白，正则 `^(\d+(?:\.\d+)?)([km])?$`，`k = ×1000`、`m = ×1_000_000`，`Math.round`；非法/负数 → `null`（即"留空 = 不限制"）。占位符示例：`1000000 / 1m / 128k`。

**修复提交**：`ce13712`。

---

## P5 · `reasoning_effort` 是自由字符串，不得折叠或重命名

**症状（旧）**：用户选 `max`，实际发出去变成 `high`；自定义档位（比如 `xhigh`）被吞掉。

**根因**：早期 `parse_effort` 把 `max` 映射成引擎的 `High`，并只认固定枚举。

**正确做法**：`parse_effort` 现在是**原样透传**——只有空串 / `"off"`（大小写不敏感）表示清除，其他值 verbatim 送给上游（`src/api.rs:207-216`）。前端「+」内联输入可以新增任意自定义档位；`AVAILABLE_EFFORTS = ["low","high","max"]` 只是**建议清单**，不是白名单。

**验证**：`POST /api/config {"reasoning_effort":"max"}` 后 `GET /api/config` 必须回 `"max"`。

**代码位置**：`src/api.rs:207-216`、`src/main.rs:124`、`src/providers.rs:52-62`（`reasoning_efforts: Vec<String>`，后端无枚举校验）。

**修复提交**：`070ecf9`、`6f08543`。

> 注意：仍有一条**推理能力**校验——给已知的**非推理模型**配 effort 会 400（`src/api.rs:272-285`）；未知 id 视为可推理。

---

## P6 · `/compact` 上下文压缩

**契约**（`src/compact.rs:1-27`、`400-519`）：

1. **409 守卫**：`claim_compact_slot` 抢 `AppState.busy`，占用时 `{"ok":false,"error":"turn 进行中，无法压缩"}`。与 `POST /api/turn` / activate / rename 共用同一把锁。
2. **阈值**：完整 assistant 轮数 `<= COMPACT_THRESHOLD = 8` → 200 `{"ok":true,"compacted":false,"note":"历史不足，无需压缩"}`（无 `kept_turns`）。
3. **摘要轮**：`COMPACT_SYSTEM_PROMPT` 四段式摘要（正在进行的任务 / 已做的决策 / 关键事实与文件改动 / 待办），输入是截断后的 transcript（`SUMMARY_INPUT_MAX_CHARS = 60_000`，保留尾部），`POST {gen.base_url}/chat/completions`，`max_tokens=4096`、`temperature=0.3`、非流式、90s 超时；摘要模型取 `session.json` 的 model（缺省用当前代际 model）；**所有错误串经 `redact` 抹掉 api key**。
4. **重编号**：新日志 = 合成压缩轮（`turn-1`）+ 最近 **K = 4** 个完整轮（`turn-2 .. turn-5`），只改 `turn_start`/`turn_end` 的 id，其余事件与 `outcome` 原样；未闭合尾轮与首个 `turn_start` 之前的事件丢弃。用引擎原生 `turn-<n>` 前缀，避免重放后撞号。
5. **原子写 + 备份**：旧文件先复制成 `cli-main.jsonl.precompact`（单副本、覆盖式）→ 写 `cli-main.jsonl.tmp-<pid>` + `sync_all` → `rename` 原子替换。
6. **引擎重绑**：若压缩的是活动会话 → `set_var("CELESTEA_SESSION_DIR", dir)` → `prepare_gen` → `swap_gen`（非活动会话不重绑，下次激活/启动自然重放）。
7. **SSE**：广播 `event: compact`，payload `{"session","kept_turns","note","rebound"}`。

**踩坑点**：
- **重绑失败不回滚日志**：`rewrite_atomic` 成功之后才做重绑，之后的 400/500 会保留已压缩的日志，唯一恢复途径是 `.precompact`（`src/compact.rs:441-476`）；
- `.precompact` **从不自动清理**；
- 摘要失败时**不要**把 api key 带进错误串（已有 `redact`，别绕过它）。

**修复提交**：`37db3b0`。

---

## P7 · SSE 信封的 `turn` 字段必须一起传

**症状**：前端拿到的 SSE 事件里 `turn` 一直是 `undefined`，多轮并发时事件串轮。

**根因**：后端事件 `data` 是信封 `{"turn","seq","payload"}`（`src/main.rs:644-659`）；如果前端（或某个转发层）只把 `payload` 发出去，`turn` 就丢了。

**正确做法**：`sse.ts` 解析时保留信封，把 `payload` 派发给业务处理器、把 `turn`/`seq` 交给状态层（`frontend/src/sse.ts:1-6`、`68-78`）。新增任何转发/封装都不得只透传 `payload`。

**验证**：`curl -N /api/events` 看每个事件都带 `"turn"`。

---

## P8 · 主题与版本号

- **只有 `mono` 单主题**（黑白）：`THEMES` 只有一个元素，`night` 已删除；`localStorage` 里残留的旧主题 id 会自动回落到 `mono`（`frontend/src/theme.ts:1-14`、`44-52`）。新增主题要同时改 `THEMES` 与 CSS `[data-theme]` 块。
- **版本号（W887 起自动派生）**：真源是 git tag，构建期由 `scripts/version.mjs` 派生后经 vite `define` 注入 `apps/web/src/version.ts`（无 git / 无 tag 回落 `apps/web/package.json`）。**不要再往 `version.ts` 写版本字面量**——`tests/w887-version.test.ts` 会机械失败；`pnpm version:sync` 同步 `package.json`。

**修复提交**：`ddaa3f8`、`7ed60c7`。

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

**验收口径**：出现"空白帧 / 整树闪动 / 旧结果覆盖新状态"任一现象即不合格；`pnpm build`（`tsc --noEmit` strict + `vite build`）必须通过；后端契约未就绪允许优雅降级，但不允许把"加载中…"占位整区替换当常规路径。

---

## P10 · session id 里的 `/` 必须 `%2F` 编码

**症状**：`GET /api/sessions/server-center/my-session/messages` → 404 / 路由不匹配。

**根因**：session id 是 `"<workspace>/<session>"`，而路由的 `{id}` 是**单段**路径参数；未编码的 `/` 会被当成路径分隔符。

**正确做法**：路径里 `encodeURIComponent(id)`（`frontend/src/api.ts:90,111,117,121,123,126,129`），路由层会自动解码回带斜杠的值（`src/main.rs:1345-1348` 有注释）。`curl` 里同样要写 `%2F`。

---

## P11 · `/api/clear` 无备份、无 409 守卫

**事实**：`POST /api/clear` 直接调用 `gen.runtime.session.clear()`（对 `PersistentSessionLog` 是截断 `cli-main.jsonl` + 清内存 + 轮号归零），**没有** busy 409 守卫、**没有**备份、**不**动 `session.json`、**不**影响 worker 会话（`src/workspaces.rs:1506-1511`）。

**正确做法**：把它当"破坏性操作"——前端已有二次确认；API 使用者（脚本、e2e）在生产实例上**不要**调它。要清空历史又保留回滚，先手工 `cp cli-main.jsonl cli-main.jsonl.bak`。

---

## P12 · 重绑失败的回滚边界（两处不对称）

| 路径 | 顺序 | 失败后 |
|---|---|---|
| `POST /api/sessions/{id}/compact` | 先原子重写日志 → 再重绑引擎 | 重绑失败（400/500）**日志保持压缩后状态**，只有 `.precompact` 能回滚（`src/compact.rs:441-476`） |
| `POST /api/sessions/{id}/activate` | 先 `set_var(CELESTEA_SESSION_DIR)` → 再 compose | compose 失败时 **env 已被改写且不回滚**（`src/workspaces.rs:1353-1359`） |
| session / workspace rename | 先移目录 → 再 compose → 再持久化 | 失败会**回滚目录移动与 env**（`src/workspaces.rs:1411-1429`、`921-940`） |

新增任何"换绑"路径时，明确写出失败回滚语义，并加测试。

---

## P13 · `CELESTEA_SESSION_DIR` 是进程级全局 env（UNCLEAR，待收敛）

`CELESTEA_SESSION_DIR` 由 activate / session-rename / workspace-rename / compact 直接 `std::env::set_var`（`src/workspaces.rs:1353`、`1410`、`920`；`src/compact.rs:467`）。互斥只靠 busy 槽，而 busy 锁的获取是**有条件**的：

- activate：恒取；
- session rename：仅当目标是 active 会话时取；
- workspace rename：仅当 active 会话属于该工作区时取；
- compact：恒取。

因此**理论上**存在并发场景下 env 竞争（例如同时 rename 一个非 active 会话与 compact 另一个会话）。`TODO`：无测试覆盖，也未见事故报告——若后续要支持多实例/并发写，应把 `CELESTEA_SESSION_DIR` 收敛为 compose 参数而不是进程 env。

---

## 附：容易误记的几件事

| 误记 | 事实 |
|---|---|
| `GET /api/health` 的 `bind` 是实际绑定地址 | 是**常量** `DEFAULT_BIND`，不随 `STUDIO_BIND` 变（`src/main.rs:867`） |
| 前端监听的 `context` 事件 | 后端**从不发送**（`frontend/src/sse.ts:34-43` 是死监听） |
| `docs/DEVELOPMENT.md` 的 SSE 清单来自 `main.rs` 头部注释 | 那份注释**过期**（漏 `turn_end`/`compact`），以代码为准 |
| `POST /api/clear` 会清空 worker 会话 | 不会，只清当前代际绑定的活动会话 |
| `GET /api/fs/browse` 受 `CELESTEA_TOOL_ROOTS` 限制 | **不受**；`roots` 字段只是建议起点（`src/workspaces.rs:111-113`） |
| 改 `frontend/src/**` 要重启后端 | **不用**，`pnpm build` 即可（`get_static` 每次读磁盘） |
