# 特性设计 · 文档漂移清理与归档（W1518）

> 状态：**设计**。本文是「怎么清、按什么判、清完怎么防复发」的记录；执行完回填 §5 并改状态行。
> ⚠️ 状态行只允许一个类别词（同 `feature-sandbox-time-semantics.md` 的说明）：`classifyStatus` 先命中先归类。
> 依赖：[AGENT.md](./AGENT.md) §7 文档规范、[README.md](./README.md) 的维护约定。

## 1. 一句话目标

把已经**不再描述现状**的文档按规范**归档**（`git mv` 进 `archive/`，加横幅、改状态、不删正文），
把「文档 ↔ 代码 ↔ 契约」之间**可机械发现**的漂移变成断言，而不是靠人记得。

## 2. 现状（实读）

| 事实 | 位置 |
|---|---|
| 归档纪律已写死：过时文档 `git mv` 进 `archive/`（**指定归档目录**）+ 顶部 `📦 历史文档` 横幅 + 状态改 `历史参考` + 更新全仓引用 | `docs/README.md` 的「维护约定」；`AGENT.md` §7 第 7 条 |
| 机械门禁已有 7 条（登记 / 状态同类 / 链接与锚点 / ≤700 行 / 不含本机事实 / 归档横幅 / 分册可达） | `tests/doc-conventions.test.ts`（①–⑦） |
| 单篇 ≤700 行是硬上限 | 同上 ④ |
| 本次实读的漂移点 | 见 §3 表 |

## 3. 已确认的漂移（逐条 + 处置）

| # | 漂移 | 证据 | 处置 |
|---|---|---|---|
| D1 | `docs/HANDOVER.md`（未跟踪）让 `tests/doc-conventions.test.ts` **红 3 条**：①未登记 ②无状态行 ⑤含本机 checkout 路径 | 实跑 `npx vitest run tests/doc-conventions.test.ts`：3 failed / 6 passed | **用户裁决（2026-09-25）：删除**（不走归档）。执行前把正文备份到仓外 `/tmp`（它是会话接续手册，不是现行文档），删完门禁必须全绿 |
| D2 | `docs/archive/` 下文档的 `file:line` 锚点指向**已不存在的行**（旧 Rust 后端行号） | 归档正文以并入前旧两仓布局为准（页首横幅已声明） | 归档文档**不追锚点**：横幅已声明历史口径。门禁③b 只对现行文档生效，本条登记为**有意豁免**，不修 |
| D3 | 根 `README.md` 与 `docs/README.md` 的硬数字（端点数 / 工具数 / 文档篇数） | `tests/readme-claims.test.ts` 只钉根 README | 保持现状：`docs/README.md` 刻意不写篇数（它漂过） |
| D4 | `docs/pitfalls.md` 的 P1–P13 大多描述**已退役的 Rust 后端**（`src/providers.rs` 等） | 页首横幅已声明「以并入前旧布局为准」 | 其中前端渲染 / 数据文件类条目仍适用（索引表已写）。**用户裁决（2026-09-25）：已退役后端的描述直接删除**（不走归档）。判定口径：条目指向的 `src/*.rs` 在现仓不存在 ⇒ 删；但行为若在 TS 侧仍存在 ⇒ **保留行为描述、把 file:line 换成 TS 真源**（删掉仍适用的踩坑记录会让人重踩）。先出逐条判定表（含 `grep` 证据）再动手 |
| D5 | `docs/archive/` 里的纯旧后端文档（`DEVELOPMENT.md` 等） | 用户「都删了」的口径 | **一并删除**；`archive/decisions/` 与 `archive/research/` 保留（仍被现役文档引用），除非整篇只描述 Rust 后端 |

### 3.1 归档文档的 `file:line` 锚点：有意豁免（不修）

**规则**：门禁 **③b**（`file:line` 锚点必须落在真实文件的非空行上）**只遍历现行文档**，
不遍历 `docs/archive/**`。这不是遗漏，是刻意的范围收窄。

**机械依据**：③b 的实现 `anchorProblems()` 遍历 `activeDocs()`，而 `activeDocs()` 的定义是
「`docs/**` 里除归档、总索引与本机文件之外的 markdown」——`isArchived(p)` 为真的路径第一步就被滤掉
（`tests/doc-conventions.test.ts:64`）。门禁 ⑤ 的 `checkoutPathProblems()` 用同一个 `isArchived(p)`
早退（同文件 `:287`），两处口径一致。

**实测：这条豁免是承重的，不是装饰**。W1518 用 ③b 的同一判据扫了一遍 `docs/archive/`，
**10 处锚点会红**（W1518 实测，见 W1518 交付报告（仓外 `/server-center/runtime/worker-exec/results/`））。下面是当时的探针输出，
是**记录**不是引用 —— 所以按 ③b 自己的规则放进围栏块（块内是「当时跑过的命令 + 当时的输出」，
必须原样保留才能被追溯）：

```
archive/decisions/feature-ask-user.md:53 -> apps/web/src/ui/confirm.ts:35
archive/decisions/feature-selection-quote.md:16 -> apps/web/src/ui/quote/tray.ts:58
archive/research/selection-and-preview.md:21 -> apps/web/src/ui/text-attach.ts:109
```

注意这些漂移**多数是 TS 时代的锚点**（文件搬走/行号变了），不只是旧 Rust 行号 ——
所以「归档锚点会漂」是**结构性**的，不是某一次迁移的一次性残留。

**为什么必须豁免（三条理由，按强度排序）**：

1. **归档是冻结的历史快照，锚点本来就该停在写下那天。** `docs/AGENT.md` §7 规则 7 写的是
   「归档不是删除：…**不删正文**」。归档正文里的 `file:line` 是「当时那段代码在哪」的**记录**，
   不是对当前代码的引用；逼它跟上当前行号等于篡改历史。
2. **纳入后唯一的「修法」比漂移更糟。** 要么删锚点、要么改写历史叙述，两者都损失可追溯性 ——
   与 ③b 自身注释里写明的取舍一致。
3. **口径由横幅承担，锚点由豁免承担，分工不重叠。** 门禁 **⑥** 强制每篇归档文档带
   `📦 历史文档` 横幅 + `历史参考`/`已废弃` 状态；读者由横幅得知「以当时为准」。

**与现行文档的边界**：现行文档的锚点**必须**正确（③b 全量检查）。本次清理没有放宽这条 ——
W1518 重写 `docs/pitfalls.md` 后，其 **31 个 `file:line` 锚点逐条实测落在非空行**（bad=0）。
若某篇归档文档日后被「复活」回 `docs/`，它就不再是归档，③b 立刻对其生效。

## 4. 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| C1 | `pnpm vitest run tests/doc-conventions.test.ts` 全绿 | 直接跑 |
| C2 | 归档动作是 `git mv`（历史不丢）且带横幅与 `历史参考` 状态 | `git log --follow` + 门禁⑥ |
| C3 | 全仓引用路径同步更新（含代码注释与契约的 `docRef`） | `grep -rn "<旧路径>"` 为空 |
| C4 | 新增/移动的文档在 `docs/README.md` 地图里登记且状态同类 | 门禁①② |
| C5 | 不删除任何正文 | diff 只应出现路径与横幅变化 |

## 5. 执行记录（回填）

W1518 落地（2026-09-25）。**口径变更**：用户裁决由「归档」改为「删除已退役 Rust 后端的描述」。

**删除**（正文均先备份到仓外 `/tmp`，可从 git 历史取回）：

| 文件 | 理由 | 备份 |
|---|---|---|
| `docs/HANDOVER.md` | 会话接续手册，不是现行文档；让门禁 ①②⑤ 红 3 条 | `/tmp/HANDOVER-2026-09-25.md`（sha256 `78248863…`） |
| `docs/archive/DEVELOPMENT.md` | 整篇只描述已退役 Rust 后端（74 处 `.rs`、0 处 TS） | `/tmp/w1518-deleted-archive/`（sha256 `feabcb4c…`） |
| `docs/archive/README-frontend.md` | 并入前旧前端仓的 docs 索引，纯旧两仓布局 | `/tmp/w1518-deleted-archive/`（sha256 `62d0a372…`） |

**重写**：`docs/pitfalls.md` —— 逐条复核 P1–P13 与「容易误记」表，**行为在 TS 侧仍存在的条目保留并把
`file:line` 换成 TS 真源**（P1/P1b/P2/P3/P4/P5/P6/P7/P9/P10/P11/P12 + 4 条误记），
只有退役后端才有的条目删除（旧 P13 全局 env 竞争、旧 P8 的「只有 mono 单主题」、旧「bind 是常量」）。
页首的 `📦 W781` 横幅**已删除**（不再有指向旧布局的正文），改为 W1518 清理说明。
重写后 **31 个 `file:line` 锚点逐条实测落在非空行（bad=0）**。

**保留**：`archive/decisions/`（10 篇已实现决策）与 `archive/research/`（4 篇调研留痕）——
逐篇实测均含现役 TS 引用（`apps/studio|packages|apps/web` ≥ 1 处），非「整篇只描述 Rust 后端」。

**门禁红绿**：`npx vitest run tests/doc-conventions.test.ts` → **9 passed / 9**（起始为 2 failed）。
变异负控制两处：删归档横幅 → ⑥ 红；恢复 `docs/HANDOVER.md` → ①② 红。`pnpm check:fast` 退出码 0。

**未完成（越界，只报不改）**：`contracts/` 有 2 处 `doc` 指针指向已删除的 `docs/archive/DEVELOPMENT.md`
（`contracts/sse-events.json:7`、`contracts/data-files/registry-tsv.schema.json:6`），
被 `tests/contract-store.test.ts` 的「契约文档指针可达性」门禁盯着 → 该测试 **1 failed**。
`contracts/` 不在 W1518 的写权限内，需派工者改指 `contracts/sse-events.json` /
`contracts/route-table.snapshot.json` 自身的冻结条目（与 W881 对退役端点 `docRef` 的处置一致）。
同类还有 `packages/runtime/src/autowake.ts:4` 的注释（也在写权限外）。

## 6. 刻意没做什么

- 不改 `contracts/` 里的任何 schema（漂移清理不动契约）。
- 不为归档文档补 `file:line` 锚点（它们描述的是历史代码）。
- 不动 `docs/AGENT.local.md`（本机事实，不入库）。
