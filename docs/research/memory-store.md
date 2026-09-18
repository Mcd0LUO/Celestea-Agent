# Celestea Agent 持久记忆库：开源调研与选型

> **性质**：只读调研 + 选型建议。**未改任何既有文件、未跑 pnpm、未重启服务**；唯一新建文件 = 本文件。
> **方法**：`git clone --depth 1` 真实源码 + jsDelivr/文档 `.md` 变体 + shields.io 星数。**证据分级**：[原文] 读到源码/文档正文；[README] 只读 README；[结构] 只读目录/文件清单；[未读到] 明确没读到。
> **星数口径**：shields.io 取整（如 `66k`、`3.4k`），**非精确值**，仅用于量级判断。
> **合规红线**：**AGPL-3.0（basic-memory）与 Elastic License 2.0（cipher）只能借鉴设计，绝不抄代码**；MIT/Apache-2.0 也建议只借鉴设计、不整段复制。

---

## 0. 结论速览（TL;DR）

1. **推荐架构 A：文件即记忆 + 两层来源 + core/reference 拆分**——完全复用刚刚落地的 **W882/W884 两层 skill 模型**（`celestea-sources.ts` 的 `readLayers()` = `[project, global]`）与 **W884 的 `turnContext` 注入车道**（`session-compose.ts:247,302`）。**P0 零新工具、零新依赖、零契约改动**。
2. **P0 = 只读注入**：宿主在每轮 turn 起点读取两层的 `memory/MEMORY.md`，按字节预算裁剪后作为 user-role 历史注入；工作区没有记忆文件 → **零行、零成本**（与 `renderSkillCatalog` 同纪律）。参考文件（`memory/<topic>.md`）由模型按需 `read_file`，不自动内联。
3. **P1 = 显式写入**：新增宿主侧 `remember`/`forget` 工具（**契约级：tools 14→16**），写入 **global 层**的 `memory/entries.jsonl`（append-only、内容 hash 去重、遗忘=墓碑），再渲染出 `MEMORY.md` 供注入。这是**唯一能安全落盘的位置**——见 §2.1 的写根约束。
4. **不引入向量库、不自动抽取、不做 hook 采集**。向量/图/SQLite 索引（架构 C）留到「有真实召回失败证据」再上。
5. **最大反模式**：自动采集 + LLM 摘要（claude-mem/mem0/Memori）把错误固化成「每轮都出现的事实」；**benchmark 驱动的设计**（MemPalace 的 96.6% R@5 被社区复核证明来自底层向量库而非其 Palace 架构）。详见 §3。

---

## 1. 对比表

| 项目 | ★(约) | 许可证 | 一句话定位 | 可借鉴点（→ 对应到我们） |
|---|---|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 66k | Apache-2.0 | 生产级记忆层：抽取 + ADD/UPDATE/DELETE/NOOP + 向量/图 | 四元操作词汇 + `old_memory` 可审计；**md5 内容 hash 去重**；`user/agent/run` scope |
| [letta-ai/letta](https://github.com/letta-ai/letta) / [letta-code](https://github.com/letta-ai/letta-code) | 25k / 3.4k | Apache-2.0 | MemGPT 后继；**MemFS = 记忆即 Git 仓库** | **core（注入）vs deferred（按需）**；`MEMORY.md` 索引 + 相对链接「发现路径」；`/recompile` 语义 |
| [getzep/graphiti](https://github.com/getzep/graphiti)（Zep 引擎） | 31k | Apache-2.0 | 时序知识图谱：实体/边 + 有效性窗口 | **bi-temporal `valid_at`/`invalid_at` + episode 溯源**（用于「纠错/遗忘」）；混合检索 |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | 31k | Apache-2.0 | task 化记忆流水线（graph/memify/temporal/provenance/schema） | 把「写入/固化/检索」拆成可替换 task 的**分层思路**；其余过重 |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | 4k | **AGPL-3.0** | **文件即真源** + SQLite 索引 + MCP；Markdown 知识图谱 | **note 格式**：frontmatter + `## Observations`(`- [类] 文本`) + `## Relations`(`relates_to [[X]]`) + `permalink` 稳定 ID；`build_context` 工具 |
| [agiresearch/A-mem](https://github.com/agiresearch/A-mem) | 1.2k | MIT | Zettelkasten 式 agentic memory | `MemoryNote{keywords,context,tags,links,evolution_history}` 结构；**「链接而非堆叠」**；演化阈值 |
| [BAI-LAB/MemoryOS](https://github.com/BAI-LAB/MemoryOS) | 1.6k | Apache-2.0 | 短/中/长期分层「记忆操作系统」 | **heat（访问频次+交互长度）驱动晋升**；分层容量参数化；检索跨层聚合 |
| [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 2k | Apache-2.0 | 自托管记忆后端：sqlite-vec + 知识图谱 + 混合检索 | **BM25+向量混合**；`conversation_id` 跳过去重；**本地 embedding 的降级陷阱**（见 §3） |
| [campfirein/cipher](https://github.com/campfirein/cipher) | 5k | **ELv2** | 面向编码 agent 的记忆层 + agentic codebase map | 「为 coding agent 定制」的定位；`brv` REPL 内建记忆读写 |
| [shaneholloman/mcp-knowledge-graph](https://github.com/shaneholloman/mcp-knowledge-graph) | 889 | MIT | **小众宝藏**：本地 JSONL 知识图谱 | **文件安全标记**（首行 `{"type":"_aim"}` 才允许写）；项目 `.aim/` vs 全局；contexts；三原语 schema |
| [GibsonAI/memori](https://github.com/GibsonAI/memori) | 17k | Apache-2.0 | SQL 原生、框架无关的记忆 | **显式 `recall` 工具 + token 预算口径**（721 tok/query，2.8% 全上下文）；「结构化优于全上下文」 |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 94k | Apache-2.0 | Claude Code 记忆压缩：hook 自动采集 + SQLite/FTS5/Chroma | **捕获点分类**（SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd）；SQLite 落库形态 |
| [MemPalace/mempalace](https://github.com/MemPalace/mempalace) | 59k | MIT | 本地优先「逐字存储」记忆（争议） | **反面教材**：benchmark 数字被社区复核证伪（见 §3） |
| CLAUDE.md（[Claude 官方文档](https://code.claude.com/docs/en/memory)） | — | — | 用户写的指令文件 + Claude 自动记忆 | **两种机制分工**（指令 vs 学习）+ 字节上限（前 200 行/25KB）+ `.claude/rules/` 路径作用域 |
| [Cursor rules](https://cursor.com/docs/rules) | — | — | `.cursor/rules/*.mdc` 项目规则 | **frontmatter `description`/`globs`/`alwaysApply` + 四种应用模式**（Always/智能/按文件/手动）；`AGENTS.md` 兜底 |
| [AGENTS.md](https://agents.md/) | — | — | 开放的 agent 指令文件约定（60k+ 项目） | 一个**可预测的单一文件名** |

---

## 2. 记忆库候选架构

### 2.1 现状：Celestea 已具备、可直接复用的四件套（[原文]，本仓 file:line）

1. **两层来源模型**（`packages/core/src/celestea-sources.ts`）：`readLayers(wsPath)` 返回 **`[project, global]`，数组序即优先级**：
   - project = `<ws>/.celestea`（**只读契约、随仓提交、人工维护**）；
   - global = `<CELESTEA_HOME>/workspaces/<ws>`（**唯一可写容器**，`celestea-home.ts` 解析：`$CELESTEA_HOME` → `$XDG_DATA_HOME/celestea` → `~/.celestea`）。
   skill 就放在 `<layer>/skills/<name>/SKILL.md`。
2. **turn 边界注入车道**（`apps/studio/src/runtime/session-compose.ts:247,302`）：`skillContext` 作为 `turnContext` 传给 `enginePlugins`，**每轮 turn 起点重读**并作为 durable user-role 历史注入；无工作区的 detached 生成不注入。底层是 `PendingInjection`/`next-turn` 车道（`packages/core/src/injection.ts`、`packages/runtime/src/compose.ts:207`）。
3. **成本纪律**（`packages/core/src/skill-catalog.ts`）：**空则返回 `null`（零行）**；description 截断到 200 字符并加省略号；最多 32 条，超出显式报「+N more」；**绝不内联正文**。
4. **宿主侧只读工具范式**（`packages/tools/src/tools/load-skill.ts`）：工作区**构造器注入**（不猜 cwd）、宿主 fs 读取（绕过 path guard）、结构化错误码（`invalid_name`/`unknown_skill`/`invalid_skill`/`no_workspace`）、**纯读**（read-only 会话可用）。

**两条硬约束（决定架构，必须正视）：**

- **写根**：`PathGuardPolicy.writeRoots = [workspace, ...grants.writeRoots]`（`packages/tools/src/guard/path-guard.ts:164,230-237`）。**global 层在 workspace 之外 → 模型无法用 `write_file` 写记忆**。所以「模型自己写 global 记忆」必须靠**宿主侧工具**（同 `load_skill` 的注入范式）。
- **读根**：`readRoots = [workspace, ...CELESTEA_TOOL_ROOTS, ...grants.readRoots]`（`path-guard.ts:203`）。**global 层默认不在读根内**；默认 `full-access` 的 `allPaths` 会把读/写根都换成 `/`（`engine-grants.ts:177-178`），此时可读；但**受限档位（如 read-only）下模型读不到 global 层的参考文件**。project 层在 workspace 内，**始终可读**。

> 结论：**注入走宿主（永远可行）；参考文件优先放 project 层（模型可 `read_file`）；global 层只作「被注入的 core」与 P1 的写入目标。**

### 2.2 架构 A：文件即记忆 + 两层 + core/reference 拆分【推荐】

- **存储格式**
  - project（只读、随仓提交、人工维护）：`<ws>/.celestea/memory/MEMORY.md` + `<ws>/.celestea/memory/<topic>.md`
  - global（宿主可写）：`<CELESTEA_HOME>/workspaces/<ws>/memory/MEMORY.md` + `<topic>.md`（P1 增 `entries.jsonl`）
  - **core = `MEMORY.md`**（小索引：稳定偏好、约定、gotchas、到 topic 文件的相对链接「发现路径」）；**reference = `<topic>.md`**（按需读，不自动内联）。
  - 行文约定（借鉴 basic-memory + Letta，但不引入 YAML 解析）：观察行 `- [类] 事实`；关系 `- relates_to [[topic]]`；索引区 `## Index` 放相对链接。
- **检索方式**：core 由注入直达；reference 用 `read_file`（project 层始终可读）；粗略搜索用 `run_shell` 的 grep/rg。**P0 无索引**。
- **与 agent 循环的接入点**：**完全复用 `turnContext`**（`session-compose.ts`），与 `skillContext` 并列；每轮 turn 起点重读、按字节预算裁剪、作为 user-role 历史注入；**绝不进 system prompt**（system 是冻结的 10 段、8192 上限、缓存敏感）。
- **最小可用形态**：只读注入 + 人工维护文件，**零工具、零依赖、零契约改动**。
- **优点**：与刚落地 skill 模型同构（一套心智）；人可读可改可 git diff；无外部依赖；token 成本有界；审计天然（git blame）。
- **缺点**：无语义检索；模型需靠索引/发现路径导航；模型不能直接写 global（P1 用工具解决）。

### 2.3 架构 B：append-only 事件日志 + 渲染视图

- **存储**：global `memory/entries.jsonl`，每行 `{v,id,ts,op:"add"|"update"|"forget",text,tags,author,source:{session,turn},hash}`；`MEMORY.md` 是**渲染视图**（人读）。
- **写入**：`remember`/`forget` 工具；**内容 hash 去重 → NOOP**（mem0 的 md5 做法）；`forget` 追加墓碑行（append-only，可审计）。
- **检索**：线性扫 jsonl（无索引）或直接读渲染视图；规模大再加 FTS。
- **接入点**：同 A（注入渲染视图）。
- **定位**：**A 的 P1 写入层**，不是独立架构。它补上 A 缺的「模型可写 + 可纠错 + 可遗忘 + 可审计」。

### 2.4 架构 C：SQLite + FTS5（+可选向量）

- **形态**：本地 SQLite（`better-sqlite3` 或 sqlite-vec），FTS5 全文 + 可选 embedding 向量 + 混合排序；对应 mcp-memory-service / claude-mem / basic-memory 的索引层。
- **优点**：规模大时检索快；可做混合/语义召回；可做去重与合并。
- **缺点**：**新增原生依赖**；schema 迁移与损坏风险；**embedding 维度不一致会静默污染存储**（mcp-memory-service README 自陈的真实事故：自定义模型加载失败静默回退 MiniLM 384 维，后续写入维度不符）；二进制不可人读；与「文件即真源」冲突；对单用户、单工作区规模是过度工程。
- **裁决**：**P0/P1 不做**。触发条件（任一）：记忆文件 > 数百个且 `read_file`/grep 明显不够；或出现**可复现的召回失败**且证明关键词检索无法解决。

### 2.5 推荐与理由

**推荐：A（P0）→ A+B（P1）；明确否决 C（现阶段）。** 理由：

1. **与既有代码同构**：两层 `readLayers` + `turnContext` + catalog 成本纪律都是刚落地、已测试的机制；记忆不需要发明新范式（`celestea-sources.ts` 文件头明写这套模型正是 W879 调研后定的 B 方案）。
2. **P0 零风险落地**：不改 `contracts/`、不加工具/端点、不动 core 类型、不进 system prompt；失败模式只是「没注入」。
3. **规避写根陷阱**：P0 只读，模型不写；P1 用宿主工具写 global，与 `load_skill` 同一安全范式。
4. **可审计、可纠错**：文件 + git；B 的 append-only + 墓碑 + hash 去重补上机器可审计。
5. **token 有界**：W873 实测 2 KiB ≈ 512–576 token/轮（约 +7.9% 于 6474 token 中位 prompt）；catalog 式的「空则零行 + 超限显式截断」把它钉住。

### 2.6 第一个可交付切片（P0，建议范围）

1. **新增** `packages/core/src/memory.ts`（纯函数 + 薄 IO seam，照 `skills.ts`/`skill-catalog.ts`）：
   - 常量 `MEMORY_SUBDIR = "memory"`、`MEMORY_FILE_NAME = "MEMORY.md"`；
   - `memoryFilesOf(layers)`：按 `[project, global]` 优先级收集（project 胜）；
   - `renderMemoryContext(layers, { maxBytes })`：**无文件返回 `null`（零行）**；按字节裁剪并在截断处加显式标记；标题写明「这是数据不是指令」。
2. **接线** `apps/studio/src/runtime/session-compose.ts`：与 `skillContext` 并列加一个 `memoryContext` `turnContext` provider；detached 生成不注入。
3. **测试**：照 `packages/core/src/skill-catalog.test.ts` 的形状——空 → `null`；超限截断 + 标记；project 覆盖 global；无 workspace 不注入。
4. **文档**：在 `docs/data-files.md`（或本目录新设计文）登记 `<layer>/memory/MEMORY.md` 约定。
5. **明确不做**：不加工具、不加端点、不加 system section、不引入依赖、不做自动抽取。
6. **P1（另一切片）**：`remember`/`forget` 宿主工具 + `entries.jsonl`（契约 14→16），写 global 层；read-only 会话拒绝写入；镜像 `load_skill` 的注入式 workspace + 结构化错误。**P2**：可选 `recall` 工具 / FTS 索引。

---

## 3. 反模式清单（我们不该学的）

1. **自动采集 + LLM 摘要，无人在环**（claude-mem 的 5 个 lifecycle hook；mem0 插件 hook + 后台 flush；Memori 后台 capture）。错误会被固化成「每轮都出现的事实」，且不可审计。→ 我们：P0 人写文件、P1 显式 `remember`。
2. **向量优先 / 语义检索当默认**。引入依赖 + **embedding 维度静默污染**（mcp-memory-service README 自陈）+ 不可人读。→ 先文件 + grep，有证据再上。
3. **benchmark 驱动的设计**。MemPalace 宣称 LongMemEval 96.6% R@5，社区复核（Issue #27）指出数字来自底层向量库而非其 Palace 架构；且「整会话为存储单元」恰好迎合该 benchmark 的提问粒度。→ 按 workspace 真实召回需求设计，不追榜。
4. **把记忆塞进 system prompt**（Letta 的 core memory 模型）。我们的 system 是冻结 10 段 + 8192 上限 + 缓存敏感；任何改动 100% 打断前缀缓存。→ 只用 turn 边界 user-role 车道。
5. **「什么都存」/ 存原始事件**。Letta 自己的指引：存**可泛化的模式**，不存可从对话历史动态取回的原始事件。
6. **过度剪枝/激进压缩**。Letta `ROOT_MEMORY.md` 明写：丢失特异性很难恢复；稀疏记忆比略大的记忆更糟。
7. **只有 JSONL/DB、没有人读视图**。不可人工审阅/编辑。→ 机器真源 + Markdown 渲染视图。
8. **静默降级**（embedding 回退、解析失败当空）。→ 与 `load_skill` 一样**结构化报错、绝不静默空**。
9. **抄 GPL/AGPL/ELv2 代码**：basic-memory = **AGPL-3.0**、cipher = **ELv2**——**只借鉴设计，绝不复制代码**；MIT/Apache-2.0 也建议只借鉴设计。

---

## 4. 未读到 / 不确定（诚实交底）

- **cognee**：只读到 `cognee/tasks/*` 目录结构 [结构]，**未读任何 task 正文**；其「ECL/流水线」细节不确定。
- **mem0**：`mem0/memory/main.py` 为 grep/片段阅读（16.8 万字符未逐行通读）；`configs/prompts.py` 读了前 ~325 行。四元操作与 hash 去重有 [原文] 证据。
- **graphiti**：只读 README [README]；bi-temporal 字段名与检索实现细节未读源码。
- **A-MEM**：只读 `memory_system.py` 头部（`MemoryNote` 字段 + evolution prompt）[原文-片段]；完整演化/检索流程未读。
- **MemoryOS**：只读 README + 模块文件清单 [README/结构]；heat 公式与晋升实现未读源码。
- **letta-code MemFS**：读到两个内置 skill 正文 [原文]（`syncing-memory-filesystem`、`initializing-memory/ROOT_MEMORY.md`）；**MemFS 的 Git 同步/编译实现未读源码**。
- **Cursor rules**：读到官方 `.md` 正文 [原文]；**Team Rules / dashboard 行为未读到**。
- **星数为 shields.io 取整**，非精确值。
- 本仓 W873（记忆评估）与 W876（目录归一）报告仍在 `/server-center/runtime/worker-exec/results/`，可作为本选型的内部依据。

---

## 5. 来源链接

- mem0 — https://github.com/mem0ai/mem0
- Letta（MemGPT）— https://github.com/letta-ai/letta ；源码仓 https://github.com/letta-ai/letta-code
- Zep — https://github.com/getzep/zep ；时序图谱引擎 https://github.com/getzep/graphiti
- cognee — https://github.com/topoteretes/cognee
- basic-memory（AGPL-3.0）— https://github.com/basicmachines-co/basic-memory ；note 格式 `NOTE-FORMAT.md`
- A-MEM — https://github.com/agiresearch/A-mem ；论文 https://arxiv.org/pdf/2502.12110
- MemoryOS — https://github.com/BAI-LAB/MemoryOS ；论文 https://arxiv.org/abs/2506.06326
- mcp-memory-service — https://github.com/doobidoo/mcp-memory-service
- cipher（ELv2）— https://github.com/campfirein/cipher
- mcp-knowledge-graph — https://github.com/shaneholloman/mcp-knowledge-graph
- Memori — https://github.com/GibsonAI/memori
- claude-mem — https://github.com/thedotmack/claude-mem
- MemPalace — https://github.com/MemPalace/mempalace
- Claude 记忆文档 — https://code.claude.com/docs/en/memory ；`.claude` 目录 — https://code.claude.com/docs/en/claude-directory
- Cursor rules — https://cursor.com/docs/rules
- AGENTS.md — https://agents.md/

*报告完。所有分级标注见 §4；推荐方案的落点均标本仓 file:line。*