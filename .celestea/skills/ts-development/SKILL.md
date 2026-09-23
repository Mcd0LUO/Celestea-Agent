---
name: ts-development
description: Use this skill whenever you write, review or fix TypeScript code in this repo. It states the gates that must pass before you call anything done, the module-boundary and size rules, the test and mutation-control conventions, the bundle and module-size ratchets, and how to verify frontend changes. Load it before touching TS source.
license: MIT
metadata:
  scope: typescript
  authority: docs/ARCHITECTURE.md
---

# TypeScript 开发规范（本仓）

> 只管 **TypeScript 开发**：类型与边界、规模、测试、门禁、棘轮、前端验证。
> 服务器运维 / 派工 / 发布流程不在本 skill（见 `docs/AGENT.md` 与 LTS）。
> 架构规则正文在 `docs/ARCHITECTURE.md`——本文是**可操作的那一面**，冲突以它为准。

## 1. 门禁：改完必须全量绿

```
pnpm check = typecheck && lint && lint:arch && test && check:web
```

| 段 | 命令 | 管什么 |
|---|---|---|
| typecheck | `tsc --noEmit -p tsconfig.json` | 类型 |
| lint | `eslint .` | 规模硬线 + 导入边界（单文件粒度） |
| lint:arch | `depcruise --config .dependency-cruiser.cjs` | 分层与依赖方向（跨文件） |
| test | `vitest run` | 单测 / DOM / 契约 |
| check:web | `apps/web` 构建 + 产物门禁 | 体积棘轮 / 折叠默认 / 版本自洽 / 文案 |

**单跑子集必漏**——五类门禁在五个地方，绿了才算完成。任何一条挡了你，先假设门禁是对的。

## 2. 类型与模块边界

- **依赖只能向下**：`core ← session / llm / tools / agent-loop / workers ← runtime ← apps/studio`。
  反向依赖、同层横向依赖、跨层上跳都是错误。
- **跨包只走包入口**：只允许 `import ... from "@celestea/<pkg>"`；
  `@celestea/<pkg>/src/...`（深层导入）与 `../../other/src/x.js`（相对跨包）一律拒绝。
- **公开 API 收口在 `src/index.ts`**：包外能看到的只有该入口导出的符号。
- **一切皆插件**：新能力 = 新增 seam 实现 + 在装配处注册；
  禁止在 `core` 里写 `if (provider === "x")` 这类分支。
- **需要横向能力时**只有一条合法出口：把能力定义成 seam 放进 `core`，实现在下层注册。
- **例外只能登记**在 `eslint.config.js` 的 `ARCH_EXCEPTIONS`（唯一真源），
  逐条写「原因 / 拆分方案 / 移除阶段」；**禁止就地 `// eslint-disable`**。

## 3. tsconfig paths：你以为在跑源码，其实在跑产物

靠 `paths` 做源码直跑时，入口的 tsconfig 必须继承**根** `tsconfig.json`。
若某个入口只继承 `tsconfig.base.json`（无 `paths`），`@celestea/*` 会落到
**gitignored 的 `packages/*/dist/`** —— 你改的源码不生效，量的是上一次构建的产物。

- 跑源码的入口配置：继承**根**（带 `paths`）。
- 构建配置（`tsconfig.build.json`）：反过来**不带** `paths`（按依赖顺序解析各自 dist）。
- 机械兜底：`tests/tsconfig-paths.test.ts`。

## 4. 规模硬线（`pnpm lint` 机械检查）

| 指标 | 上限 | 建议 | 规则 |
|---|---|---|---|
| 单文件行数 | **400** | ≤ 300 | `max-lines` |
| 单函数行数 | **80** | ≤ 50 | `max-lines-per-function` |
| 控制流嵌套 | **4** | ≤ 3 | `max-depth` |
| 形参个数 | **5** | ≤ 3 | `max-params` |
| 回调嵌套 | **4** | ≤ 2 | `max-nested-callbacks` |

- **空行与注释不计费**（`skipBlankLines + skipComments`）——写注释永远不亏。
- **测试文件的唯一放宽**：单条 `it()` 的回调放宽到 **150 行**；
  文件级 400、嵌套、参数、回调嵌套对测试**同样生效**。超 150 行就拆成多条 `it()`。
- 超限的四种拆分范式（按优先级）：按职责拆文件 → 按阶段拆函数
  （`parse → validate → project → emit`，主函数只做编排）→ 抽配置对象 → 登记例外。
- 规模的目的是**可读与可替换**，不是数字本身。把 5 个函数压成一行、
  或把所有参数塞进一个 `any` 对象绕过 `max-params`，都视为违规。

## 5. 测试约定

1. **位置**：单元测试与被测文件同级（`packages/<pkg>/src/*.test.ts`）；
   跨包契约测试、端到端回放放 `tests/`。
2. **命名**：`describe(<被测单元>)` + `it(<可观察行为>)`；不写「应该」式散文。
3. **每条 seam 契约必须有测试**；纯逻辑优先镜像参考实现单测，实现与参考实现用 fixture 对拍。
4. **测试可 import 自己被测的包**（`*.test.ts` 豁免横向导入限制）。
5. **不要 mock 掉被验证的 seam 本身**；要 mock 的是 HTTP、进程、时钟、文件系统这类外部边界。
6. **金标准来源优先级：运行中的实机 > 参考实现单测 > TS 自洽**。
   前两者产出的 fixture 入库；自洽对比必须在报告里标注 `derived`。
7. 跨平台逻辑走可注入 seam（`isAbsolutePath` / `parentDir` / `joinPath` / `platformGates()`），
   这样 win32 分支能在 Linux 上测。

## 6. 变异负控制：断言必须会红

**每条新断言都要配一次变异**：把实现改坏 → 断言**必须真的变红** → 还原 → 绿。
「我觉得它会红」不算证据——**空转的断言是常态，不是例外**。

真实案例：某断言永远为真（工具无条件带上那个字段），改坏也不红。
另一种空转：**只数 DOM 节点**——「节点数量对了」会让一个**不可见**的 bug 全绿通过。

推论：
- 视觉 / 结构约定必须有**样式真源断言**（读 CSS 或 `getComputedStyle`），不能只断言 class 或子节点数。
- 断言要锚在**不变量**上，而不是某个具体实现值。
  例：判据写成「折叠态**显示**占位行」而不是「`display` 恰为 `block`」——
  否则把 `block` 改成 `inline`（语义不变）会误报。
- 每条断言写完立刻变异；不红就说明它没在测任何东西。

## 7. 棘轮：体积只许降

**棘轮（ratchet）**，不是「设一个大概的上限」：基准 = 登记时的**真实测量值**，
**只允许向下收紧**；确实需要变大时**显式上调基准**并**写清增量构成**。

两个粒度都要有：

| 粒度 | 机制 | 注意 |
|---|---|---|
| 构建产物 | `apps/web/tools/bundle-size-baseline.json`（gzip level 9，分 js / css） | 必须走**会重建的入口**测量 |
| 源文件规模 | `apps/web/tools/module-size-baseline.json`（超限文件登记，上限 = 登记时行数） | 陈旧项 / 可收紧项会告警 |

- **量产物必须走会重建的入口**（全量 `pnpm check` 或 build）。
  某些子命令**不重建**，量的是旧 dist，会让基准记错。
- 附带「可收紧」提示：实测小于基准时告警（CI 可升为失败），基准才不会长期虚高。
- 上调基准时在文件里写明：哪个文件、多少字节、为什么（新增能力 / 依赖升级 / 工具链更换）。

## 8. 契约：一处声明，多处一致

- **契约文件是唯一真源**（`contracts/*.json`）。代码里的常量、文档里的数字、
  测试里的期望值都必须与它一致，且要有**机械检查**兜底，否则必然静默漂移。
- **模型可见的返回结构就是契约**。往结果里加**未声明**的字段 = 违约，
  哪怕「加了更有信息量」——诊断信息应该走日志 / 审计通道，不进模型上下文。
- **契约文本与实际行为必须一致**：不一致时要么改行为、要么改契约，不能两边都留着。

## 9. 前端（TS）改动的真机验证

UI 改动**必须真机验证**（headless shell + CDP），证据链要求：

1. **非零几何**：元素有真实宽/高/位置（不是 0、不是 `display:none`）。
2. **可见性**：`getComputedStyle` 取值确实生效（不是读 CSS 文本）。
3. **截图**：人眼可复核。
4. **交互态**：hover / 展开 / 运行中 / 窄屏各态都要量，不能只测静止态。

### 9.1 观测口径会掩盖被测现象

**验证工具本身可能把被测现象藏掉。** 真实教训：连续多轮「复现不出」一个布局抖动，
原因是真机 harness 一直带着「隐藏滚动条」的启动参数——而问题恰恰就是
**一条瞬时出现的滚动条**。改掉该参数后立刻复现。

推论：涉及布局 / 滚动 / 尺寸的验证，**默认让滚动条可见**；
报「复现不出」之前先自问：**我的观测口径覆盖了现象本身吗？**

### 9.2 区分真抖动与噪声

用 `PerformanceObserver` 的 `layout-shift` 定位**到底什么在动**：

```js
// 先等页面稳定，再用**非 buffered** 观察，否则会把加载期的一次性位移算进来
await new Promise((r) => setTimeout(r, 3000));
const shifts = [];
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) if (!e.hadRecentInput) shifts.push(e);
}).observe({ type: "layout-shift" });
```

- `e.sources[].node` 直接给出**位移的元素**，`previousRect` / `currentRect` 给出前后位置。
- **必须做对照组**：不操作、只等同样时长。对照组也位移 ⇒ 那是背景噪声（轮询 / 动画），
  不是你的改动引起的。
- 逐帧量几何（`requestAnimationFrame` 循环 + `getBoundingClientRect`），
  比截图更能定位「哪一帧开始不对」。

### 9.3 常见真因：`overflow` 的轴联动

只写 `overflow-y: auto` 时，按 CSS 规范另一轴是 `visible` 会被**计算成 `auto`**
⇒ 单行摘要行也会长出横向滚动条。亚像素取整（`scrollWidth` 超出 1~2px）就足以触发。
**单行 / 摘要类容器应显式 `overflow-x: hidden`。**

### 9.4 前端样式门禁

- `border-radius` 只走 `--r-*` token（`999px` 胶囊除外），不写死 px。
- 全站**禁 `dashed` / `dotted`**。
- 颜色只走 tokens 的 `--c-*` / `--bg-*` / `--label-*`。
- 改前端后要 build（`pnpm --dir apps/web run build`）再刷新；
  改**后端** TS 才需要重启服务。

## 10. 写 TS 的取向

- **机械门禁优先于人的记性**：任何「别忘了」都应该变成一条会失败的断言。
- **诚实降级 > 静默放行**：能力缺失时按策略降级并**说清**，或 fail-closed 报结构化错误，
  绝不假装成功。
- **平台是参数，不是常量**：路径 / 平台判定走可注入 seam，不要在业务里散落 `process.platform`。
- **「本机能跑」≠「干净机器能跑」**：本机常年有 `dist/`、缓存、`node_modules`，
  于是「依赖上一次构建」的坑只在别人的机器上现形。CI 就是那台干净机器。
- **注释写「为什么」**：尤其反直觉的决定与已知代价。
- **不改用户没要求的东西**：范围纪律要显式写进交付说明（「刻意没做什么」）。
- **时序敏感用例**：并发构建时必然 flaky；静默条件下重跑确认，**不要用「flaky」搪塞**。
  同一时间只允许**一个 builder**（构建 / 测试 / benchmark）。

## 11. 一句话总结

> 改一处 → 跑全量 → 变异验证 → 真机确认 → 按实测调棘轮。

**任何一条门禁挡了你，先假设门禁是对的。** 经验上「门禁误报」最后几乎都查出了一个真问题。
