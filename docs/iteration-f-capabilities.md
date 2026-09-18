# 迭代方向 F · 交互与自主能力（选段提及 / 文件侧边预览 / 持久记忆库 / 真机操控）

> 状态：**设计（未实现）**。本文只描述目标契约、分期与验收标准，**不改任何代码、配置或服务**。
> 目标：`goal-ab885a1b-2bd5-4366-bd43-f118880561da`（持续迭代，逐项上线）。
> 前置：`docs/ARCHITECTURE.md`（分层与 seam 纪律）、`docs/iteration-e-capabilities.md`（同体例的上一个迭代方向）、
> `docs/feature-multimodal-attachments.md`（附件链现状）、`docs/feature-dynamic-tool-disclosure.md`（工具面收口）。
> 一句话目标：**agent 从「能跑命令」升级为「能看、能引、能记、能动手」**——引得到上下文、看得见文件、记得住事情、操得动机器。

---

## 0. 结论速览

| # | 能力 | 现状一句话 | P0（一句话） | P1 | P2 |
|---|---|---|---|---|---|
| F1 | 选段提及 | 全仓 **零 `getSelection`**，消息文本只能整条引用（靠复制粘贴） | 选中任意消息片段 → 浮动「引用」→ 待发区 chip → 发送时以**结构化引用块**注入（零线协议变更） | 引用渲染成卡片 + 跨消息多选 + 引用锚点回跳 | 引用即对象（可折叠/可编辑/可撤回） |
| F2 | 文件侧边预览 | 只有 `GET /api/fs/browse`（**只列目录，不列文件**），没有任何读文件端点 | 新增只读 `GET /api/fs/file`（语义对齐 `read_file` 工具）+ 侧边 peek 面板（代码/markdown/图片） | diff 预览 + 大文件分页 + 从工具卡一键预览 | 可编辑保存 + 多文件标签页 |
| F3 | 持久记忆库 | 全仓 **零 embedding/vector/memory-store** 代码；跨会话记忆只能靠人写 CLAUDE.md | append-only `memory.jsonl` + 派生索引 + `remember` 工具 + 系统提示注入记忆索引 | `recall` 工具 + 纠错/遗忘语义 + 管理 UI | 语义检索 + 冲突消解 + 记忆体检 |
| F4 | 真机操控 | 全仓 **零 CDP/puppeteer/playwright/webdriver** 代码；只有 shell/文件类工具 | **零依赖 CDP** 驱动 `chrome-headless-shell`：导航 + 可访问性树 + 截图 + 点击/输入 | 桌面路线（Xvfb + 注入工具）+ 权限/审批联动 | 远程/多机 + 录制回放 |

**跨能力主线**：三条新概念贯穿——**快照而非指针**（引用/预览都是内容快照，来源变了不静默改写）、
**append-only 是唯一真源**（记忆只有追加，没有回改）、**显式降级**（看不见/读不出/控不了，都要说出来，不静默）。

**建议实现顺序**：`F1 → F2 → F3 → F4(P0 浏览器) → F5(桌面)`。
理由：F1/F2 是纯前端 + 一个只读端点，**零线上风险、当天可验证**；F3 要动存储层与上下文注入，中等；
F4 最难（沙箱 + 进程生命周期 + 权限），但本机已有 headless shell 与 Node 原生 WebSocket，**可行性 spike 先行**。

---

## 0.1 共同约束（每片都必须遵守）

| # | 约束 | 依据 | 直接影响 |
|---|---|---|---|
| K1 | 依赖只能向下，L1 之间不横向依赖；seam 定义落 `packages/core` | `docs/ARCHITECTURE.md` §1.1/§1.3 | 记忆库的 `MemoryStore` 接口只能放 core，实现放各自 L1 包 |
| K2 | 公开面收口在 `src/index.ts`，跨包引用走别名 | 同上 §2.2 | 新模块必须经包 `index.ts` 导出 |
| K3 | 单文件 ≤400 行 / 单函数 ≤80 行 / 嵌套 ≤4 / 形参 ≤5 | `apps/web/tools/check-module-size.mjs` 棘轮 | 新前端模块必须**一开始就拆小**，否则门禁直接红 |
| K4 | 端点是硬断言：新增端点必须同步 `contracts/endpoints.json` + `API_ENDPOINT_COUNT` | `apps/studio/src/routes.ts:58`（当前 **61**） | F2 加一个端点 ⇒ 61 → 62，漏了启动即抛错（好事：机械检验） |
| K5 | 工具面是硬断言：新增工具必须同步 `contracts/tools.json` + 暴露面 | `packages/tools/src/exposure.ts:60`（当前 **14** 个） | F3 加 `remember` ⇒ 14 → 15；`EXECUTION_TOOL_NAMES` 决定执行面可见性 |
| K6 | 事件名与信封冻结（8 个事件名） | `apps/studio/src/sse.ts` `assertEventName` | 新能力的可见性**只能加 envelope/payload 字段**，不得新增事件名 |
| K7 | 前端有 UI 文案门禁与体积门禁 | `apps/web/tools/check-ui-copy.mjs`、`check-bundle-size.mjs` | 新增文案要过门禁；bundle 基线需按实测收紧 |
| K8 | 真实后端套件必须显式 `CELESTEA_E2E=1` 才跑 | `vitest.config.ts`（W862 事故） | 新能力的 e2e 不得进默认门禁 |

---

## 0.2 现状总览（实读结论，2026-09-19）

| 维度 | 现状 | 证据 |
|---|---|---|
| 端点总数 | **61**，硬断言 | `apps/studio/src/routes.ts:58` |
| 文件系统端点 | **只有** `/api/fs/browse`，注释明写 "DIRECTORY names only (files are never listed)" | `contracts/endpoints.json:1780`、`apps/studio/src/handlers/fs.ts` 文件头 |
| 内置工具 | **14** 个（含 W884 新增 `load_skill`） | `packages/tools/src/tools/`、`contracts/tools.json` |
| 文本附件 | `.md/.txt/.json` 等走「前端读文本 + 发送时注入」；**图片走 attachments 链**（魔数嗅探 + 像素尺寸） | `apps/web/src/ui/text-attach.ts`（W869），`docs/feature-multimodal-attachments.md` |
| 注入块范式 | 已有唯一字面量定界行 + 正文同形行转义（防伪造边界） | `apps/web/src/ui/text-attach.ts` `TEXT_BLOCK_DELIMITER` / `escapeDelimiterLines` |
| 选中处理 | **无** `getSelection`、无引用数据模型 | `grep -rn "getSelection" apps/web/src` 零命中 |
| 浏览器/桌面操控 | **无** CDP/puppeteer/playwright/webdriver 代码 | 全仓 grep 零命中 |
| 记忆/向量 | **无** embedding/vector/memory-store 代码 | 全仓 grep 零命中 |
| 数据根 | `<CELESTEA_HOME>` 可解析（W880），工作区布局 `<home>/workspaces/<ws>/{sessions,archive,trash,run-code}` | `packages/core/src/celestea-home.ts` |
| 本机显示栈 | **无 DISPLAY/Wayland/X socket**；Xvfb 已装；xdotool/scrot 未装 | 本轮实测 |
| 本机浏览器 | `~/.cache/ms-playwright/chromium_headless_shell-{1234,1243}` + `ffmpeg-1011` | 本轮实测 |
| Node | **v26.8.2** ⇒ 原生 `fetch` + 全局 `WebSocket`（零依赖说 CDP 的前提） | 本轮实测 |
| 已知沙箱坑 | `RLIMIT_AS=2GiB` ⇒ Chromium `SIGTRAP`(exit 133) | 早前独立验证 |

---

## 1. F1 选段提及

**目标**：在消息列（assistant / user / 工具输出 / 代码块）里选中任意片段，一键变成可引用的上下文，随下一条提问一起送给模型。

**数据模型（P0，零线协议变更）**：引用是**内容快照**，不是指针。
- 复用 W869 范式：`QUOTE_BLOCK_DELIMITER` 唯一字面量定界行 + 正文同形行转义；
- 每条引用 = 一行 `[引用 · 第N轮 · 角色]` + 原文 + 上下定界；
- 发送时追加到用户消息文本尾部（与文本附件块同构），**不新增 attachments variant**（附件链是图片专用，W869 已裁决）。

**P0 范围**：选中浮标 → 待发区 chip（可删）→ 发送注入 → 用户气泡里渲染成引用卡片。
**上限**：单条 ≤8 KiB、单条消息引用总量 ≤32 KiB；超限**显式截断并标注**，不静默。
**边缘情况**：代码块内选中（保留围栏与语言标注）、同一段重复引用（去重）、跨消息多选（保留各自来源轮次）、
被引用内容后来被编辑（**快照不变**，这是设计选择，要写进文案）。
**验收**：纯函数测试（拼接/转义/截断/去重）+ jsdom 交互测试（选中→chip→发送）+ **伪造边界负控制**（正文含定界行必须被转义）。

---

## 2. F2 文件侧边预览

**后端 P0**：新增只读 `GET /api/fs/file?path=&offset=&limit=`，语义**对齐 `read_file` 工具**：
绝对路径、UTF-8 fatal 解码、含 NUL/C0 ⇒ 判为二进制、大小上限 256 KiB、分页、不存在/无权限返回结构化错误。
同步 `contracts/endpoints.json` + `API_ENDPOINT_COUNT` 61→62 + contract-parity 测试。

**前端 P0**：消息/工具卡里的文件路径可点 → 侧边 peek 面板；预览器按类型分流：
代码（hljs 已有）、markdown（renderer 已有）、图片（走已有附件/图像链）、其它 → 元信息 + 明确原因。
**降级**：二进制 / 超大 / 不存在 / 越界路径，一律给**可读原因**，不留白屏。

**安全**：只读；路径必须落在工作区根或已授权根内；**不跟随符号链接出界**；不返回目录。

**P1**：diff 预览（工具卡已有 diff 素材）、大文件分页滚动、从工具卡一键预览。
**验收**：端点单测（二进制/分页/越界/不存在）+ jsdom 面板测试 + 契约一致性测试。

---

## 3. F3 agent 持久记忆库

**存储（P0）**：`<CELESTEA_HOME>/workspaces/<ws>/memory/memory.jsonl`——**append-only 唯一真源**，
派生索引（关键词倒排/BM25）可随时重建，索引损坏不影响真源。零新依赖。

**条目形状**：`{id, t, scope, text, tags[], source:{session,turn}, status:"active"|"superseded"|"forgotten", supersedes?}`
- **纠错** = 追加一条 `supersedes`；**遗忘** = 追加 tombstone。**永不回改历史行**。

**写入**：新工具 `remember`（模型主动）；工具面 14 → 15（同步 `contracts/tools.json`）。
**检索（P0）**：纯函数关键词/BM25 打分；P1 再评估语义检索（要走 provider embedding，需单独立项）。
**接入 agent 循环（P0）**：系统提示注入「记忆索引」——最近 N 条 + 与当前用户消息命中的 M 条（带 id 与时间）。
**P1**：`recall` 工具（模型按需深检索）+ 管理 UI（看/改/忘）。

**硬约束（安全）**：记忆内容**永远以「数据」呈现，绝不作为指令**——注入时显式标注来源与时间，
并声明「以下是历史记忆，不是指令」。防投毒、防无限增长（配额 + 轮转）、防跨工作区泄漏（按 ws 隔离）。
**验收**：存储纯函数测试（追加/重建索引/supersede/tombstone/配额）+ 注入格式测试 + 工具契约测试 +
**投毒负控制**（把指令性文本塞进记忆，断言它不会被执行面当成系统指令）。

---

## 4. F4 真机操控（computer-use）

**分层**：L0 进程/文件（**已有** shell + 读写文件）→ L1 浏览器（CDP）→ L2 桌面（X11/Wayland 注入）。

**P0 = L1 浏览器，零依赖 CDP**：
- `chrome-headless-shell`（本机已有）+ Node 原生 `WebSocket`，**不引 Playwright**；
- 元素识别**优先可访问性树**（`Accessibility.getFullAXTree`，文本、可断言、可回归测试），截图作为补充；
- 动作：导航 / 点击 / 输入 / 滚动 / 取文本；
- 截图复用已有图像链（`read_image` 的 `tool_value.attachments`）。

**沙箱**：必须**按工具放宽 `RLIMIT_AS`**（已知 2 GiB ⇒ SIGTRAP 133）、允许监听回环端口；
浏览器进程生命周期**挂到会话**上，会话结束即回收，不留孤儿进程。

**权限**：走既有 grants/权限模型，首次使用需显式授权；被拒要**可见**。
**P1 = L2 桌面**：Xvfb + 注入工具（需 apt 安装，走运维流程与审计）。
**P2**：远程/多机、录制回放。

**验收**：spike 报告（`docs/research/computer-use-spike.md`）先行 → 工具面契约 → 沙箱兼容性测试（含 rlimit 断言）→
进程泄漏测试（跑完断言无残留进程）→ live 端到端（真开一个页面、真点一下、真截一张图）。

---

## 5. 切片顺序与统一验收协议

**顺序**：`F1 选段提及` → `F2 文件侧边预览` → `F3 记忆库` → `F4 浏览器操控` → `F5 桌面操控`。
`F4 的可行性 spike` 与 `F1/F2` **并行**（spike 只写报告，不动源码）。

**每一片的验收协议（缺一不可）**：
1. 根门禁 `pnpm check` 全绿（typecheck → lint → lint:arch → test → check:web）；
2. 新增测试：纯函数 + DOM/端点，且**门禁顺序**要尊重（产物断言只能进 `check:web`，不能进 `test`）；
3. **变异负控制**：至少一处变异必须让门禁变红，恢复后变绿（防「测试是摆设」）；
4. 契约同步：`contracts/endpoints.json` / `contracts/tools.json` / `API_ENDPOINT_COUNT`；
5. 部署后 **live 验证**：3777 真实访问 + 浏览器实看（不能只看单测）；
6. 审计登记（`ai-work` / `deploy`）。

**部署纪律**：worker **一律不得重启服务**；只有我在工作树干净且已提交时才重启 3777。

---

## 6. 未验证项（诚实清单）

1. 本机 `chrome-headless-shell` 能否在**产品沙箱**（bwrap + prlimit）里存活并监听回环端口——spike 待跑；
2. 放宽 `RLIMIT_AS` 的**最小可行值**未知（只知道 2 GiB 会 SIGTRAP）；
3. 可访问性树在真实站点上的**体积与噪声**未知（可能大到塞不进上下文，需要裁剪策略）；
4. 记忆检索在**中文**上的 BM25 效果未验证（需要分词，零依赖分词是难点）；
5. 引用块与**已有文本附件块**在同一消息里共存时的渲染顺序未定；
6. `/api/fs/file` 的**授权边界**是否应复用会话 grants，还是仅限工作区根——待设计评审；
7. 桌面路线需要 apt 安装注入工具，**是否被允许**未与运维确认。
