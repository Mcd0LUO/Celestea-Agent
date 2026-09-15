# celestea_studio-ts · `docs/` 索引

> 本页是 `/src/celestea_studio-ts/docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态：**当前** = 与代码/生产同步；**设计** = 目标设计与契约（未必已实现）。
> 历史归档在 [`archive/`](./archive/)（Rust 期评估、旧契约、旧部署）与
> [`archive/rust-studio-backend/`](./archive/rust-studio-backend/)（旧后端源码）；上表只登记**当前与设计**。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 当前 | 本仓**架构契约（规则正文）**：分包层级与依赖方向、seam 纪律、例外登记表；`eslint.config.js` + `.dependency-cruiser.cjs` 是它的机械实现，违反会在 `pnpm check` 被拦下 | 本文（`docs/ARCHITECTURE.md` 即唯一权威） |
| [`feature-session-independence.md`](./feature-session-independence.md) | 当前（已实现） | 特性设计：**每会话独立 runtime 实例 + 会话标识 SSE**（信封 `v:2`）；文首「设计（未实现）」状态行是写作时口径 | [`ARCHITECTURE.md`](./ARCHITECTURE.md)、`packages/runtime/src/session-registry.ts` |
| [`feature-session-grants.md`](./feature-session-grants.md) | 当前（已实现） | 特性设计：**前端点按钮授予当前会话临时能力**（提权通道）：默认最小权限、可撤销、全程审计、永不可由模型自触发；文首状态行同上为写作时口径 | [`ARCHITECTURE.md`](./ARCHITECTURE.md)、`apps/studio/src/store/grants-service.ts` |
| [`feature-studio-auth.md`](./feature-studio-auth.md) | 当前（已实现，W767） | 特性设计：**Studio 自己的登录 cookie 门**——后端自渲染 `/login`、`POST /auth/login`（`htpasswd -vbi` 校验 + 30 天 HMAC cookie）、`GET /auth/check` 供 nginx `auth_request`；含 nginx 配置与回滚命令 | 本文；[`contracts/endpoints.json`](../contracts/endpoints.json) `get_login` / `post_auth_login` / `get_auth_check` |
| [`feature-session-context.md`](./feature-session-context.md) | 当前（已实现） | 特性设计：**只读上下文快照** `GET /api/sessions/{id}/context`（W725）——模型实际看到的系统提示词 / 工具面 / 消息流的按需组装口径（不起 turn、不写日志、不耗步骤预算） | [`contracts/endpoints.json`](../contracts/endpoints.json) `get_session_context`；本文 |
| [`performance-baseline.md`](./performance-baseline.md) | 当前（快照） | 引擎热路径性能基线（`pnpm bench` 产物，含机器/commit 指纹）：状态栏 tick、token 估算与裁剪、会话日志投影、SSE 信封编解码；后续性能回归以此为参照 | 本文；机器可读孪生 `../benchmarks/baseline-*.json` |
| [`README-frontend.md`](./README-frontend.md) | 当前 | **前端仓（并入前）的 docs 索引**：原先独立仓的文档地图，W781 并入后原样保留 | 本文（现役总索引）；前端规则见 `../apps/web/FRONTEND-RULES.md` |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | 历史参考 | Rust 期开发者权威入口（架构总览、模块职责表、关键机制、工作流）；**文中路径以并入前旧布局为准** | 本文；现役见 [`README-frontend.md`](./README-frontend.md) |
| [`data-files.md`](./data-files.md) | 当前 | **共享数据文件 schema**：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json`；数据现位于 `/var/lib/celestea-agent/` | 本文；字段变更以 `../contracts/data-files/` 为准 |
| [`pitfalls.md`](./pitfalls.md) | 当前 | **踩坑档案**：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证（每条来自真实修复）；前端渲染与数据文件类条目仍适用 | 本文 |
| [`feature-ask-user.md`](./feature-ask-user.md) | 设计（待实现） | 特性设计：**模型向用户提问**（`ask_user_question`）——选项 + 自定义输入、挂起等待、答案回传模型、最大等待时间；架构对齐 DSH 官方三层实现（服务 seam / 工具 / UI answerer），本仓增量为异步 waterfall、超时、断线恢复、本地化 | [`ARCHITECTURE.md`](./ARCHITECTURE.md)、`packages/core/src/event-bus.ts` |
| [`iteration-e-capabilities.md`](./iteration-e-capabilities.md) | 设计 | 迭代方向 E（能力深水区）：断点恢复 / 可恢复多 agent / 成本账本 / 模型降级的目标契约、分期与验收标准 | 本文；落地后回写 [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| [`modes-standard-vs-execution.md`](./modes-standard-vs-execution.md) | 设计（**P0 已实现，W729**） | 特性设计：**会话双模式**（标准模式 / 执行模式，即 DSH PTC 对应物）的目标契约、分期与可机械检验的验收标准；§10 是 P0 落地回填 | 本文；PTC 语义来源见 `docs/archive/frontend/harness/archive/dsh-ptc-mode-eval.md` |
| [`ui-copy-tech-notes.md`](./ui-copy-tech-notes.md) | 当前（审计清单） | 共用前端「面向用户可见的技术文案」只读审计：27 个文件 + `index.html` 的问题清单与建议改法 | 本文；前端规则见 `apps/web/FRONTEND-RULES.md` |

上表覆盖 `docs/` 根的全部**当前与设计**文档（14 篇 + 本索引）；**新增文档必须在上表登记**。
另有子目录不逐篇登记：[`migration/`](./migration/)（迁移留痕，W781 对照表）、[`archive/`](./archive/)（历史，只存史）。
契约类真源不在 `docs/`，而在
[`../contracts/`](../contracts/)（`endpoints.json` 47 端点、`sse-events.json`、`tools.json`、`data-files/`）——
它们的 `docRef` 若指向旧 Rust 契约，路径已更新为
`docs/archive/frontend/api-contract.md`（历史文档，仅存史）。

## 仓库角色与互链

| 仓库 / 路径 | 角色 | 文档入口 |
| --- | --- | --- |
| `/src/celestea_studio-ts`（本仓） | Studio 后端（TypeScript，**生产**）+ 线上前端 `apps/web/` + 模型同步脚本 | 本页 / [`../README.md`](../README.md) |
| `/var/lib/celestea-agent` | 运行数据（`workspaces.json` / `providers.json` / `prompts.json` / `sessions/` / 账本） | [`../scripts/run-studio-ts.sh`](../scripts/run-studio-ts.sh) |
| `/src/celestea_harness` | Rust 引擎**原址**（2026-09-11 已删除，仅存说明 README；历史文档在 [`archive/frontend/harness/`](./archive/frontend/harness/)） | [`./archive/frontend/harness/README.md`](./archive/frontend/harness/README.md) |

## 维护约定

- 新增文档 → 在本页登记（文件 / 状态 / 一句话 / 权威入口），并在 [`../README.md`](../README.md) 的「文档与仓库角色」段可见。
- 设计落地后 → 把状态从 **设计** 改为 **当前**，并回写 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的 seam/例外表；
  设计文档里写作时的「未实现」状态行也应一并订正。
- 文档过时 → 移入 [`archive/`](./archive/)（`git mv` 保历史）+ 顶部 `📦 历史文档` 横幅 + 更新全仓引用路径；**不删除正文**。
  属旧前端仓事实的归 [`archive/frontend/`](./archive/frontend/)，旧后端源码归 [`archive/rust-studio-backend/`](./archive/rust-studio-backend/)。
