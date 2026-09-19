# 迭代方向 F · 交互与自主能力（选段提及 / 文件侧边预览 / 持久记忆库 / 真机操控）

> 状态：**已实现（F1–F4，v2.7.x）**。本文是目标契约与验收标准的记录；落地见 apps/web/src/ui/quote/、apps/web/src/ui/preview/、packages/core/src/memory.ts、packages/tools/src/browser/。
> 目标：`goal-ab885a1b-2bd5-4366-bd43-f118880561da`（持续迭代，逐项上线）。
> 前置：`docs/ARCHITECTURE.md`（分层与 seam 纪律）、`docs/iteration-e/`（同体例的上一个迭代方向）、
> `docs/feature-multimodal-attachments/`（附件链现状）、`docs/feature-dynamic-tool-disclosure.md`（工具面收口）。
> 一句话目标：**agent 从「能跑命令」升级为「能看、能引、能记、能动手」**——引得到上下文、看得见文件、记得住事情、操得动机器。

---

## 0. 结论速览

| # | 能力 | 现状一句话 | P0（一句话） | P1 | P2 |
|---|---|---|---|---|---|
| F1 | 选段提及 | 全仓 **零 `getSelection`**，消息文本只能整条引用（靠复制粘贴） | 选中任意消息片段 → 浮动「引用」→ 待发区 chip → 发送时以**结构化引用块**注入（零线协议变更） | 引用渲染成卡片 + 跨消息多选 + 引用锚点回跳 | 引用即对象（可折叠/可编辑/可撤回） |
| F2 | 文件侧边预览 | 只有 `GET /api/fs/browse`（**只列目录，不列文件**），没有任何读文件端点 | **零后端**：预览**会话内已出现**的内容（工具结果/消息文本/图片）+ 右侧覆盖式浮层 | 新增只读 `GET /api/fs/read` ⇒ 任意工作区文件 + diff 预览 | 真·第三栏 + 可编辑保存 + 多文件标签页 |
| F3 | 持久记忆库 | 全仓 **零 embedding/vector/memory-store** 代码；跨会话记忆只能靠人写 CLAUDE.md | **只读注入 memory/MEMORY.md**（两层来源 + turnContext 车道；零新工具/零依赖/零契约） | remember/forget 工具 + append-only entries.jsonl + 墓碑 + 管理 UI | 语义检索 + 冲突消解 + 记忆体检 |
| F4 | 真机操控 | 全仓 **零 CDP/puppeteer/playwright/webdriver** 代码；只有 shell/文件类工具 | **零依赖 CDP** 驱动 `chrome-headless-shell`：导航 + 可访问性树 + 截图 + 点击/输入 | 桌面路线（Xvfb + 注入工具）+ 权限/审批联动 | 远程/多机 + 录制回放 |

**跨能力主线**：三条新概念贯穿——**快照而非指针**（引用/预览都是内容快照，来源变了不静默改写）、
**append-only 是唯一真源**（记忆只有追加，没有回改）、**显式降级**（看不见/读不出/控不了，都要说出来，不静默）。

**建议实现顺序**：`F1 → F2 → F3 → F4(P0 浏览器) → F5(桌面)`。
理由：F1/F2 的 P0 **都是零后端改动**（引用序列化进消息文本、预览只吃会话内已出现的内容），**零线上风险、当天可验证**；
F3 的 P0 也是只读注入（零新工具/零依赖/零契约）；F4 最难（沙箱 + 进程生命周期 + 权限），**可行性 spike 先行**。

## 0.3 裁决记录（调研回来后由架构侧拍板，2026-09-19）

| # | 问题（W879/W886 提出的开放项） | 裁决 | 理由 |
|---|---|---|---|
| D1 | 选段提及 P0 是否接受「序列化进消息文本」 | **接受** | 后端不解析锚点、消息 DOM 会整批搬家；POST /api/turn 只有 input + 图片 attachments，加 context 字段会波及 core/日志/契约，成本远大于收益 |
| D2 | 文件预览 P0 是否只预览会话内已出现的内容 | **接受**，且把「任意工作区文件」列为紧随其后的 P1 | P0 零风险先落地；P1 只多一个只读端点，属可机械检验的契约变更 |
| D3 | 侧边预览用覆盖式浮层还是真·第三栏 | **覆盖式浮层** | 不动 #layout、零背景重排（前端铁律 5）；第三栏留 P2 |
| D4 | 引用是否做「内容已变」检测 | **存 hash + 来源标签，P0 不做过期提示** | 快照语义明确；hash 让去重与未来的过期提示都有据可依 |

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
| 文本附件 | `.md/.txt/.json` 等走「前端读文本 + 发送时注入」；**图片走 attachments 链**（魔数嗅探 + 像素尺寸） | `apps/web/src/ui/text-attach.ts`（W869），`docs/feature-multimodal-attachments/` |
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
**模块拆分（棘轮 ≤400 行/模块）**：`ui/quote/model.ts`（纯函数：模型/序列化/解析/转义/截断/去重）、
`ui/quote/select.ts`（选区监听 + 浮标，复用 `panelGeom` 落位）、`ui/quote/tray.ts`（chip 待发区，复用 attach-tray 形态）、
`styles/quote.css`；历史回放解析在 `ui/restore.ts` + 渲染在 `ui/messages/user.ts`。

**红线**：引用正文来自模型输出/工具结果 = **不可信输入**，进 DOM **必须走 `sanitizeNodes`**（`apps/web/src/utils/sanitize.ts:374`）；
**不得**在 composer 自身选区上弹引用（会自我引用）。

**验收**：纯函数测试（拼接/转义/截断/去重）+ jsdom 交互测试（选中→chip→发送）+ 历史解析回渲染 +
**伪造边界负控制**（正文含定界行必须被转义）+ 「不注入 composer 选区」负例。

---

## 2. F2 文件侧边预览

**P0（零后端改动）**：预览**会话内已经出现过的内容**——`read_file` 等工具结果全文已在 `.tool-out`
（`apps/web/src/ui/toolcards.ts:197-212`），代码高亮已有 `highlightCode()`（`apps/web/src/utils/hljs.ts:91`），
图片放大已有 `openLightbox()`（`apps/web/src/ui/attachment-view.ts:140-154`）。新建
`ui/preview/{detect,panel,renderers}.ts` + `styles/preview.css`；工具卡加「预览」按钮；
右侧**覆盖式浮层**（position:fixed 或 #main 内 absolute，**不动 #layout**，零背景重排）。
**降级**：二进制 / 超大 / 类型不明，一律给**可读原因** + 「复制路径」+「在文件管理器中打开」(`openFsBrowser`)。

**P1（需后端契约）**：新增只读 `GET /api/fs/read?path=&offset=&limit=`（语义对齐 `read_file` 工具：绝对路径、
UTF-8 fatal、含 NUL/C0 ⇒ 二进制、256 KiB 上限、分页、结构化错误），同步 `contracts/endpoints.json` +
`API_ENDPOINT_COUNT` 61→62 + contract-parity 测试。
**安全**：只读；不返回目录；**不跟随符号链接出界**。
**P2**：真·第三栏（动 #layout / 拖宽条）、逐行 diff 算法、可编辑保存。

**验收**：detect 纯函数测试 + jsdom 面板测试（开关不重建背景、竞态丢弃、Esc 层级、降级文案）；
P1 追加端点单测（二进制/分页/越界/不存在）+ 契约一致性测试。

---

## 3. F3 agent 持久记忆库

**P0（零新工具 / 零依赖 / 零契约改动）**：只读注入 **memory/MEMORY.md**，空则返回 null（零成本），
字节裁剪 + **显式截断标记**（照 `packages/core/src/skill-catalog.ts` 的纪律）。复用刚落地的两层来源模型
`readLayers() = [project, global]`：`project = <ws>/.celestea`（只读、随仓提交）、
`global = <CELESTEA_HOME>/workspaces/<ws>`（唯一可写）。注入走 **W884 的 `turnContext` 车道**
（`apps/studio/src/runtime/session-compose.ts:247,302`）——每轮 turn 起点重读、**user-role 历史**、
**绝不进 system**（system 冻结 10 段 / 8192 字节 / 缓存敏感）。

**P1（写入）**：新工具 `remember` / `forget`，写 `global` 层的 `memory/entries.jsonl`——**append-only 唯一真源**，
渲染出 `MEMORY.md`；内容 hash 去重 = NOOP；遗忘 = 追加墓碑。工具面 14 → 16（同步 `contracts/tools.json`）。
**P2**：`recall` 深检索 + 管理 UI + 冲突消解 + 语义检索（需 provider embedding，单独立项）。

**两条决定架构的本仓硬约束（W879 实读，带行号）**：
1. 写根 = `[workspace, ...grants.writeRoots]`（`packages/tools/src/guard/path-guard.ts:164,230`）⇒ **global 层在 workspace 之外，
   模型无法用 `write_file` 写记忆**，写入必须走**宿主工具**（同 `load_skill` 范式）；
2. 读根默认**不含** global 层 ⇒ 受限档位读不到 ⇒ **参考文件优先放 project 层**（workspace 内，始终可读）。

**硬约束（安全）**：记忆内容**永远以「数据」呈现，绝不作为指令**——注入时显式标注来源与时间。
防投毒、防无限增长、防跨工作区泄漏。
**许可证红线**：basic-memory = AGPL-3.0、cipher = ELv2 ⇒ **只借鉴设计，绝不抄代码**。
**反模式**：自动采集 + LLM 摘要无人在环、向量优先默认、benchmark 驱动、把记忆写进 system prompt。
**验收**：注入格式与裁剪纯函数测试 + 空记忆零成本断言 + **投毒负控制**（把指令性文本塞进记忆，断言它不被当系统指令）。

---

## 4. F4 真机操控（computer-use）

**分层**：L0 进程/文件（**已有** shell + 读写文件）→ L1 浏览器（CDP）→ L2 桌面（X11/Wayland 注入）。

**P0 = L1 浏览器，零依赖 CDP**：
- `chrome-headless-shell`（本机已有）+ Node 原生 `WebSocket`，**不引 Playwright**；
- 元素识别**优先可访问性树**（`Accessibility.getFullAXTree`，文本、可断言、可回归测试），截图作为补充；
- 动作：导航 / 点击 / 输入 / 滚动 / 取文本；
- 截图复用已有图像链（`read_image` 的 `tool_value.attachments`）。

**沙箱（W885 spike 实测，两条硬阻塞，缺一不可）**：
1. **RLIMIT_AS 必须豁免**：默认 `memMb=2048` ⇒ `--as=2048MB`，浏览器在打印任何日志前就 SIGTRAP(rc=133)。实测 2/3/4/8/16/32 GiB **全部 133**，**64 GiB 才 ALIVE** ⇒ 要的是**豁免**，不是调大数值。
2. **网络命名空间必须共享**：`bwrap --unshare-all` 下浏览器能起但 NET_ERR/LOCAL_ERR，且隔离 netns 里的 CDP 端点**宿主够不到**；`shareNet=true` 时外网与本机 127.0.0.1 都 200。

**可用组合（实测）**：userspace + `rlimits=false` ⇒ ALIVE + 写 /tmp + 外网/本机均 200；
bwrap + `rlimits=false shareNet=true` ⇒ ALIVE + 网络 200。**不可用**：任何 `rlimits=true` 组合（133）。
⚠️ `rlimits=true` 时**整条命令仍 exit=0**（只有浏览器死了）⇒ **不能用退出码判断可用性**，必须显式探测。

**性能（实测）**：冷启动到 ws:// 端点 0.084–0.168s（均值 0.115s，5/5 成功）；全链路 199–295ms；截图 23–51ms。
**进程**：每个浏览器 6–7 个进程；对 launcher 发 SIGTERM 后 +1.5s 全部回收无残留；2 并发实例均成功。
**安全代价（必须显式记录）**：需要 `--no-sandbox`（网页内容只能靠外层沙箱兜底）、CDP 本身无鉴权、bwrap 下 /tmp 是私有 tmpfs。
**AX 必须封顶**：Studio 首页实测 3687 节点 / 1.23 MB，整棵塞模型不可行 ⇒ 工具返回**裁剪过的 AX 文本快照** + PNG 图像。
浏览器进程生命周期**挂到会话**上，会话结束即回收，不留孤儿进程。

**权限**：走既有 grants/权限模型，首次使用需显式授权；被拒要**可见**。
**沙箱落地（实读结论，决定改动面）**：
- **网络已有现成授权通道**：`packages/tools/src/sandbox/provider.ts:154-159` 的 grant 会 OR 进 `shareNet`
  （`shareNet: envFlag(env[ENV_SANDBOX_NET], …) || grants.network === true`），且注释明写「只动 shareNet，
  shareTmp/seccomp/maskDirs/rlimits 一律保持运维设定不变」⇒ **浏览器工具只需申请 network 能力位**，不必新造机制。
- **地址空间没有豁免通道**：rlimits 是全局开关（`packages/tools/src/sandbox/limits.ts:111-112` `rlimitsEnabled(env)`），
  上限是全局 `memMb`（`:36,46` 默认 2048），落地为 `--as=<memMb*1024*1024>`（`sandbox/rlimit.ts:57`）/ `ulimit -v`（`:71`）。
  ⇒ F4 需要**新增一条按调用的豁免**（例如 `browser` 能力位 ⇒ 该次调用不加 `--as`，其余 rlimit 照旧）。
- **不能靠「把 memMb 调大」**：W885 实测 2/3/4/8/16/32 GiB **全部 SIGTRAP(133)**，只有 64 GiB 才活 ——
  现代 Chromium 会预留极大的**虚拟**地址空间（V8 指针压缩笼），`RLIMIT_AS` 与它天然冲突。
  豁免 AS 之后，内存兜底必须靠**别的层**（cgroup MemoryMax / 浏览器自身堆上限），这点要写进安全说明。

**工具面（W885 建议）**：`browser_open(url, viewport)` + `browser_act(click/type/key/scroll, target)`，
返回「裁剪后的 AX 文本快照 + PNG 图像」。**P1 = L2 桌面**：Xvfb + 注入工具（需 apt 安装，走运维流程与审计）。
**P2**：远程/多机、录制回放。
**未验证（W885 交底）**：真正 run_code broker/LLM 回路、`CELESTEA_SANDBOX_SECCOMP=1`、file:// 下载上传、Windows/macOS、长稳与 RSS。

**验收**：spike 报告（`docs/archive/research/computer-use-spike.md`）先行 → 工具面契约 → 沙箱兼容性测试（含 rlimit 断言）→
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

1. ~~本机 chrome-headless-shell 能否在产品沙箱里存活并监听回环端口~~ **已实测（W885 spike）**：能，但必须同时满足两条豁免（§4）；
2. ~~放宽 RLIMIT_AS 的最小可行值未知~~ **已实测**：2/3/4/8/16/32 GiB 全部 SIGTRAP(133)，**64 GiB 才 ALIVE** ⇒ 需要的是**豁免**；
3. 可访问性树在真实站点上的**体积与噪声**未知（可能大到塞不进上下文，需要裁剪策略）；
4. 记忆检索在**中文**上的 BM25 效果未验证（需要分词，零依赖分词是难点）；
5. ~~引用块与**已有文本附件块**在同一消息里共存时的渲染顺序未定~~ **已定（F1）**：用户正文 → 引用块 → 文本附件块（`withTextAttachments(serializeQuotes(t, quotes), items)`）；
6. `/api/fs/file` 的**授权边界**是否应复用会话 grants，还是仅限工作区根——待设计评审；
7. 桌面路线需要 apt 安装注入工具，**是否被允许**未与运维确认；
8. **F1 选段提及 P0 的已知限制**（架构侧裁决 2026-09-19，均已按「内容不丢」处理）：
   - **用户手打的合法块无法与真引用区分**：解析只在 `role==="user"` 且要求「定界行 + `[引用 …]` header + 以 `"> "` 开头的正文 + 闭合定界行」齐全；用户手工粘贴一个格式完全合法的块会被当作引用（内容不丢、模型仍看到原文）。不转义用户正文本身（转义会改变发给模型的原文）。
   - **流式 assistant 选区**：`.content` 每个渲染 tick 会 `replaceChildren`，浮标只存「选区字符串 + 来源元数据」、不持有 Range；选区在点击前失效时浮标锚点可能过时（视觉偏移，不崩）。
   - **hash 只存客户端、不入 wire**：历史解析出的引用 `hash=''`（仅供渲染，不再进待发区；去重键退化为文本键）。
   - **总量上限由待发区守卫保证**（单条 8 KiB / 单条消息 32 KiB / 最多 8 条）；`serializeQuotes` 的防御性截断在**绕过待发区**直接调用时可能丢弃尾部块（正常路径不触发）。
