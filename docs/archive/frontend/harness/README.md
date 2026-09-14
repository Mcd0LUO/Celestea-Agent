# celestea_harness · `docs/` 索引

> 本页是 `/src/celestea_studio/docs/archive/harness/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态三分类：**当前** = 与代码同步的权威文档；**设计** = 目标设计（未必已实现）；**历史** = 已归档，
> 只存史、不再更新（正文保留，不做删除）。
>
> 归档于 2026-09-11（W727 文档整理）：Rust 期评估/路线图类文档统一移入 [`archive/`](./archive/)，
> 每份顶部带 `📦 历史文档` 横幅并指出当前权威入口。移动用 `git mv`，历史完整保留。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | **当前** | 引擎开发者权威入口：7 个 crate 职责与依赖方向、core seam 契约、`Runtime::compose` 组装顺序与生命周期、10 个工具契约、run_code 父 broker 协议、沙箱分层、会话/事件模型、用量与缓存、配置键与环境变量总表、构建测试、与 Studio 的集成 | 本文（`docs/DEVELOPMENT.md` 即唯一权威） |
| [`run-code-sdk.md`](./run-code-sdk.md) | **当前** | `run_code` 工具的使用者视角（怎么写程序）与维护者视角（协议、限额、事件映射、本地验证），只描述**已落地实现** | [`DEVELOPMENT.md`](./DEVELOPMENT.md) §3 |
| [`archive/agent-iteration-roadmap.md`](./archive/agent-iteration-roadmap.md) | 历史 | W246（2026-09-07）Agent 核心评估与 6–12 个月路线图：保留 Rust 七 crate + axum 的总判断与 P0/P1/P2 排期；排期结论已被 TS 后端全量重写取代 | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| [`archive/agent-iteration-roadmap-w245-supplement.md`](./archive/agent-iteration-roadmap-w245-supplement.md) | 历史 | 上述路线图的 W245 独立验证补充（分歧与独立复核），评估过程留痕 | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| [`archive/backend-optimization-eval.md`](./archive/backend-optimization-eval.md) | 历史 | Rust 引擎后端优化评估（长文件拆分、解耦、性能、内存泄漏复查、压测设计），HEAD `5a19083` 时点 | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| [`archive/dsh-ptc-mode-eval.md`](./archive/dsh-ptc-mode-eval.md) | 历史 | W253（2026-09-09）DSH PTC（code agent preset）模式三层拆解与借鉴清单；借鉴结论已由 `run_code` 落地实现取代 | [`DEVELOPMENT.md`](./DEVELOPMENT.md) §3、[`run-code-sdk.md`](./run-code-sdk.md) |
| [`archive/run-code-mode-eval.md`](./archive/run-code-mode-eval.md) | 历史 | W254（2026-09-09）`run_code` 折叠机制评估：方案 A/B、语言选择、安全分析、事件映射设计与决策清单（落地前） | [`run-code-sdk.md`](./run-code-sdk.md) |

`docs/` 下**没有**其它文件；`archive/` 只放历史文档，不再新增。

## 相关（不在 `docs/` 内）

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | 历史（早期设计） | 仓库早期设计文档，部分章节已过时（CLI crate 已不存在等，见 `DEVELOPMENT.md` §10） | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| [`../README.md`](../README.md) | 当前 | 安装/发布/快速上手 + 文档索引 + 仓库角色互链 | 本页 |

## 仓库角色与互链

| 仓库 | 角色 | 文档入口 |
| --- | --- | --- |
| `/src/celestea_harness`（本仓） | Rust **引擎**参考实现（不是 Studio 后端） | 本页 / [`../README.md`](../README.md) |
| `/src/celestea_studio-ts` | Studio 后端（TypeScript，**生产**） | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| `/src/celestea_studio` | 线上前端 + 共享数据文件（Rust Studio 后端已退役） | [`/src/celestea_studio/docs/README.md`](/src/celestea_studio/docs/README.md) |

## 维护约定

- 新增文档 → 在本页表格登记（文件 / 状态 / 一句话 / 权威入口），并在 [`../README.md`](../README.md) 与
  [`DEVELOPMENT.md`](./DEVELOPMENT.md) §0 文档地图同步一行。
- 文档过时 → 移入 `archive/`（用 `git mv` 保历史）+ 顶部加 `📦 历史文档` 横幅 + 更新本页状态与全仓引用路径；
  **不删除正文**。
