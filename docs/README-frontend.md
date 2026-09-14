# 前端仓（Celestea-Studio）· `docs/` 索引

> 📦 **W781（2026-09-14）**：旧前端仓 Celestea-Studio（并入前位于同级的 `celestea_studio` 目录）已全量并入本仓
> （前端 = `apps/web/`；本页原为**该前端仓**的 `docs/` 索引，随并入原样保留）。
> 页面内出现的 `frontend/` 一律指现在的 `apps/web/`；下文出现的旧仓路径一律指本仓。
> 本仓**唯一**的 `docs/` 索引是 [`README.md`](./README.md)；本页只作前端仓历史索引留痕。

> 本页是原前端仓 `docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态三分类：**当前** = 与现状同步；**设计** = 目标设计（未必已实现）；**历史** = 已归档，只存史不再更新。

## 先说仓库角色（2026-09-11 口径，W781 后已并入本仓）

- 原前端仓**现役** = **线上前端（`frontend/` → 现 `apps/web/`）+ 共享数据文件**（W781 起数据在 `/var/lib/celestea-agent/`）。
- Rust Studio 后端已退役（`celestea-studio.service` 已 masked）：见 [`archive/frontend/rust-studio-backend/LEGACY-RUST-BACKEND.md`](./archive/frontend/rust-studio-backend/LEGACY-RUST-BACKEND.md)。
- **后端（TypeScript，生产）在 [`/src/celestea_studio-ts`](/src/celestea_studio-ts/docs/README.md)**（W781 起与前端同仓）；
  Rust **引擎**参考实现已随 W781 归档在本仓 [`archive/frontend/harness/`](./archive/frontend/harness/README.md)。
- 因此本页列表里凡是描述 Rust 后端的文档一律归 **历史**（2026-09-11 归档进 [`archive/frontend/`](./archive/frontend/)，正文保留 + 顶部 📦 横幅），
  只有前端规则与数据文件格式仍属当前。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | 当前（Rust 后端部分为历史参考） | Rust 期开发者权威入口：架构总览、模块职责表、关键机制（Gen/swap_gen、SSE 信封、autowake、提示词装配）、开发工作流、测试现状与文档索引 | 本文自身的 §0 文档地图；后端开发改看 [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`data-files.md`](./data-files.md) | 当前 | **共享数据文件** schema 与格式：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json`（写作时基于 Rust 实现；TS 后端读写同一批文件） | 本文；字段变更以 TS 侧实现与 `/src/celestea_studio-ts/contracts/data-files/` 为准 |
| [`pitfalls.md`](./pitfalls.md) | 当前 | 踩坑档案：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证（每条来自真实修复）；前端渲染与数据文件类条目**仍适用** | 本文 |
| [`archive/frontend/backend-language-eval.md`](./archive/frontend/backend-language-eval.md) | 历史 | W229（2026-09-07）后端语言切换评估，结论「维持 Rust axum 不换语言」——已被 TS 全量重写推翻 | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`archive/frontend/backend-ts-rewrite-eval.md`](./archive/frontend/backend-ts-rewrite-eval.md) | 历史 | W268 Rust → TypeScript 全量重构评估 + 可执行迁移计划（迁移已完成，本报告为立项依据） | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`archive/frontend/api-contract.md`](./archive/frontend/api-contract.md) | 历史 | 已退役 Rust 后端（axum）全部 HTTP 端点契约：39 端点 / 请求响应 / 每个错误分支的 status + error 原文 | [`/src/celestea_studio-ts/contracts/endpoints.json`](/src/celestea_studio-ts/contracts/endpoints.json)（47 端点） |
| [`archive/frontend/deployment.md`](./archive/frontend/deployment.md) | 历史 | 已退役 Rust 后端的 systemd / nginx / 环境变量 / 健康检查 / 重启与回滚（来自机器实际配置） | [`/src/celestea_studio-ts/scripts/run-studio-ts.sh`](/src/celestea_studio-ts/scripts/run-studio-ts.sh) + TS 仓文档 |
| [`archive/frontend/frontend-session-persistence-eval.md`](./archive/frontend/frontend-session-persistence-eval.md) | 历史 | 「刷新后聊天消失」评估：后端已持久化，缺口在前端启动恢复（推荐方案 A，已实现） | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| [`archive/frontend/prompt-injection-eval.md`](./archive/frontend/prompt-injection-eval.md) | 历史 | 提示词变量注入 / 多提示词注册评估（Rust 期 `src/prompts.rs`）；机制已在 TS 后端落地 | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`archive/frontend/frontend-freeze-stop-button-plan.md`](./archive/frontend/frontend-freeze-stop-button-plan.md) | 历史 | 前端卡死修复 + statusline 停止按钮架构方案（W301/W302），方案已上线，文首「待执行」已过时 | [`DEVELOPMENT.md`](./DEVELOPMENT.md)、[`pitfalls.md`](./pitfalls.md) |

本页在并入本仓后位于 `docs/` 根（`README-frontend.md` 前缀 `-frontend` 以与后端索引 [`README.md`](./README.md) 区分）：
`DEVELOPMENT.md` / `data-files.md` / `pitfalls.md` 三篇 + `archive/frontend/` 15 篇历史文档。
原前端仓根另有 [`../README.md`](../README.md)（已并入本仓 README 的「仓库角色」段）与
[`archive/frontend/rust-studio-backend/LEGACY-RUST-BACKEND.md`](./archive/frontend/rust-studio-backend/LEGACY-RUST-BACKEND.md)（Rust 后端退役与回滚）。

## 仓库角色与互链

| 仓库 | 角色 | 文档入口 |
| --- | --- | --- |
| `/src/celestea_studio-ts`（本仓，W781 前为两个仓） | 后端（TypeScript，生产）+ 线上前端 `apps/web/` | [`docs/README.md`](./README.md) / [`../README.md`](../README.md) |
| `/var/lib/celestea-agent` | 运行数据（providers / workspaces / sessions / 账本；W781 前在原前端仓根） | [`../scripts/run-studio-ts.sh`](../scripts/run-studio-ts.sh) |
| `/src/celestea_harness` | Rust **引擎**参考实现 | 已随 W781 归档：[`docs/archive/frontend/harness/README.md`](./archive/frontend/harness/README.md) |

## 维护约定

- 新增文档 → 在本页表格登记（文件 / 状态 / 一句话 / 权威入口），并同步 [`../README.md`](../README.md) 与
  [`DEVELOPMENT.md`](./DEVELOPMENT.md) §0 文档地图。
- 文档过时 → 移入 `archive/`（`git mv` 保历史）+ 顶部 `📦 历史文档` 横幅 + 更新本页状态与全仓引用路径；**不删除正文**。
- 归档不等于作废：`archive/` 里的报告是「为什么这样设计」的决策留痕，追溯时仍应读。
