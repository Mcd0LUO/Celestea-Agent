# 特性设计 · 沙箱时间语义（RLIMIT_CPU ↔ 墙钟超时）

> 状态：**设计**。本文是目标契约与验收标准的记录；落地后回填「实现状态」并改状态行。
> ⚠️ 状态行**只能出现一个类别词**：这里刻意不写「改为已实现」之类的话 —— `classifyStatus` 先命中就先归类，
> 解释文字里的「已实现」会把整篇判成已实现（`AGENT.md` §7 第 2 条的真实陷阱，W1517 交付时被 `tests/doc-conventions.test.ts` ② 抓到）。
> 依赖：[ARCHITECTURE.md](./ARCHITECTURE.md) 的分层与 seam 纪律、[data-files.md](./data-files.md) 的契约计数口径。

## 1. 一句话目标

**沙箱的 CPU 上限不再是一个与调用无关的固定值（20s），而是跟随这次调用的墙钟超时**；
模型仍可用参数显式覆盖，且任何覆盖都夹在部署方的上限之内。

## 2. 现状（实读，带 file:line）

| 事实 | 位置 |
|---|---|
| 默认 `RLIMIT_CPU` = **20 秒**，是 `DEFAULT_LIMITS` 的固定成员 | `packages/tools/src/sandbox/limits.ts:44-50` |
| 每次调用可传 `cpu_sec`，缺省保留 base，超上限被**夹紧**（不是报错） | `limits.ts:150-162`（`resolveCpuSec`）、`limits.ts:164-167`（`limitsForCpu`） |
| 墙钟超时是**另一个**维度：默认 30s、上限 `CELESTEA_SHELL_MAX_TIMEOUT_MS`（默认 300000ms） | `packages/tools/src/sandbox/config.ts:32-33`、`launch.ts:43-51` |
| CPU 上限的 env 上限：`CELESTEA_SHELL_MAX_CPU_SEC`（默认 600） | `config.ts:24,35` |
| `run_shell` 把 `cpu_sec` 原样交给 provider（前台 `run`、后台 `spawn` 同一套） | `packages/tools/src/tools/run-shell.ts:76-89` |
| **`run_code` 的子进程不带任何 cpu 覆盖**：`sandbox.spawn({command})` 无 `cpuSec` | `packages/tools/src/run-code/broker.ts:226-243` |
| `run_code` 的墙钟默认 **120s**，硬顶也是 **120s** | `packages/tools/src/run-code/limits.ts:36-39` |
| 墙钟到点杀子进程，报 `killed pid N after <timeout>ms (wall clock; …)` | `run-code/broker.ts:260-270,497-500` |

**症状（真实事故，来自一次 worker 的实测报告）**：`run_shell` 跑 `find /` 被 kill，
错误写的是 `killed after 30000ms`，**真因是 20s 的 `RLIMIT_CPU`**。两条时间线互相独立、
报错只报其中一条，于是「我调大了 timeout 为什么还是被杀」成了一个没有答案的问题。
`run_code` 更糟：它的墙钟默认 120s，而它启动的子进程吃的是 20s 的 CPU 上限 —— 一次正常的
长程序会在远早于 120s 时被 CPU 限制杀掉，且 `run_code` 的返回里**没有** `cpu_exceeded` 标记。

## 3. 目标契约

### 3.1 一条规则

> **该次调用的 `RLIMIT_CPU` 由该次调用的墙钟决定**：
> `cpuSec = clamp(ceil(wallClockMs / 1000) + CPU_GRACE_SEC, 1, maxCpuSec)`

- `wallClockMs`：本次调用**生效的**墙钟（显式 `timeout_ms`，否则该工具的默认值）；
- `CPU_GRACE_SEC`：给进程收尾/退出留的余量（P0 取 **5**），保证「墙钟先到」是常态：
  被墙钟杀时错误是 `code=timeout`，而不是含糊的 CPU 死亡；
- `maxCpuSec`：部署方上限（`CELESTEA_SHELL_MAX_CPU_SEC`，默认 600），**不可被模型越过**；
- 显式 `cpu_sec` 仍然有效：它**优先于**推导值，且同样被 `maxCpuSec` 夹紧。

### 3.2 不变的三条

1. **夹紧语义不变**：超上限是 clamp（`clamped: true`，写进 `SandboxMeta`），不是错误 —— 现有测试断言的就是这个。
2. **后台进程缺省放宽到上限**（用户裁决 2026-09-25）：`background: true` 没有调用级墙钟，因此其 `cpuSec` = 显式值，缺省 **`maxCpuSec`**（`CELESTEA_SHELL_MAX_CPU_SEC`，默认 600）。
   理由：后台进程本就是长期驻留的，用写死的 20s 去卡它没有语义依据；硬边界交给部署方的 `maxCpuSec`，模型仍可显式收紧或放宽（在夹紧范围内）。
   `DEFAULT_LIMITS.cpuSec = 20` 保留为「无法推导时的兜底」，但**前台与后台都不再直接吃这个值**。
3. **上限的权威不变**：模型只能在上限内自定义；上限只能由部署方用 env 改。

### 3.3 `run_code` 的补齐

| 项 | 现状 | 目标 |
|---|---|---|
| 子进程 `RLIMIT_CPU` | 隐式吃 20s | 跟随 `run_code` 本次的墙钟（同 §3.1 规则） |
| 模型可设超时 | `timeout_ms`，硬顶 120s | 保留参数；硬顶抬到部署方可配（P0：`CELAESTEA_RUN_CODE_MAX_TIMEOUT_MS`，默认 600000ms），**默认值仍 120s** |
| CPU 被杀的可观测性 | 无标记 | 与 `run_shell` 对齐：`cpu_exceeded: true` + 指名上限的消息 |

## 4. 分期

- **P0（本轮）**：§3.1 的推导 + §3.3 的三行；`run_shell` / `run_code` 两个入口生效；契约描述文本同步。
- **P1（不做）**：把「本次生效的 cpu/墙钟」画到状态栏；`/api/exec` 暴露同样的推导。
- **P2（不做）**：按会话/按工具的资源画像（预算联动，见 `docs/iteration-e/03-cost-ledger.md`）。

## 5. 契约与文档影响

| 文件 | 变更 |
|---|---|
| `contracts/tools.json` | `run_shell` / `run_code` 的 `description` 与 `timeout_ms` / `cpu_sec` 的参数描述必须与源码 DESC **逐字一致**（`packages/tools/src/run-code/sdk.test.ts` 与契约测试对拍） |
| `packages/tools/src/sandbox/README.md` | §「环境变量」表补 `CELESTEA_RUN_CODE_MAX_TIMEOUT_MS`；§rlimit 说明补「CPU 跟随墙钟」 |
| `contracts/endpoints.json` | **不变**（端点数不增） |
| `docs/data-files.md` | **不变**（不涉及数据文件） |

## 6. 验收标准（机械可检验）

| # | 标准 | 怎么验 |
|---|---|---|
| A1 | 不给 `cpu_sec` 时，`RLIMIT_CPU` 等于按 §3.1 推导的值 | 纯单测：注入假 `prlimit`，断言 argv 里的 `--cpu=` |
| A2 | 给了 `cpu_sec` 时，显式值胜出且仍被 `maxCpuSec` 夹紧 | 纯单测（现有 `w6-cpu.test.ts` 的用例扩展） |
| A3 | 墙钟先到：`timeout_ms` 到点仍是 `code=timeout`，不因 CPU 上限变大而改变 | 真机用例（bwrap 可用时）：`sleep` 超时仍是 timeout |
| A4 | `run_code` 的子进程带上推导出的 CPU 上限 | 单测：假 sandbox 记录 `spawn` 收到的 `cpuSec` |
| A5 | `run_code` 的硬顶可配、默认不变 | 单测：env 缺失 → 120000；`=600000` → 600000；非法值 → 回落默认 |
| A6 | 契约文本与源码 DESC 逐字一致 | 现有对拍测试（改文本必须两边同改） |
| A8 | `background: true` 且不给 `cpu_sec` 时，spawn 收到的 `cpuSec === config.maxCpuSec` | 单测：假 sandbox 记录 `spawn` 参数；变异：改回 20 → A8 红 |
| A7 | 变异负控制 | 把推导改回常量 20 → A1 必须红；把显式覆盖去掉 → A2 必须红；把后台缺省改回 20 → A8 必须红 |

## 7. 风险与未验证假设

| ID | 项 | 处置 |
|---|---|---|
| R1 | 抬大 `RLIMIT_CPU` 会让失控进程烧更多 CPU | 墙钟仍是硬边界，且 `maxCpuSec` 由部署方定；默认姿态（30s/120s 墙钟 → 35s/125s CPU）与现状差别有限 |
| R2 | `RLIMIT_CPU` 只对**单进程**计 CPU，多进程树不累加 | 这是既有事实，本轮不改变；不把它说成「总预算」 |
| R3 | Windows 上无 `prlimit`，CPU 上限本就不生效（见 `deployment.md` §4.1） | 推导逻辑仍算，但真机行为不变；文档已写明 |
| U1 | `run_code` 放宽硬顶后，网关侧是否会先超时 | 未实测；默认值不动，只有显式传参才走大值 |

## 8. 刻意没做什么

- 不改 `DEFAULT_LIMITS` 的其余五项（内存 / nproc / fsize / nofile / core）。
- 不给 `run_code` 增加 `cpu_sec` 参数（模型侧只暴露一个时间旋钮，避免两个旋钮互相打架）。
- ~~不动后台进程的默认 CPU 上限~~ **已作废**：用户 2026-09-25 裁决一并放宽到 `maxCpuSec`（见 §3.2 第 2 条与 A8）。
- 不动 `/api/exec` 的参数面（P1）。
