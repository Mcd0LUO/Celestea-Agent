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

- 作者与提交者统一为 `Mcd0_LUO <216637672+Mcd0LUO@users.noreply.github.com>`。
- 提交消息**用文件传入**（`git commit -F <file>`）。
  **为什么**：消息里的反引号会被 shell 当命令替换 —— 本仓真实事故：一次提交消息里写了 `pnpm run build`，shell 真的执行了全量构建，还把构建日志嵌进了提交消息。

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
# 5) 发布（必须 pnpm：npm pack 不重写 workspace:*）
pnpm -r publish --access public
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

## 6. 环境坑（本机专属，别再踩）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| DSH 的 write/edit 落地 `root:root` | 后续写入 `EACCES`，别人无法编辑 | 写完立刻 `sudo chown celestea:celesdev` + `chmod 644` |
| `pnpm --dir apps/web run check` **不重建** | 量的是旧 dist，棘轮基准记错 | 量产物必须走会重建的入口：`pnpm check` 或 `pnpm run build` |
| `RLIMIT_AS` 与 Chromium 不兼容 | 浏览器进程 SIGTRAP（133） | 浏览器调用走 `noAddressSpaceLimit` 豁免 |
| benchmark 跨运行噪声 | 同一提交两次跑 p50 2.6% / p90 12.6% | 别信单次对比的 <10% 变动；认真对比用 `--repeat 3` |
| 时序敏感用例 | 并发构建时 flaky（本仓真实发生过 2 条） | 静默条件下重跑；不要用「flaky」搪塞，要定位 |

---

## 7. 写代码的取向

- **机械门禁优先于人的记性**：任何「别忘了」都应该变成一条断言。本仓已有：文案门禁、契约计数、体积棘轮、发布门禁、README 硬数字。
- **平台是参数，不是常量**：路径/平台判定走可注入 seam（`isAbsolutePath` / `parentDir` / `joinPath` / `platformGates()`），这样 win32 分支能在 Linux 上测。
- **诚实降级 > 静默放行**：能力缺失时按策略**降级并说清**，或 fail-closed 报结构化错误，绝不假装成功。
- **注释写「为什么」**：尤其是反直觉的决定与已知代价（例：`check-version.mjs` 明写它不再察觉 dist 落后于 HEAD）。
- **不改用户没要求的东西**：范围纪律写在提交消息的「刻意没做什么」里。

---

## 8. 一句话总结

> 改一处 → 跑全量 → 变异验证 → 真机确认 → 提交写清为什么 → 需要发布时先 tag 再 build。

任何一条门禁挡了你，先假设**门禁是对的**：本仓历史上每一次「门禁误报」最后都查出了一个真问题。
