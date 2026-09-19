# AGENT.md — 开发与提交规范（本仓 AI agent 的工作协议）

> 状态：**当前**。本文是「怎么在本仓干活」的操作协议，不是架构说明（那在 `ARCHITECTURE.md`）。
> 对象：在本仓工作的 AI agent（含被派工的 worker）与人类协作者。
> 每条规则都来自真实踩过的坑；括号里写的是**为什么**，不是风格偏好。

---

## 1. 铁律（违反即视为未完成）

| # | 规则 | 为什么 |
|---|---|---|
| 1 | 改完必须跑**全量** `pnpm check`，绿了才算完成 | 单跑子集必漏：类型 / lint / 架构 / 测试 / 前端 5 类门禁在 5 个地方 |
| 2 | 每条新断言配一个**变异负控制**（改坏 → 必须红 → 还原 → 绿） | 断言经常是空转的。本仓真实案例：`bin` 断言永远为真（npm 无条件带上），改坏也不红 |
| 3 | UI 改动必须**真机**验证（headless shell + CDP），且断言**非零几何 + 可见性 + 截图** | 「只数 DOM 节点」曾让一个面板不可见的 bug 全绿通过 |
| 4 | 不许相信 worker 的自述报告；关键结论**自己重跑** | 真实案例：worker 报 `CHECK_EXIT=0`，但用的是不重建的入口，量的是旧产物 |
| 5 | 契约数字**三处一致**：`API_ENDPOINT_COUNT` == `contracts/endpoints.json` == `FROZEN_COUNTS` | 只改一处会静默漂移 |
| 6 | 不许提交派生产物（`dist/`、`apps/studio/webdist/`、`packages/core/contracts/`） | 它们是构建产物，已 gitignore，并由 release 门禁机械兜底 |
| 7 | 同一时间**只允许一个 builder**（构建 / 测试 / benchmark） | 并发会让时序敏感用例 flaky、让 benchmark 数字失真 |
| 8 | 不跑 `--no-verify`，不绕过任何门禁 | 门禁存在的唯一理由就是它不给人情 |
| 9 | **npm 发布必须有人类显式授权**：没有授权绝不推 npm | 发布不可逆（版本不能再发、tarball 永久公开），不能是「走完发布清单」的副作用。机械实现：`pnpm run publish` 在 `CELESTEA_PUBLISH_AUTHORIZED=1` 缺失时 fail-closed |

---

## 2. 完成定义（Definition of Done）

1. **聚焦测试**：新行为有测试；纯函数优先，DOM 用 jsdom，跨平台用可注入 seam。
2. **变异负控制**：把实现改坏一次，确认测试**真的**变红（不是「我觉得会红」）。
3. **全量 `pnpm check` 绿**：`typecheck → lint → lint:arch → test → check:web`。
4. **棘轮按真实测量调整**：产物体积 / 模块体积只按实测上调，并在文件里**写明增量构成**。
5. **文档同步**：新增文档必须登记进 `docs/README.md` 的文档地图。
6. **归属干净**：`find . -user root -type f`（排除 `node_modules`/`.git`/`dist`）应为空。

---

## 3. 提交规范

### 3.1 消息格式

```
<type>(<scope>): <祈使句，说清改了什么>

<为什么>：症状 → 根因 → 修法。要能让人只看消息就判断该不该回滚。

<怎么验证>：跑了什么、变异负控制怎么红、真机证据在哪。

<刻意没做什么>：范围纪律（例如「未动逻辑 id 里的 /」「未改后端契约」）。
```

- **type**：`feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore` / `release` / `security` / `i18n`
- **scope**：受影响的子系统（`win` / `bench` / `release` / `i18n` / `g4` / `security` …）。
- 主题行 ≤ 72 字符，**不加句号**，用祈使语气（「fix the X」不是「fixed the X」）。
- 正文写**为什么**，不要复述 diff（diff 自己会说改了什么）。
- 破例要在正文里说明（例如「本文与禁止项字面冲突，按任务要求改了护栏 A 的逻辑」）。

### 3.2 粒度与边界

- **一次提交 = 一个逻辑变更**。跨子系统的机械改动（如全仓改名）单独一条。
- 按**文件**分组提交，不按 hunk 混提。
- 派工产出由**派工者**提交（worker 不做任何 git 写操作：`add` / `commit` / `stash` / `checkout` / `restore` / `clean`）。

### 3.3 身份与签名

- **提交身份（作者/提交者）是本机事实，不是仓库规则**：用什么名字/邮箱由这台机器决定，写在 `docs/AGENT.local.md`（不入库）。
  仓库只要求两条：**不要混用身份**（一条历史里出现多个人格会让 `git log` 失真）、**提交消息用文件传入**（`git commit -F <file>`）。
  **为什么用文件**：消息里的反引号会被 shell 当命令替换 —— 本仓真实事故：一次提交消息里写了 `pnpm run build`，shell 真的执行了全量构建，还把构建日志嵌进了提交消息。

### 3.4 不许进仓的东西

- 构建产物（见铁律 6）、`.env`、任何凭据、`node_modules`。
- 真实会话数据 / 附件 / 私人对话（`fixtures/sessions/*` 已默认忽略，合成 fixture 用 `!fixtures/sessions/test-*` 例外）。
- 备份文件（`*.bak` / `*.orig`）与一次性迁移脚本：**用完即删**，git 历史就是归档。

---

## 4. 发布流程（顺序不能错）

```bash
# 1) 干净树 + 全量门禁绿
pnpm check
# 2) 11 个 manifest 一起升版本（root + 10 个可发布包）
sed -i 's/"version": "2.7.2"/"version": "2.7.3"/' package.json apps/*/package.json packages/*/package.json
git commit -m 'chore(release): 2.7.3'
# 3) 先打 tag，再构建 —— 版本号由 git describe --tags 派生
git tag -a v2.7.3 -F <message-file>
# 4) build + 机械发布门禁
pnpm run release
# 5) 发布 —— 需要主人授权（铁律 9）。必须走 pnpm：npm pack 不重写 workspace:*
CELESTEA_PUBLISH_AUTHORIZED=1 pnpm run publish
# 6) 从**真实 registry** 装一遍验证（不是本地 tarball）
npm install -g --prefix /tmp/x celestea-agent@2.7.3 && /tmp/x/bin/celestea --version
```

**为什么先 tag 再 build**：前端版本来自 `git describe --tags`。先 build 后 tag 会让 2.7.1 的包自称 2.7.0 —— `scripts/release-check.mjs` 现在会拦这一条。

**发布门禁（`pnpm run release`）拦什么**：webdist 陈旧 / 产物版本 ≠ 发布版本 / manifest 不可发布 / 11 个版本不一致 / tarball 里出现 `workspace:` 或源码或凭据 / **必需路径缺失**（```celestea/core` 少 `contracts/` 装完起不来；```celestea/studio` 少 `webdist/` 没界面）。

**npm CDN 传播延迟是常态**：新版本发布后逐个包可见，可能滞后几分钟。装之前先轮询 `npm view <pkg>@<v> version` 直到全部就绪。

---

## 5. 派工协议（worker）

- **一个 builder**：同一时刻只有一个 worker 在构建/测试/跑 benchmark（见铁律 7）。
- **文件边界要写死**：例如「你只动 `apps/web/**`，不要碰 `apps/studio/**` 与 `packages/**`」。
- **契约文件独占**：同一时刻只有一个 worker 拥有 `contracts/endpoints.json` + `routes.ts`。
- **收尾自查归属**：`find apps/web -user root -type f`（DSH 的 write/edit 会落地成 root:root，必须 chown，否则别人连变异都写不进去）。
- **报告要求**：改了哪些文件 / 逐条审计结论（没问题也要写「查了 X，因为 Y 安全」）/ 测试 / 变异负控制红绿 / 真机证据 / 刻意没做什么。

---

## 6. 工具链与验证的坑（跟仓库走，不随机器变）

> **本机特有的事实**（路径 / 账号 / 凭据位置 / 端口 / 这台机器装了什么）**不写在这里**：
> 本文要提交进仓库，写死一台机器的信息只会误导别人。请复制模板填你自己的机器，
> 它已被 `.gitignore` 忽略、永不入库：
>
> ```bash
> cp docs/AGENT.local.md.example docs/AGENT.local.md
> ```

| 坑 | 现象 | 正确做法 |
|---|---|---|
| 工具写入的文件可能不属于你（例如 DSH 的 write/edit 会落地 `root:root`） | 后续写入 `EACCES`，**别人连变异都写不进去** | 写完立刻把归属改回**你自己**（`sudo chown "$(id -un):$(id -gn)" <files>`）+ `chmod 644`；收尾自查 `find . -user root -type f` |
| `pnpm --dir apps/web run check` **不重建** | 量的是旧 dist，棘轮基准记错 | 量产物必须走会重建的入口：`pnpm check` 或 `pnpm run build` |
| **源码直跑**依赖 `tsconfig` 的 `paths` | `pnpm --dir apps/studio start`（= `tsx src/main.ts`，cwd 在 `apps/studio`）就近读该目录的 tsconfig；它若只继承 `tsconfig.base.json`（无 `paths`），`@celestea/*` 就落到 gitignored 的 `packages/*/dist/` —— 你以为在跑源码，其实在跑**上一次构建的产物**，全新检出直接 `ERR_MODULE_NOT_FOUND` | 跑源码的入口配置必须继承**根** `tsconfig.json`；`tsconfig.build.json` 反过来**不带** `paths`（构建要按依赖顺序解析各自 dist）。机械兜底：`tests/tsconfig-paths.test.ts` |
| `RLIMIT_AS` 与 Chromium 不兼容 | 浏览器进程 SIGTRAP（133） | 浏览器调用走 `noAddressSpaceLimit` 豁免 |
| benchmark 跨运行噪声 | 同一提交两次跑 p50 2.6% / p90 12.6%（**本仓开发机实测；换机器请自测，量级可能不同**） | 别信单次对比的 <10% 变动；认真对比用 `--repeat 3` |
| 时序敏感用例 | 并发构建时 flaky（本仓真实发生过 2 条） | 静默条件下重跑；不要用「flaky」搪塞，要定位 |

---

## 7. 文档规范

**一个事实一个家**：规则写在它的家里，别处只链接。

| 层 | 放什么 | 不放什么 |
|---|---|---|
| 根 `README.md` | 展示与快速开始（是什么 / 怎么装 / 怎么跑） | 配置项全表、部署细节、开发流程 → 各自的家 |
| `docs/AGENT.md`（本文） | 工作协议：铁律、完成定义、提交规范、发布顺序、派工、文档规范 | 架构细节（→ ARCHITECTURE）、配置（→ configuration） |
| `docs/ARCHITECTURE.md` | 架构契约：分层、包职责、插件缝、规模政策、命名/错误/日志/测试约定（§6） | 决策的理由与历史（→ 设计文档）、实现状态 |
| `docs/configuration.md` / `deployment.md` | 可执行的配置与运维口径 | 架构解释（链接过去） |
| `feature-*.md` / `iteration-*.md`（或拆出的 `feature-*/README.md` + 分册） | 某个特性的**设计依据与验收标准**（为什么这么设计） | 当前行为的复述（→ ARCHITECTURE） |
| `docs/archive/` | **历史文档**（调研 / 迁移 / 退役）：顶部 `📦 历史文档` 横幅 + `历史参考` 状态；不逐篇登记 | 现行口径（链接回 `docs/`） |
| `docs/AGENT.local.md` | **本机事实**（路径/账号/凭据位置/端口），**不入库** | 任何仓库级规则 |

**写作纪律**：

1. **只写当前状态**。历史沿革、W 编号、日期不是正文，是记录 —— 放进对应的设计文档或交给 git 历史。
   正文描述「现在是什么样」，让人照它做事不会错。（这条是学 DSH 的：他们把决策记录与现行文档分开，我们混着写过。）
2. **状态行必须有**，类别是**闭集**：`当前` / `已实现` / `设计` / `历史参考` / `已废弃`。
   解释文字里**不要再出现别的类别词** —— 写过「设计稿 / 未实现」的解释会让整篇被判成设计（真实踩过）。
3. **新增文档必须登记**进 `docs/README.md` 的地图；地图状态列必须与文档状态行**同类**。
4. 相对链接必须可达（带锚点的要命中目标标题）。
5. **单篇 ≤ 700 行**。超了就按章节拆进同名子目录（`docs/<名字>/README.md` 作索引 + 分册），索引登记进地图、分册不登记。
   **为什么是硬上限**：超过这个长度就不是「能一次读完的一篇」，而是一本需要目录的书；拆开才有人读。
6. **提交进仓的文档不含本机事实**（提交身份 / 绝对路径 / 端口 / 凭据位置）—— 那些进 `AGENT.local.md`。
7. **归档不是删除**：过时文档 `git mv` 进 `docs/archive/`，加 `📦 历史文档` 横幅与 `历史参考` 状态，**不删正文**。

**这些不靠自觉**：`tests/doc-conventions.test.ts` 机械检查七条 —— ① 登记与地图链接 ② 状态存在且与地图同类
③ 相对链接与锚点 ④ 单篇 ≤ 700 行 ⑤ 提交进仓的文档不含本机提交身份 ⑥ 归档文档带横幅与历史状态
⑦ 分册必须从它的索引可达；违反即 `pnpm check` 红。
生成物（如 `docs/performance-baseline.md`）的状态行由**生成器**输出，别手改。

---

## 8. 写代码的取向

- **机械门禁优先于人的记性**：任何「别忘了」都应该变成一条断言。本仓已有：文案门禁、契约计数、体积棘轮、发布门禁、README 硬数字、文档规范、源码直跑解析。
- **「本机能跑」不等于「干净机器能跑」**：本机常年有 `dist/`、缓存、`node_modules`，于是「依赖上一次构建」「依赖本机工具」的坑只在别人的机器上现形。CI（`.github/workflows/ci.yml`，ubuntu + windows）就是那个干净机器；加它第一天就抓出一个全新检出起不来的真 bug。
- **平台是参数，不是常量**：路径/平台判定走可注入 seam（`isAbsolutePath` / `parentDir` / `joinPath` / `platformGates()`），这样 win32 分支能在 Linux 上测。
- **诚实降级 > 静默放行**：能力缺失时按策略**降级并说清**，或 fail-closed 报结构化错误，绝不假装成功。
- **注释写「为什么」**：尤其是反直觉的决定与已知代价（例：`check-version.mjs` 明写它不再察觉 dist 落后于 HEAD）。
- **不改用户没要求的东西**：范围纪律写在提交消息的「刻意没做什么」里。

---

## 9. 一句话总结

> 改一处 → 跑全量 → 变异验证 → 真机确认 → 提交写清为什么 → 需要发布时先 tag 再 build。

任何一条门禁挡了你，先假设**门禁是对的**：本仓历史上每一次「门禁误报」最后都查出了一个真问题。
