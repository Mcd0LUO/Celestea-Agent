# celestea_studio-ts · `docs/` 索引

> 本页是 `/src/celestea_studio-ts/docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态：**当前** = 与代码/生产同步；**设计** = 目标设计与契约（未必已实现）。
> 历史文档（调研 / 迁移 / 退役）在 [`archive/`](./archive/)，顶部有 `📦 历史文档` 横幅；上表只登记**当前与设计**。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 当前 | 本仓**架构契约（规则正文）**：分包层级与依赖方向、seam 纪律、例外登记表；`eslint.config.js` + `.dependency-cruiser.cjs` 是它的机械实现，违反会在 `pnpm check` 被拦下 | 本文（`docs/ARCHITECTURE.md` 即唯一权威） |
| [`performance-baseline.md`](./performance-baseline.md) | 当前（快照） | 引擎热路径性能基线（`pnpm bench` 产物，含机器/commit 指纹）：状态栏 tick、token 估算与裁剪、会话日志投影、SSE 信封编解码；后续性能回归以此为参照 | 本文；机器可读孪生 `../benchmarks/baseline-*.json` |
| [`data-files.md`](./data-files.md) | 当前 | **共享数据文件 schema**：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json`；数据现位于 `/var/lib/celestea-agent/` | 本文；字段变更以 `../contracts/data-files/` 为准 |
| [`pitfalls.md`](./pitfalls.md) | 当前 | **踩坑档案**：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证（每条来自真实修复）；前端渲染与数据文件类条目仍适用 | 本文 |
| [`feature-multimodal-attachments/`](./feature-multimodal-attachments/README.md) | 设计（已实现 P0） | **多模态附件**设计（分册）：图片/文本附件的三入口、能力位探测、降级提示、objectURL 生命周期 | [`README.md`](./feature-multimodal-attachments/README.md)；`apps/web/src/ui/attachments.ts` |
| [`feature-display-components.md`](./feature-display-components.md) | 设计（**P0 已实现**，W895） | **可选显示组件**：把「渲染后增强」与「markdown 扩展」变成可注册的缝，显示能力做成可开关组件（构建期装配，不做运行时下载） | 本文；缝的现有先例见 `apps/web/src/ui/hint/registry.ts` 的取舍注释 |
| [`feature-dynamic-tool-disclosure.md`](./feature-dynamic-tool-disclosure.md) | 设计（只调研与设计，W802） | **动态工具披露**的调研与设计：工具面随任务收窄的方案与取舍；本文不落地代码 | 本文 |
| [`feature-sandbox-time-semantics.md`](./feature-sandbox-time-semantics.md) | 设计 | **沙箱时间语义**：把固定的 20s `RLIMIT_CPU` 改成「跟随该次调用墙钟」的推导值，模型仍可用参数覆盖且被部署方上限夹紧；含 `run_code` 子进程与可配硬顶的补齐 | 本文；落点 `packages/tools/src/sandbox/limits.ts` |
| [`feature-permission-entry-merge.md`](./feature-permission-entry-merge.md) | 已实现 | **权限入口合并**：状态栏右端只留一个盾牌入口（用已有图标），面板内同时给出会话档位与精细授权；窄屏不再挤掉停止键 | 本文；落点 `apps/web/src/statusline/permission.ts`、`apps/web/src/ui/grants/` |
| [`feature-docs-drift-cleanup.md`](./feature-docs-drift-cleanup.md) | 设计 | **文档漂移清理与归档**：把不再描述现状的文档按规范归档、把可机械发现的漂移变成断言；含本次实读的四条漂移与处置 | 本文；门禁 `tests/doc-conventions.test.ts` |
| [`iteration-e/`](./iteration-e/README.md) | 设计 | 迭代方向 E（能力深水区，分册）：断点恢复 / 可恢复多 agent / 成本账本 / 模型降级的目标契约、分期与验收标准 | [`README.md`](./iteration-e/README.md)；落地后回写 [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| [`modes-standard-vs-execution.md`](./modes-standard-vs-execution.md) | 设计（**P0 已实现，W729**） | 特性设计：**会话双模式**（标准模式 / 执行模式，即 DSH PTC 对应物）的目标契约、分期与可机械检验的验收标准；§10 是 P0 落地回填 | 本文；PTC 语义来源见归档的 DSH 评估（W253/W254，已于 W881 清理出公开仓） |
| [`deployment.md`](./deployment.md) | 当前 | **部署与安全模型**：生产 systemd + nginx、隧道访问、安全模型（含 Windows 差异表） | 本文；登录门见 [`archive/decisions/feature-studio-auth.md`](./archive/decisions/feature-studio-auth.md) |
| [`configuration.md`](./configuration.md) | 当前 | **配置**：`CELESTEA_HOME` 解析顺序与目录布局、环境变量全表、模型接入、权限档位 | 本文；数据文件 schema 见 [`data-files.md`](./data-files.md) |
| [`AGENT.md`](./AGENT.md) | 当前 | **开发与提交规范**：完成定义（Definition of Done）、提交消息格式与粒度、发布流程（先 tag 再 build）、派工协议、文档规范、写代码取向 | 本文；门禁清单见根 `package.json` 的 `check` |
| [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md) | 当前（W847 W0） | **依赖与工具链策略**：Node 版本带 + 启动守卫、冻结安装（pnpm-workspace.yaml）、升级验证协议与回滚、为什么 audit 不进门禁、外部运行时依赖清点 | 本文 |

上表覆盖 `docs/` 的全部**现行文档**（根文档 + 分册索引，本索引除外）；**新增文档必须在上表登记**。
（这里刻意不写篇数：那个数字漂过 —— 迭代 F/G/H 三篇都漏登记了。`tests/readme-claims.test.ts` 只钉根 `README.md` 的硬数字，不覆盖本文件。）
另有子目录不逐篇登记：[`archive/`](./archive/)（**历史文档**：调研、迁移留痕、退役文档；每篇顶部有 `📦 历史文档` 横幅）。
本机文件 `docs/AGENT.local.md`（由 `AGENT.local.md.example` 复制而来）**不入库、不需登记**：那里放机器相关的事实。
契约类真源不在 `docs/`，而在
[`../contracts/`](../contracts/)（`endpoints.json` 66 端点、`sse-events.json`、`tools.json`、`data-files/`）——
退役后端的归档 HTTP 契约已于 W881 清理出公开仓，相关端点的 `docRef` 现指向
`contracts/endpoints.json` 自身的冻结条目。

## 归档（历史文档）

| 文件 | 状态 | 一句话 |
| --- | --- | --- |
| [`archive/DEVELOPMENT.md`](./archive/DEVELOPMENT.md) | 历史参考 | 旧后端（Rust）的开发者入口；文中路径以并入前旧布局为准 |
| [`archive/README-frontend.md`](./archive/README-frontend.md) | 历史参考 | 并入前前端仓的 docs 索引，原样保留 |
| [`archive/research/`](./archive/research/) | 历史参考 | 调研报告：memory-store / selection-and-preview / computer-use 等 |
| [`archive/decisions/`](./archive/decisions/) | 历史参考 | **已实现决策的归档**（10 篇：特性设计 + 迭代方向的决策依据与验收标准；现行口径见 `contracts/` 与 `ARCHITECTURE.md`） |
| [`archive/migration/`](./archive/migration/) | 历史参考 | 迁移留痕：W781 两仓合并对照表 |

## 仓库角色与互链

| 仓库 / 路径 | 角色 | 文档入口 |
| --- | --- | --- |
| **本仓**（Studio 后端 TypeScript + 线上前端 `apps/web/` + 模型同步脚本） | 生产 | 本页 / [`../README.md`](../README.md) |
| 运行数据目录（`$CELESTEA_HOME`，见 [`configuration.md`](./configuration.md)） | `workspaces.json` / `providers.json` / `prompts.json` / `sessions/` / 账本 | [`../scripts/run-studio-ts.sh`](../scripts/run-studio-ts.sh) |
| 引擎原址（已删除） | 历史文档已于 W881 清理出公开仓 | — |

## 维护约定

- 新增文档 → 在本页登记（文件 / 状态 / 一句话 / 权威入口），并在 [`../README.md`](../README.md) 的「文档与仓库角色」段可见。
- **决策一旦落地 → 归档**：`git mv` 进 [`archive/decisions/`](./archive/decisions/)，状态改 `历史参考`，
  从本页的现行表移到「归档」表。理由：决策文档记的是「当时为什么这样定 + 当时怎么验收」，
  落地后它就不再描述现状；**现行口径以 `contracts/`（线格式）、`ARCHITECTURE.md`（架构规则）为准**。
  归档后仍要回到代码里改**引用路径**（代码注释与契约的 `docRef`/`sourceRef`）。
  （W893 一次归档 10 篇：7 篇 `feature-*` + 3 篇已实现的 `iteration-*`。）
- 设计落地后若**仍有未落地的分期（P1/P2）**，留在 `docs/` 并把状态写成 `设计（P0 已实现）`，
  **不要**整篇归档 —— 它还在描述一部分当前行为。
- 单篇 **≤ 700 行**（硬上限）→ 超了按章节拆进同名子目录（`docs/<名字>/README.md` 作索引并登记，分册不登记）。
- 文档过时 → `git mv` 进 [`archive/`](./archive/)（**指定归档目录**）+ 顶部 `📦 历史文档` 横幅 + `历史参考` 状态 + 更新全仓引用路径；**不删除正文**。
  公开仓不再保留退役后端/引擎的历史文档（W881 已清理）。
