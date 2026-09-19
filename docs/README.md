# celestea_studio-ts · `docs/` 索引

> 本页是 `/src/celestea_studio-ts/docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态：**当前** = 与代码/生产同步；**设计** = 目标设计与契约（未必已实现）。
> 旧契约/旧部署/旧评估的归档历史文档已于 W881 清理出公开仓；上表只登记**当前与设计**。

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
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | 历史参考 | 旧后端的开发者权威入口（架构总览、模块职责表、关键机制、工作流）；**文中路径以并入前旧布局为准** | 本文；现役见 [`README-frontend.md`](./README-frontend.md) |
| [`data-files.md`](./data-files.md) | 当前 | **共享数据文件 schema**：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json`；数据现位于 `/var/lib/celestea-agent/` | 本文；字段变更以 `../contracts/data-files/` 为准 |
| [`pitfalls.md`](./pitfalls.md) | 当前 | **踩坑档案**：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证（每条来自真实修复）；前端渲染与数据文件类条目仍适用 | 本文 |
| [`feature-ask-user.md`](./feature-ask-user.md) | 当前（**已实现，W783/W784**） | 特性设计：**模型向用户提问**（`ask_user_question`）——选项 + 自定义输入、挂起等待、答案回传模型、最大等待时间；架构对齐 DSH 官方三层实现（服务 seam / 工具 / UI answerer），本仓增量为异步 waterfall、超时、断线恢复、本地化 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.1；`packages/core/src/question.ts`、`apps/web/src/ui/question/` |
| [`feature-selection-quote.md`](./feature-selection-quote.md) | 当前（**已实现，F1**） | 特性设计：**选段提及**——在消息里选中文本，点「引用」把**内容快照**随下一条消息发出；序列化进消息文本，零后端契约变更，历史可解析回渲染 | 本文；`apps/web/src/ui/quote/model.ts` |
| [`feature-workspace-memory.md`](./feature-workspace-memory.md) | 当前（**已实现，F3 P0**） | 特性设计：**工作区持久记忆**——`MEMORY.md` 每轮起点重读、作为 user-role 历史注入（绝不进 system）；项目层优先、2048 字节上限 + 显式截断、块首防投毒声明 | 本文；`packages/core/src/memory.ts` |
| [`iteration-e-capabilities.md`](./iteration-e-capabilities.md) | 设计 | 迭代方向 E（能力深水区）：断点恢复 / 可恢复多 agent / 成本账本 / 模型降级的目标契约、分期与验收标准 | 本文；落地后回写 [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| [`iteration-f-capabilities.md`](./iteration-f-capabilities.md) | 当前（**已实现，F1–F4**） | 迭代方向 F：选段提及 / 文件侧边预览 / 工作区持久记忆 / 真机操控（浏览器）的目标契约与验收 | 本文；`apps/web/src/ui/quote/`、`apps/web/src/ui/preview/`、`packages/core/src/memory.ts`、`packages/tools/src/browser/` |
| [`iteration-g-workbench.md`](./iteration-g-workbench.md) | 当前（**已实现，G1–G4**） | 迭代方向 G：命令面板 / `POST /api/exec` 立即执行 / 持久目标 / `GET /api/fs/list` / 多面板工作区；含**冻结的线格式** | 本文；`apps/web/src/ui/workbench/`、`apps/studio/src/handlers/exec.ts` |
| [`iteration-h-i18n.md`](./iteration-h-i18n.md) | 当前（**已实现，H**） | 迭代方向 H：前端 i18n（zh/en 双语字典、迁移白名单棘轮、`<html lang>` 跟随切换）+ 发布门禁加固 | 本文；`apps/web/src/i18n/`、`apps/web/tools/check-ui-copy.mjs` |
| [`modes-standard-vs-execution.md`](./modes-standard-vs-execution.md) | 设计（**P0 已实现，W729**） | 特性设计：**会话双模式**（标准模式 / 执行模式，即 DSH PTC 对应物）的目标契约、分期与可机械检验的验收标准；§10 是 P0 落地回填 | 本文；PTC 语义来源见归档的 DSH 评估（W253/W254，已于 W881 清理出公开仓） |
| [`ui-copy-tech-notes.md`](./ui-copy-tech-notes.md) | 当前（审计清单） | 共用前端「面向用户可见的技术文案」只读审计：27 个文件 + `index.html` 的问题清单与建议改法 | 本文；前端规则见 `apps/web/FRONTEND-RULES.md` |
| [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md) | 当前（W847 W0） | **依赖与工具链策略**：Node 版本带 + 启动守卫、冻结安装（pnpm-workspace.yaml）、升级验证协议与回滚、为什么 audit 不进门禁、外部运行时依赖清点 | 本文 |

上表覆盖 `docs/` 根的全部**当前与设计**文档（本索引除外）；**新增文档必须在上表登记**。
（这里刻意不写篇数：那个数字漂过 —— 迭代 F/G/H 三篇都漏登记了。`tests/readme-claims.test.ts` 只钉根 `README.md` 的硬数字，不覆盖本文件。）
另有子目录不逐篇登记：[`migration/`](./migration/)（迁移留痕，W781 对照表）。
契约类真源不在 `docs/`，而在
[`../contracts/`](../contracts/)（`endpoints.json` 47 端点、`sse-events.json`、`tools.json`、`data-files/`）——
退役后端的归档 HTTP 契约已于 W881 清理出公开仓，相关端点的 `docRef` 现指向
`contracts/endpoints.json` 自身的冻结条目。

## 仓库角色与互链

| 仓库 / 路径 | 角色 | 文档入口 |
| --- | --- | --- |
| `/src/celestea_studio-ts`（本仓） | Studio 后端（TypeScript，**生产**）+ 线上前端 `apps/web/` + 模型同步脚本 | 本页 / [`../README.md`](../README.md) |
| `/var/lib/celestea-agent` | 运行数据（`workspaces.json` / `providers.json` / `prompts.json` / `sessions/` / 账本） | [`../scripts/run-studio-ts.sh`](../scripts/run-studio-ts.sh) |
| `/src/celestea_harness` | 引擎**原址**（2026-09-11 已删除；其历史文档已于 W881 清理出公开仓） | — |

## 维护约定

- 新增文档 → 在本页登记（文件 / 状态 / 一句话 / 权威入口），并在 [`../README.md`](../README.md) 的「文档与仓库角色」段可见。
- 设计落地后 → 把状态从 **设计** 改为 **当前**，并回写 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的 seam/例外表；
  设计文档里写作时的「未实现」状态行也应一并订正。
- 文档过时 → 移入归档目录（`git mv` 保历史）+ 顶部 `📦 历史文档` 横幅 + 更新全仓引用路径；**不删除正文**。
  公开仓不再保留退役后端/引擎的历史文档（W881 已清理）。
