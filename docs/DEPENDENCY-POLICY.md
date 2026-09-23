# 依赖与工具链策略

> 状态：**当前**（W847 W0 建立）。适用对象：本仓所有依赖声明（package.json / pnpm-lock.yaml / pnpm-workspace.yaml）。
> 本文件是「谁更新、怎么验证、怎么回滚、为什么 audit 不进门禁」的唯一权威。

## 0. 一句话

依赖更新是**显式的、有人负责的、可复现的**动作；pnpm check 是唯一合并前门禁；
pnpm audit 是**诊断**，不是门禁。

## 1. 责任与节奏

- 更新负责人：architect（合并门禁的持有者）。worker 只能改自己那一波明确点名的包，不得顺手升别的。
- 一批升级 = 一个 commit；一批只动一类（例如「W0 补丁级」/「W1 vite」）。
- 触发：Renovate/人工发现、安全公告、或计划窗口。当前没有自动化，见 §6。

## 2. Node 版本带（已落地）

- 支持带写在根 package.json 的 engines.node = ">=24.0.0 <27.0.0"；.nvmrc = 26。
- 启动守卫：scripts/check-node.mjs（只做版本判断、零依赖）由 scripts/run-studio-ts.sh 在**生产启动路径**调用；
  越界或 engines 不可解析都 fail-loud 退出，绝不静默降级。
  为什么不用 apps/studio 的 prestart：实测 pnpm 11 默认不自动执行 pre/post 脚本
  （enable-pre-post-scripts 默认 false），prestart 会静默不触发 —— 正是要避免的失败形态。
- pnpm 侧：pnpm-workspace.yaml 的 engineStrict: true 让 pnpm install 对越界 Node 直接失败
  （ERR_PNPM_UNSUPPORTED_ENGINE）。升级 Node 的流程见 §4。

## 3. 安装与锁（已落地）

- 唯一锁：根 pnpm-lock.yaml（shared-workspace-lockfile 默认 true；apps/web 与 apps/studio 不各自锁）。
- 冻结策略写在 pnpm-workspace.yaml（frozenLockfile: true）。
  - 实测 pnpm 11.22.0：当 pnpm-workspace.yaml 存在时，project 设置从它读取，**.npmrc 被忽略**
    （对 .npmrc 里的键，pnpm config get --location project engineStrict 返回 undefined，且只改 manifest
    不动锁时 pnpm install 仍会改锁）。因此 .npmrc 保留同义键只作 npm 兼容镜像，权威键在 pnpm-workspace.yaml。
- 三种命令的实测行为（pnpm 11.22.0，本仓）：
  1) pnpm install（锁与 manifest 一致）→ 退出 0，Already up to date。
  2) pnpm install（manifest 改了、锁没跟上）→ 退出 1，ERR_PNPM_OUTDATED_LOCKFILE，并提示
     pnpm install --no-frozen-lockfile。
  3) pnpm add <pkg> → 退出 0：add/remove 是**显式变更**，绕过冻结默认并自动改锁。
     pnpm add --no-frozen-lockfile 在 pnpm 11 是**未知选项**（不要用）；如需强制，用
     --config.frozen-lockfile=false。
- 结论：冻结只拦「install 悄悄改锁」；显式 add/remove 仍可用，但作者必须在同一 commit 里带上锁，
  并把 before/after outdated 写进报告。

## 4. 验证协议（每次升级）

1. 在**独立 checkout**（不是共享工作树）里：
   pnpm install --frozen-lockfile && pnpm check && pnpm --dir apps/web run build
2. 只改依赖/配置的批次，必须附 pnpm outdated -r 前后对比，证明「只动了本波点名的包」。
3. 若改了实现（如替换依赖）：先写**对照测试**（用旧实现冻结期望值），先跑红再跑绿；不允许同义反复。
4. 前端产物体积/模块棘轮如有变化，按真实测量更新 baseline 并写归因；本波不该动前端产物。
5. 记录到 /server-center/runtime/worker-exec/results/ 的波次报告（改动 + 行号 + 原始输出）。

## 5. 回滚

- 单 commit 回滚：git revert <sha> → pnpm install（锁也回滚时用 pnpm install --no-frozen-lockfile）→ 重启服务。
- 数据不受影响（运行数据在 /var/lib/celestea-agent，不随依赖变化移动）。
- 前端：git revert 后 pnpm --dir apps/web run build 覆盖 dist；后端：重启 celestea-studio-ts.service。

## 6. 更新感知（现状与机制）

- 现状：无 Renovate/Dependabot、无 CI；不会自动提醒新版本/CVE。
- 诊断脚本：pnpm deps:audit = pnpm audit; pnpm outdated -r。**明确不在 pnpm check 里。**
- 为什么 audit 不进门禁：
  a) 非确定性：advisory 库与注册表快照会变，代码没动也会红；
  b) 当前 advisory 全是 dev=true（vite/vitest/esbuild 的 dev server 与测试工具），直接进门禁会把所有改动卡死；
  c) 根 check 已串了真机 e2e（打 3777），再叠网络依赖会放大抖动。
- 手工跑时机：每周一次、每次升级窗口前后、安全公告后；输出记入波次报告或审计日志。
- 长期（未做）：把 deps:audit 接成 systemd timer/cron；Renovate 先 alert-only（分组、schedule、
  automerge 只限 dev patch 且 gate 绿），等 CI-safe 测试画像（隔离 3 个真机测试）落地再开 automerge。

## 7. 当前外部运行时依赖（W0 后）

- apps/studio：hono、@hono/node-server。
- apps/web（出货）：highlight.js、katex（动态 chunk）、marked。
- packages/tools：无外部运行时依赖（W0 移除了头解析第三方库，改仓内 attachments/image-header.ts）。
- packages/core、session、llm、agent-loop、workers、runtime：无外部运行时依赖。
- 开发工具：typescript、vite、esbuild、vitest、jsdom、eslint、typescript-eslint、dependency-cruiser、
  tsx、@types/node、@types/marked、@vitest/coverage-v8。
- **@vitest/coverage-v8 是诊断工具，不是门禁**（与 deps:audit 同一定位，见 §6）：
  `pnpm test:coverage` 出数，**不设 thresholds、不进 `pnpm check`**。理由与 §6 拒绝 audit
  进门禁完全同源 —— 覆盖率随平台/运行波动，进门禁就会制造「代码没动却红」的假红。
  它是 vitest 已声明的 optional peerDependency（版本随 vitest 走），不是新的版本解析面。
- 注意：tsx 是 devDependency，却是生产的实际运行时（systemd → run-studio-ts.sh → pnpm start → tsx src/main.ts）。

## 7.1 W896 批次记录（2026-09-22）

- 新增 devDependency：`@vitest/coverage-v8@5.0.1`（+13 个传递包，全部 dev-only）。
  动机：仓库有 2537 条用例却**零覆盖率度量**，无法回答「测试是否覆盖了被测代码」；
  诊断命令 `pnpm test:coverage`，不进 `pnpm check`（§7 的定位说明）。
- 同批：测试收敛（合并小文件）+ 补 `test:coverage` 脚本 + `.gitignore`/`eslint ignores` 收 `coverage/`。
- 未动：任何运行时依赖；packages/* 的零依赖取向。

## 8. W0 批次记录（2026-09-18）

- @types/node 24.13.3 → 26.6.1（对齐 Node 26）；hono 4.13.7 → 4.13.8；jsdom 30.0.1 → 30.1.0；
  esbuild（apps/web，dev）0.21.5 → 0.28.2。
- 移除 packages/*/src 唯一外部运行时依赖（头解析第三方库），改仓内 parser + 冻结期望值对照测试。
- 新增 .npmrc / .nvmrc / scripts/check-node.mjs / engineStrict / frozenLockfile。
- pnpm outdated -r：13 → 9（移出：@types/node、esbuild、hono、jsdom；剩余为 W1–W4 范围）。
- 未动：vite、typescript、vitest、eslint、dependency-cruiser、marked、katex、@hono/node-server、contracts/。

