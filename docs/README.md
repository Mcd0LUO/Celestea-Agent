# celestea_studio-ts · `docs/` 索引

> 本页是 `/src/celestea_studio-ts/docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态：**当前** = 与代码/生产同步；**设计** = 目标设计与契约（未必已实现）。
> 本仓 `docs/` **不含历史归档**——Rust 期的评估与旧契约在
> [`/src/celestea_studio/docs/archive/`](/src/celestea_studio/docs/README.md)（本仓只保留当前与设计）。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 当前 | 本仓**架构契约（规则正文）**：分包层级与依赖方向、seam 纪律、例外登记表；`eslint.config.js` + `.dependency-cruiser.cjs` 是它的机械实现，违反会在 `pnpm check` 被拦下 | 本文（`docs/ARCHITECTURE.md` 即唯一权威） |
| [`feature-session-independence.md`](./feature-session-independence.md) | 当前（已实现） | 特性设计：**每会话独立 runtime 实例 + 会话标识 SSE**（信封 `v:2`）；文首「设计（未实现）」状态行是写作时口径 | [`ARCHITECTURE.md`](./ARCHITECTURE.md)、`packages/runtime/src/session-registry.ts` |
| [`feature-session-grants.md`](./feature-session-grants.md) | 当前（已实现） | 特性设计：**前端点按钮授予当前会话临时能力**（提权通道）：默认最小权限、可撤销、全程审计、永不可由模型自触发；文首状态行同上为写作时口径 | [`ARCHITECTURE.md`](./ARCHITECTURE.md)、`apps/studio/src/store/grants-service.ts` |
| [`feature-session-context.md`](./feature-session-context.md) | 当前（已实现） | 特性设计：**只读上下文快照** `GET /api/sessions/{id}/context`（W725）——模型实际看到的系统提示词 / 工具面 / 消息流的按需组装口径（不起 turn、不写日志、不耗步骤预算） | [`contracts/endpoints.json`](../contracts/endpoints.json) `get_session_context`；本文 |
| [`iteration-e-capabilities.md`](./iteration-e-capabilities.md) | 设计 | 迭代方向 E（能力深水区）：断点恢复 / 可恢复多 agent / 成本账本 / 模型降级的目标契约、分期与验收标准 | 本文；落地后回写 [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| [`modes-standard-vs-execution.md`](./modes-standard-vs-execution.md) | 设计（**P0 已实现，W729**） | 特性设计：**会话双模式**（标准模式 / 执行模式，即 DSH PTC 对应物）的目标契约、分期与可机械检验的验收标准；§10 是 P0 落地回填 | 本文；PTC 语义来源见 `/src/celestea_harness/docs/archive/dsh-ptc-mode-eval.md` |
| [`ui-copy-tech-notes.md`](./ui-copy-tech-notes.md) | 当前（审计清单） | 共用前端「面向用户可见的技术文案」只读审计：27 个文件 + `index.html` 的问题清单与建议改法 | 本文；前端规则见 `/src/celestea_studio/frontend/FRONTEND-RULES.md` |

上表与本目录**一一对应**（7 篇文档 + 本索引）；**新增文档必须在上表登记**。
契约类真源不在 `docs/`，而在
[`../contracts/`](../contracts/)（`endpoints.json` 44 端点、`sse-events.json`、`tools.json`、`data-files/`）——
它们的 `docRef` 若指向旧 Rust 契约，路径已更新为
`/src/celestea_studio/docs/archive/api-contract.md`（历史文档，仅存史）。

## 仓库角色与互链

| 仓库 | 角色 | 文档入口 |
| --- | --- | --- |
| `/src/celestea_studio-ts`（本仓） | Studio 后端（TypeScript，**生产**） | 本页 / [`../README.md`](../README.md) |
| `/src/celestea_studio` | 线上前端 + 共享数据文件（Rust 后端已退役；Rust 期历史文档在 `docs/archive/`） | [`/src/celestea_studio/docs/README.md`](/src/celestea_studio/docs/README.md) |
| `/src/celestea_harness` | Rust **引擎**参考实现（架构/工具/沙箱权威） | [`/src/celestea_harness/docs/README.md`](/src/celestea_harness/docs/README.md) |

## 维护约定

- 新增文档 → 在本页登记（文件 / 状态 / 一句话 / 权威入口），并在 [`../README.md`](../README.md) 的「文档与仓库角色」段可见。
- 设计落地后 → 把状态从 **设计** 改为 **当前**，并回写 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的 seam/例外表；
  设计文档里写作时的「未实现」状态行也应一并订正。
- 本仓不设 `archive/`：过时文档若属 Rust 期事实，归档到 `/src/celestea_studio/docs/archive/`。
