# 前端仓（Celestea-Studio）· `docs/` 索引

> 状态：**历史参考**。并入前前端仓的 docs 索引，原样保留；现役总索引是 @@README.md@@。

> 📦 **W781（2026-09-14）**：旧前端仓 Celestea-Studio（并入前位于同级的 `celestea_studio` 目录）已全量并入本仓
> （前端 = `apps/web/`；本页原为**该前端仓**的 `docs/` 索引，随并入原样保留）。
> 页面内出现的 `frontend/` 一律指现在的 `apps/web/`；旧仓（Celestea-Studio）路径均已并入本仓。
> 本仓**唯一**的 `docs/` 索引是 [`README.md`](./README.md)；本页只作前端仓历史索引留痕。

> 本页是原前端仓 `docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态三分类：**当前** = 与现状同步；**设计** = 目标设计（未必已实现）；**历史** = 已归档，只存史不再更新。

## 先说仓库角色（2026-09-11 口径，W781 后已并入本仓）

- 原前端仓**现役** = **线上前端（`frontend/` → 现 `apps/web/`）+ 共享数据文件**（W781 起数据在 `/var/lib/celestea-agent/`）。
- **后端（TypeScript，生产）在 [`/src/celestea_studio-ts`](/src/celestea_studio-ts/docs/README.md)**（W781 起与前端同仓）；
  引擎**原址**（`/src/celestea_harness`）已于 2026-09-11 删除，其历史文档已于 W881 清理出公开仓。
- 本页原列表里描述旧后端的归档文档（2026-09-11 归档进 `archive/frontend/`）已于 W881 清理出公开仓，
  只有前端规则与数据文件格式仍属当前。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | 当前（旧后端部分为历史参考） | 旧后端的开发者权威入口：架构总览、模块职责表、关键机制（Gen/swap_gen、SSE 信封、autowake、提示词装配）、开发工作流、测试现状与文档索引 | 本文自身的 §0 文档地图；后端开发改看 [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`data-files.md`](./data-files.md) | 当前 | **共享数据文件** schema 与格式：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json`（写作时基于旧后端实现；TS 后端读写同一批文件） | 本文；字段变更以 TS 侧实现与 `/src/celestea_studio-ts/contracts/data-files/` 为准 |
| [`pitfalls.md`](./pitfalls.md) | 当前 | 踩坑档案：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证（每条来自真实修复）；前端渲染与数据文件类条目**仍适用** | 本文 |

本页在并入本仓后位于 `docs/` 根（`README-frontend.md` 前缀 `-frontend` 以与后端索引 [`README.md`](./README.md) 区分）：
`DEVELOPMENT.md` / `data-files.md` / `pitfalls.md` 三篇；`archive/frontend/` 13 篇历史文档已于 W881 清理出公开仓。
原前端仓根另有 [`../README.md`](../README.md)（已并入本仓 README 的「仓库角色」段）。

## 仓库角色与互链

| 仓库 | 角色 | 文档入口 |
| --- | --- | --- |
| `/src/celestea_studio-ts`（本仓，W781 前为两个仓） | 后端（TypeScript，生产）+ 线上前端 `apps/web/` | [`docs/README.md`](./README.md) / [`../README.md`](../README.md) |
| `/var/lib/celestea-agent` | 运行数据（providers / workspaces / sessions / 账本；W781 前在原前端仓根） | [`../scripts/run-studio-ts.sh`](../scripts/run-studio-ts.sh) |
| `/src/celestea_harness` | 引擎**原址**（2026-09-11 已删除） | 历史文档已于 W881 清理出公开仓 |

## 维护约定

- 新增文档 → 在本页表格登记（文件 / 状态 / 一句话 / 权威入口），并同步 [`../README.md`](../README.md) 与
  [`DEVELOPMENT.md`](./DEVELOPMENT.md) §0 文档地图。
- 文档过时 → 移入归档目录（`git mv` 保历史）+ 顶部 `📦 历史文档` 横幅 + 更新本页状态与全仓引用路径；**不删除正文**。
- 归档不等于作废：归档报告是「为什么这样设计」的决策留痕；公开仓已不保留退役后端/引擎的历史文档（W881 清理）。
