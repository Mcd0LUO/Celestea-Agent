# scripts/perf/ — 前端性能侦测工具包（W9111）

零依赖（只用 Node 内置 + 全局 WebSocket），**不碰被测源码**，不动共享工作树。

## 它做什么

| 文件 | 作用 |
|---|---|
| `lib/cdp.mjs` | 极简 CDP 客户端（WebSocket 上的 JSON-RPC + 事件） |
| `lib/chrome.mjs` | 启动 headless Chrome（profile 写 `$TEMP`） |
| `lib/backend.mjs` | **确定性假后端**：真 EventSource / 真 SSE 帧，帧时序由 `/__control/burst` 驱动 |
| `lib/server.mjs` | 静态服务器（早期版本，保留） |
| `lib/app.mjs` | 装配 + `waitFor` / `control` |
| `lib/probe.mjs` | 注入页面的只读探针：rAF 帧节拍 + LoAF 归因 + MutationObserver |
| `lib/scenario.mjs` | 场景公共件（动态 import 应用模块、取 pane、发突发） |
| `lib/stats.mjs` | 中位数/p95/max、原始 JSON 与 markdown 表落盘 |
| `cases/q1-think.mjs` | 问题 1：大思考块阈值曲线 + 真 SSE 突发 |
| `cases/q2-virtual.mjs` | 问题 2：600/1200/3000 列滚动与回收 |
| `cases/q3-mutation.mjs` | 问题 3：四场景 DOM 增删量化 |
| `cases/q4-memory.mjs` | 问题 4：CDP 堆指标 + 持有者计数 + 分配归因 |
| `verify.mjs` | 复核既有声明（DOM 上限 / ops / oversize / cadence / think 预算） |
| `focus-*.mjs` | 焦点复现（每个对应报告里一条结论） |
| `run.mjs` | 总入口：`node scripts/perf/run.mjs q1 q2 q3 q4` |

## 前置：冻结检出 + Vite 转换服务

测量必须在**冻结版本**上做，否则并发 worker 的改动会让数字不可复现。

```bash
# 1) 导出当前 HEAD 到 $TEMP（不碰工作树）
$tmp = Join-Path $env:TEMP 'perf-w9111'
$repo = Join-Path $tmp 'repo'
New-Item -ItemType Directory -Path $repo -Force | Out-Null
git archive HEAD | tar -x -C $repo
# 2) node_modules 用 junction 指回共享工作树（不重装、不写 .pnpm）
cmd /c mklink /J "$repo\node_modules" "<本仓>\node_modules"
cmd /c mklink /J "$repo\apps\web\node_modules" "<本仓>\apps\web\node_modules"
# 3) 起 Vite（只做 TS→JS 转换与 CORS，不写共享 dist）
cd $repo\apps\web
node node_modules/vite/bin/vite.js --port 3787 --strictPort --host 127.0.0.1
```

Chrome 在 `C:/Program Files/Google/Chrome/Application/chrome.exe`（实测 153.0.8010.53）。

## 跑

```bash
cd <本仓>
node scripts/perf/smoke.mjs                      # 冒烟：前端起得来 + SSE 通
node scripts/perf/run.mjs q1 q2 q3 q4            # 四个必答问题
node scripts/perf/verify.mjs                     # 复核既有声明
node scripts/perf/focus-toolrate.mjs             # P0：工具卡速率 vs 冻结
node scripts/perf/focus-toolcost.mjs             # P0 归因：单次工具事件代价
node scripts/perf/focus-scroll.mjs               # 滚动退化曲线
node scripts/perf/focus-ops.mjs                  # DOM 上限与 ops
node scripts/perf/focus-think-ledger.mjs         # thinkBudget 账本漂移
```

原始数据与表格落到 `results/perf-w9111/`（gitignored）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `W9111_REPO` | `%TEMP%/perf-w9111/repo` | 冻结检出根 |
| `W9111_VITE` | `http://127.0.0.1:3787` | Vite 转换服务 |
| `W9111_RESULTS` | `results/perf-w9111` | 结果目录 |

## 为什么不用 playwright / puppeteer

本仓 `node_modules` 里没有它们，装它们要跑 `pnpm install` 重写 `.pnpm` 目录 —— 那会
干扰并发中的其他 worker。Node 22+ 有全局 `WebSocket`，直接说 CDP 协议就够。
