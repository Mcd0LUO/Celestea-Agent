# Celestea 后端 TypeScript 全量重构评估（W268 · 增量复评 + 可执行迁移计划）

> 📦 历史文档（2026-09-11 归档）：描述的是 Rust → TypeScript 全量重构的评估与迁移计划（W268），迁移已完成（TS 后端为生产），本报告作为立项依据留痕。当前权威入口见 [../DEVELOPMENT.md](../DEVELOPMENT.md) 与 [/src/celestea_studio-ts/docs/README.md](/src/celestea_studio-ts/docs/README.md)。

> **前序与契约**：[W229《Celestea-Studio 后端语言切换评估报告》](./backend-language-eval.md)（2026-09-07，commit `e4b73ce`，结论：维持 Rust axum，加权 4.81 : TS 3.63）｜[`celestea_studio/docs/DEVELOPMENT.md`](../DEVELOPMENT.md)（W264，代码基线 `937fe63`，39 端点契约 + 数据文件）｜[`celestea_harness/docs/DEVELOPMENT.md`](/src/celestea_studio/docs/archive/harness/DEVELOPMENT.md)（W265，7 crate / 10 工具 / 沙箱 / 事件模型）。
>
> **本轮口径**：① 用户已决定「引擎 + Studio 后端全量重构为 TypeScript」→ **场景 B 为主结论**，场景 A（core 留 Rust）降为对照；② 用户明确「性能不是关键」→ 性能维度权重压到 4%；③ 评估重心 = 维护成本与语义耦合、双进程/运行时运维、回归风险、语言统一/心智负担、打包发布形态。④ 本报告只写文档，**不改任何代码/配置、不 push、不重启服务**；文中不含任何 key/token 明文。
>
> **评估人**：W268（DSH worker）｜**实测日期**：2026-09-10（CST）｜**宿主**：celestea@部署机（Linux x86_64, 28 vCPU, uid 1003）

---

## 0. 结论先行

### 0.1 推荐路线

**按用户决策：走场景 B —— 引擎（7 crate）+ Studio 后端（6 文件）全量重构为 TypeScript，分 7 阶段 strangler 迁移；Studio 前端（已是 TS）不动。**

| 项 | 结论 |
|---|---|
| **总人日区间** | **100–150 人日**（中位 ≈125；含 15% 缓冲）。单维护者按 20 人日/月 ≈ **5–7.5 个月全职**；若同时承担产品/运维工作 ≈ **9–14 个月** |
| **关键路径** | P0 契约冻结 → P1 语义内核 → P2 LLM+工具+沙箱 → P3 runtime+workers → P4 Studio HTTP → P5 双跑对比 → P6 切换退役（单维护者下基本串行；P4 可在 P0 后并行启动，用 fake engine 适配器） |
| **最大三个风险** | ① **沙箱原语对等**（bwrap/unshare/rlimit/seccomp/进程组 kill，Node 无原生 setrlimit/unshare）；② **会话日志与回放语义**（turn id 单调、撕裂尾、`parent_id` 子调用、thinking delta、取消轮次 tool_call 配对）；③ **并发取消 + 代际热切**（单并发 busy 槽、watch 取消、`swap_gen` 回执迁移、autowake 重绑、SSE lagged） |
| **止损条件** | 见 §13.3：任一条件成立即**放弃全量重构、回退 Rust**（沙箱阶段 >12pd 无对等；回放语义分歧 >5% 且 5pd 内不收敛；6 个月未到 P4；单二进制发布成为硬需求且 Bun compile 不可接受；单维护者 TS 进程/沙箱能力不足） |
| **最强支持论据** | 迭代循环：最近 80 个提交中 **79.5% 的代码改动落在 Rust**（引擎 63.0% + Studio 后端 16.5%），全量 TS 后这部分循环从 **3.3–26.9s → ~2s（tsc）+ 0.04s（启动）**（§6） |
| **诚实声明** | 按本轮重设权重，**风险调整后矩阵仍偏向「维持 Rust」（4.12 vs 场景 B 3.38–3.50）**；只有当「语言统一/心智负担」被当作主导痛点（权重 ≥30%）时场景 B 才反超（3.88 vs 3.71，§9.2）。用户已按此口径决策，本报告的任务是把 B 做成**可执行、可验证、可止损**的计划，而不是论证 B 更优。 |

### 0.2 一句话结论

> 全量 TS 是一次**有意承担 100–150 人日与三类高风险**的主动重构：它的真实收益是「单一语言 + 迭代循环提速」，代价是「把安全关键代码（沙箱、路径白名单、SSRF）从编译期保证换成运行时约定 + 重写 433 个测试的等价面」；因此**必须先做 P0 契约冻结与 golden 回放对拍，再动沙箱**，并把 §13.3 的五条止损线写进日程。

---

## 1. 本轮实测基线（命令 + 数字，全部由 W268 亲自测量）

> 工具链不在默认 PATH：`export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH`（`docs/DEVELOPMENT.md` §1.1）。

### 1.1 代码规模

**引擎 `/src/celestea_harness`（7 crate / 57 个 `.rs` / 21,061 行）**

```bash
cd /src/celestea_harness
for d in crates/*/; do n=$(find "$d" -name '*.rs'|wc -l); \
  l=$(find "$d" -name '*.rs' -print0|xargs -0 cat|wc -l); echo "$(basename $d) files=$n lines=$l"; done
find . -name '*.rs'|wc -l; find . -name '*.rs' -print0|xargs -0 cat|wc -l
```

| crate | 文件 | 行数 | 备注 |
|---|---|---|---|
| `tools` | 9 | **7,209** | 最大 crate：sandbox 2,527 + run_code 1,636 + process 661 + http 557 + guard 482 + builtin 249 + lib 878 |
| `workers` | 6 | 3,300 | lib 1,218 + watchdog 698 + registry 631 + tools 348 |
| `runtime` | 7 | 2,754 | config 1,155 + compose 601 + run 486 + summary 245 |
| `agent-loop` | 4 | 2,235 | lib 1,365 + loop 550 + context 279 |
| `session` | 5 | 2,186 | persistent 856 + registry 580 + log 558 + mailbox 157 |
| `llm` | 5 | 2,177 | client 1,609 + config/registry |
| `core` | 10 | 1,157 | seam 定义层（契约冻结） |
| **合计** | **57** | **21,061** | 其中生产代码约 **9,958 行**（按每个文件首个 `#[cfg(test)]` 之前计数，近似值） |

**Studio 后端 `/src/celestea_studio/src/*.rs`（6 文件 / 8,923 行）**

```bash
cd /src/celestea_studio && find src -name '*.rs'|xargs wc -l|sort -n
```

| 文件 | 行数 | 性质 | 生产代码≈ |
|---|---|---|---|
| `workspaces.rs` | 2,416 | 工作区/会话目录语义（激活/重命名/分支/归档/回收站/路径安全） | 151 |
| `main.rs` | 2,105 | 装配、路由、`AppState`/`Gen`/`swap_gen`、SSE 总线、`execute_turn`、autowake、静态服务、statusline | 128 |
| `prompts.rs` | 1,608 | 提示词段注册表（4 级覆盖 + 插值 + 8192 字节截断） | 878 |
| `providers.rs` | 1,318 | `providers.json`（0600 明文 key）、`public_view` 消毒、`/models` 探测、keyless 借用引擎 key、默认模型热应用 | 172 |
| `compact.rs` | 879 | `/compact`：摘要轮 + 最近 K=4 轮重编号 + 原子写 + `.precompact` + 引擎重绑 | 522 |
| `api.rs` | 597 | 引擎面端点（tools/config/status/worker 三端点）+ JSONL 解析/回放投影 | 507 |
| **合计** | **8,923** | — | **≈2,358** |

> **关键结构事实**：Studio 后端里**业务语义 6,221 行（69.7%）**（workspaces 2,416 + prompts 1,608 + providers 1,318 + compact 879），**纯传输/装配仅 2,702 行（30.3%）**（main.rs 2,105 + api.rs 597）。这直接否决了 W229「要换走的 HTTP 层只有 ~1,604 行」的判断（见 §2）。

**前端 `frontend/src`（35 文件 / 8,683 行）**

```bash
cd /src/celestea_studio && find frontend/src -name '*.ts'|xargs wc -l|tail -1; \
  find frontend/src -name '*.css'|xargs wc -l|tail -1; find frontend/src -type f|wc -l
```
→ TS 6,984 行 + CSS 1,699 行 = **8,683 行 / 35 文件**（W229 时 3,589 行 / 16 模块 → **2.4×**）。

### 1.2 测试规模与运行时长

```bash
# 引擎
cd /src/celestea_harness && time cargo test --workspace
# Studio
cd /src/celestea_studio && time cargo test          # 及 cargo test --release
```

| 套件 | 结果 | 耗时（wall） | 说明 |
|---|---|---|---|
| 引擎 `cargo test --workspace` | **364 passed / 0 failed / 2 ignored** | **7.7s** | 需 `CELAESTEA_RUN_SHELL_V2_NPROC=0`（见下） |
| 引擎（默认 env） | **363 passed / 1 failed / 2 ignored** | 4.0s | 唯一失败 = `run_code_e2e`：`/bin/sh: 1: Cannot fork` |
| Studio `cargo test`（debug） | **69 passed / 0 failed** | **18.3s**（测试本体 3.2s） | 编译占大头 |
| Studio `cargo test --release` | **69 passed / 0 failed** | **15.4s**（测试本体 1.43s） | — |

**失败项归因（已复核）**：`crates/tools/tests/run_code_e2e.rs` 的 `run_code_reads_first_line_through_the_real_registry` 在默认 env 下失败，根因是**沙箱 `RLIMIT_NPROC=512` 与本容器 uid 进程数冲突**（`ulimit -u` = 123885，`/proc` 中进程 460+），不是代码缺陷：

```bash
cd /src/celestea_harness
cargo test --workspace                                   # → 363/1/2, "Cannot fork"
CELAESTEA_RUN_SHELL_V2_NPROC=0 cargo test --workspace    # → 364/0/2
cargo test -p celestea-tools --test run_code_e2e         # 单独复现
```
> 附带发现：`docs/DEVELOPMENT.md` §8.3 要求环境受限用例「优雅跳过、不要 fail」，但该 e2e 目前是 fail 而非 skip。迁移时应把这类用例改成**能力探测 + skip**（TS 侧同理）。

**按 target 分布（`grep -E '^test result:' /tmp/engine-test2.log`）**：agent-loop 36、core 26、llm 38(+4+2 集成)、runtime 77(+2 集成)、session 52、tools 85(+1 e2e)、workers 43。

### 1.3 端点 / SSE / 工具面

```bash
cd /src/celestea_studio
grep -c '\.route(' src/main.rs          # 38
grep -cE '^### ' docs/archive/api-contract.md   # 39
```

| 项 | 数字 | 来源 |
|---|---|---|
| 路由声明 | **38 条 `route()`** | `src/main.rs:1337-1378` |
| method+path 组合 | **43**（5 组 GET+POST：config/sessions/workspaces/providers/prompts）+ 1 fallback | `src/main.rs:1379` |
| 契约化端点 | **39**（api-contract.md 逐条） | `docs/archive/api-contract.md` |
| SSE 事件（后端实际发出） | **8 种**：`status` `text` `thinking` `tool` `tool_result` `turn_end` `done` `compact` | `src/main.rs:669-710`、`src/compact.rs:484` |
| SSE 事件（前端监听） | **8 种**：`status` `text` `thinking` `tool` `tool_result` `done` `context` `compact` | `frontend/src/sse.ts:51-60` |
| 工具面 | **10 个** | harness `docs/DEVELOPMENT.md` §2.1 |
| 引擎配置键 | 12 个 | harness `docs/DEVELOPMENT.md` §7.2 |

> 两处**契约错位**必须在迁移时一次修掉：前端监听的 `context` 后端**从不发送**；后端发送的 `turn_end` 前端**不监听**（`docs/DEVELOPMENT.md` §8.4 第 3-4 条）。迁移是修掉它们的最佳时机，但必须写进契约测试，否则会变成「迁移顺手改了行为」。

### 1.4 发布形态与部署

```bash
ls -la /src/celestea_studio/target/release/celestea-studio     # 12,428,784 B
cat /etc/systemd/system/celestea-studio.service
cat /src/celestea_studio/scripts/run-studio.sh
cat /etc/nginx/sites-available/studio.celestea.top.ssl
```

| 项 | 现状 |
|---|---|
| 产物 | **单二进制 12,428,784 B（11.85 MiB）**（W229：10,563,480 B / 10.1 MiB → +17.7%） |
| 进程模型 | **单进程**；`STUDIO_BIND` 默认 `127.0.0.1:3777` |
| systemd | `celestea-studio.service`：`Type=simple`、`User=celestea`、`WorkingDirectory=/src/celestea_studio`、`Environment=CELESTEA_TOOL_ROOTS=/src/celestea_studio:/src/celestea_harness:/tmp`、`CELESTEA_SANDBOX_NET=0`、`ExecStart=scripts/run-studio.sh`、`Restart=always`/`RestartSec=3`、日志 append 到 `/tmp/celestea-studio.log` |
| 启动脚本 | `run-studio.sh`：`sudo python3` 从 `/opt/dsh/.credentials.yaml` 取 `CELESTEA_API_KEY` → 导出 → `exec ./target/release/celestea-studio`（**key 只进 env，不落盘**） |
| 反代 | nginx `studio.celestea.top` 443 + **Basic Auth**（`.htpasswd-studio`）→ `127.0.0.1:3777`；`proxy_buffering off` / `proxy_cache off` / `read_timeout=send_timeout=3600s` / `chunked_transfer_encoding on` |
| 运行态实测 | RSS **25.7 MiB** 空闲；`systemctl show` → `MemoryCurrent=23,953,408`、`NRestarts=0`、`active` |
| 依赖体积 | `Cargo.lock` 包数：Studio 230 / 引擎 224 |

### 1.5 迭代循环实测（复核架构师数字）

```bash
# 全量干净构建（空 target，含引擎全部 path 依赖）
CARGO_TARGET_DIR=/tmp/w268-target cargo build --release          # 1m13s wall / 7m41s CPU
# Studio 增量
touch src/main.rs && CARGO_TARGET_DIR=/tmp/w268-target cargo build --release
# 引擎增量（引擎仓自身 target）
cd /src/celestea_harness && touch crates/session/src/log.rs && cargo build --workspace --release
touch crates/core/src/lib.rs && cargo build --workspace --release
# 引擎改动经 Studio 重建（真实发布路径）
touch /src/celestea_harness/crates/tools/src/sandbox.rs && cargo build --release  # 在 Studio 侧
# 前端（临时副本，不碰生产 dist）
cp -r frontend/{package.json,tsconfig.json,vite.config.ts,index.html,src} /tmp/w268-fe/
cd /tmp/w268-fe && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build
```

| 改动位置 | 实测循环 | 备注 |
|---|---|---|
| 干净全量 release 构建 | **1m13s**（wall）/ 7m41s CPU | 空 target，含引擎 7 crate + 230 包 |
| Studio `src/main.rs` touch → 重建 | **16.9 / 16.9 / 26.5s**（三次）；生产 target 一次 **26.9s** | 只重编 studio crate + 链接 12MB 二进制 |
| Studio `src/api.rs`（纯 HTTP 层）touch → 重建 | **14.8s** | 同样只编 studio crate |
| 引擎 `session/log.rs` touch（引擎仓） | **3.3 / 3.4 / 5.9s**；`core/lib.rs` touch → 全 crate **6.3s** | 引擎自身 workspace |
| **引擎改动经 Studio 重建**（`sandbox.rs`） | **17.8s**（tools→workers→runtime→studio） | 这才是「改引擎语义、发布 Studio」的真实循环 |
| 引擎 `core/lib.rs` 经 Studio 重建 | **19.2s**（8 crate 重编） | 最坏情形 |
| 前端 `tsc --noEmit` | **2.0s** | strict + noUncheckedIndexedAccess |
| 前端 `vite build` | **1.7s**（bundle JS 208.63 kB / CSS 44.35 kB） | `pnpm build` ≈ 3.7s |
| `pnpm install`（冷，临时目录） | 17.1s | 105MB→51MB node_modules |
| 二进制启动到 `/api/health` 200 | **38 / 45 / 62 ms** | 临时实例 :3799 |
| Node 进程启动 | **0.03–0.04s** | `node -e ''` |
| Node `--experimental-strip-types` 启动 | **0.08s** | Node 24 `process.features.typescript === 'strip'` |
| Bun 启动 | 0.00–0.12s | bun 1.4.0 |

> **与架构师数字的差异（诚实记录）**：架构师实测「Studio 28.9s / 引擎 20.7s / 前端 5.4s / 重启 0.03s」；W268 实测 Studio 16.9–26.9s（目标目录不同、链接抖动）、引擎**自身仓内 3.3–6.3s**、**经 Studio 17.8–19.2s**、前端 3.7s（tsc 2.0 + vite 1.7）、启动 0.04–0.06s。结论一致：**「引擎 20s+」指的是「引擎改动经 Studio 重建」这一条路径**，不是引擎仓内编译。两者都对，报告统一采用区间表述。

### 1.6 运行时与宿主能力实测

```bash
for t in node npm pnpm bun deno go dotnet python3 rustc cargo; do printf "%-8s " "$t"; \
  command -v $t >/dev/null 2>&1 && $t --version 2>&1|head -1 || echo "NOT INSTALLED"; done
timeout 25 npm view hono version          # 4.13.7（registry 可达）
node --test-reporter=spec --test /dev/null
for t in bwrap unshare prlimit setsid nsenter chroot; do command -v $t; done
cat /proc/sys/kernel/unprivileged_userns_clone      # 1
unshare -Urn -- /bin/echo ok                        # EPERM: write /proc/self/uid_map
bwrap --unshare-all --dev /dev --proc /proc --ro-bind / / --tmpfs /tmp \
      --bind /tmp /tmp -- /bin/sh -c 'exec 3</dev/zero 2>/dev/null && printf ok || printf no'
```

| 项 | 实测 |
|---|---|
| Node / npm / pnpm / Bun | **v24.19.0 / 11.17.0 / 11.22.0 / 1.4.0** |
| Deno / Go / dotnet | **均未安装** |
| rustc / cargo | 在 `/opt/cargo/bin`（**不在默认 PATH**） |
| npm registry | **可达**（`npm view hono version` → `4.13.7`）；`bun add hono` 2.73s |
| `node:test` | 可用（内置）；`node:http/http2/worker_threads/child_process` 均可用 |
| 沙箱原语 | `bwrap` ✓、`prlimit` ✓、`setsid/nsenter/chroot` ✓、**`unshare -Urn` ✗（uid_map EPERM）** |
| **bwrap 实际可用性** | `--unshare-all` 能起，但沙箱内 **`/dev/zero` 打不开**（`Permission denied`）→ 引擎 `bwrap_sandbox_usable()` 探测失败 → **生产实例当前运行 `userspace` 回退路径**（`/tmp/celestea-studio.log` 反复打印 `os sandbox unavailable … v1 userspace path`） |

> **这条对迁移计划极其重要**：本机**当前实际被执行的沙箱路径是 userspace 回退**（timeout + 输出上限 + env 清洗 + rlimit），bwrap/raw 命名空间路径是「有条件启用」。TS 迁移必须先做**能力探测 + 分层实现**，而不是假定 bwrap 一定在。

### 1.7 真实负载实测（只读，不触发任何写操作）

```bash
for p in /api/health /api/status /api/tools /api/sessions /api/workspaces /api/providers /api/prompts /api/worker/status; do
  curl -s -o /dev/null -w "$p code=%{http_code} time=%{time_total}s size=%{size_download}B\n" http://127.0.0.1:3777$p; done
ID='celestea_harness%2Fharness%E6%9E%B6%E6%9E%84%E5%93%A5-1788933931.279221103'
for i in 1 2 3; do curl -s -o /dev/null -w "messages run$i time=%{time_total}s size=%{size_download}B\n" \
  "http://127.0.0.1:3777/api/sessions/$ID/messages"; done
```

| 端点 | 延迟 | 响应体 |
|---|---|---|
| `/api/health` | 0.94 ms | 144 B |
| `/api/status` | 6.0 ms | 531 B |
| `/api/tools` | 0.85 ms | 5,341 B |
| `/api/sessions` | 15.5 ms | 1,147 B |
| `/api/workspaces` / `/api/providers` / `/api/prompts` | 0.77 / 0.76 / 0.79 ms | 294 / 847 / 4,181 B |
| `/api/worker/status` | 0.83 ms | 126 B |
| **`/api/sessions/{id}/messages`**（1.04 MB JSONL） | **13.2 / 14.0 / 16.8 ms** | **1,049,695 B** |
| `/api/fs/browse?path=/src` | 0.96 ms | 199 B |

**Node 侧对拍（scratch 脚本，不落仓库）**：真实会话 JSONL 解析

```bash
node /tmp/w268-bench/jsonl.mjs /src/celestea_harness/harness架构哥-1788933931.279221103/cli-main.jsonl
node /tmp/w268-bench/jsonl.mjs /server-center/center-架构师-1788940601.93642104/cli-main.jsonl
```
| 文件 | 事件数 | JSON.parse 全量 | 吞吐 | stringify+计字 |
|---|---|---|---|---|
| 0.91 MB | 606 | **6.0 ms** | 145.6 MB/s | 5.1 ms |
| 1.70 MB | 967 | **6.7 ms** | 243.8 MB/s | 7.6 ms |

**Node SSE 并发（scratch 原生 http 服务，:3798）**

| 连接数 | RSS | 每连接 | event-loop delay |
|---|---|---|---|
| 200 | 77.8 MiB（基线 58.5） | ~99 KiB | mean 10.1 / p99 11.0 / max 22.9 ms |
| 500 | 109.4 MiB（基线 58.4） | ~104 KiB | mean 10.3 / p99 16.9 / max 37.4 ms |

**Node 子进程（prlimit/bwrap 包装）**：`prlimit --nproc=64 --cpu=1 -- echo` ×50 → **5.1 ms/次（串行）/ 1.6 ms/次（并行）**；`bwrap … echo` 单次 **13 ms**。

**Bun 单文件编译（打包形态的关键证据）**

```bash
bun add hono && bun build --compile ./app.ts --outfile ./app   # 0.31s → 82,580,680 B (78.8 MiB)
```

> 结论：Bun `--compile` **确实能消除「必须装 node runtime」这条反对意见**（0.31s 出单文件、可执行、无外部依赖），代价是 **78.8 MiB vs Rust 11.85 MiB（6.6×）**、**只能在目标平台本机构建**（不能交叉编译）、原生模块不可用。详见 §5.2。

---

## 2. 自 W229（2026-09-07）以来的变化：哪些结论仍成立、哪些必须修正

> W229 基线：`backend-language-eval.md` @ commit `e4b73ce`（2026-09-07）。以下逐条对照。

| # | W229 结论 | 本轮是否成立 | 依据（W268 实测） |
|---|---|---|---|
| 1 | 引擎 8 crate / ~12,283 行 Rust | **需修正**：**7 crate / 21,061 行**（生产≈9,958） | §1.1；W214 删 CLI 后是 7 crate；行数 **+71%** |
| 2 | 「要换走的 HTTP 层只有 ~1,604 行」 | **不再成立**：Studio 后端 **8,923 行**（5.6×），其中**语义 6,221 行 / 69.7%** | §1.1；新增 workspaces/providers/prompts/compact 四模块 |
| 3 | 前端 3,589 行 / 16 模块 | **需修正**：**8,683 行 / 35 文件**（2.4×） | §1.1 |
| 4 | 12 组端点 | **需修正**：**39 契约 / 38 route / 43 method+path** | §1.3 |
| 5 | 二进制 10.1 MiB | **需修正**：**11.85 MiB** | §1.4 |
| 6 | 引擎测试 347 / Studio 65 | **需修正**：**364 / 69**（2 ignored；引擎默认 env 下 363/1/2） | §1.2 |
| 7 | 「换语言 = 必须先拆引擎 sidecar」（7 人日） | **部分仍成立**：sidecar 仍是**降低耦合的最便宜演进**（W229 §6 契约可直接用作 P5 双跑契约）；但用户已选全量重写 → **sidecar 从「前置」变成「可选的中间产物」** | §10 P0/P5；§12 替代路径 |
| 8 | 「维持 Rust axum 加权 4.81 : TS 3.63」 | **风险调整后仍成立**（本轮 4.12 : 3.38–3.50），但**权重口径已变**（性能 20%→4%，语言统一 12%→16%） | §9 |
| 9 | 「TS 单线程阻塞（大 JSONL 解析）是致命风险」 | **需显著下调**：Node 解析真实会话日志 **6–7 ms / MB 级文件、146–244 MB/s**；只有 100 MB+ 日志才需 worker_threads | §1.7；W229 D3=3 应上调到 4 |
| 10 | 「部署机 node 24.19 / bun 1.4 已装，go/dotnet/deno 未装」 | **仍成立**（本轮复核一致；npm registry 亦可达） | §1.6 |
| 11 | 「Bun/Deno 单文件不可交叉编译 → 发布矩阵退化」 | **仍成立**，但**影响被 Bun compile 部分抵消**（78.8 MiB 单文件，0.31s，仅本机构建） | §1.7、§5.2 |
| 12 | 「热重载语义留在 Rust → 换语言价值趋近于零」（薄代理闭环论证） | **在场景 A 下仍成立**；**场景 B 不适用**（语义整体搬到 TS，闭环失效） | §3.2 / §3.3 |
| 13 | 「单维护者 + 引擎必须 Rust = 不用学第三种语言」 | **反转**：用户决策把「语言统一」提为主导痛点 → 该论据从「反对换」变成「支持换」 | §9.2 |

### 2.1 2026-09-07 之后新增、且对「换语言」判断有实质影响的能力

以下均来自两仓 git log（Studio 58 commits / 引擎 26 commits since 2026-09-07）：

| 能力 | 规模/位置 | 对 TS 迁移的影响 |
|---|---|---|
| **`run_code` Python parent-broker + SDK** | `crates/tools/src/run_code.rs` **1,636 行**（W255 新增） | **必须重写 broker**（Python SDK 不动）；子进程协议 + 20 子调用/120s/256KiB 限额 + `parent_id` 事件映射 + `ChildKillGuard` |
| **`/compact` 上下文压缩** | `src/compact.rs` **879 行**（W259） | 语义最耦合引擎的模块：摘要轮 + 最近 K=4 轮重编号 + 原子写 + `.precompact` + **引擎重绑**；TS 重写必须逐字节保格式 |
| **`providers.json` 多提供商 + keyless 回退** | `src/providers.rs` **1,318 行** | 0600 原子写、`public_view` 只出 `has_key`、同源 keyless 借用引擎 key（请求级、不落盘）；安全契约必须在 TS 复刻 |
| **prompt 段注册表** | `src/prompts.rs` **1,608 行**（10 段 builtin + 4 级覆盖 + `{{var}}` + 8192 截断） | 纯逻辑，机械移植；但 `build_gen` 装配时序与 `swap_gen` 耦合 |
| **statusline 真实用量 / 缓存命中率** | `src/main.rs`（W263）+ 引擎 `UsageTracker` | 依赖引擎 `Usage` 五字段与三种 cache 键名探测（`prompt_cache_hit_tokens` / `cache_read_input_tokens` / `prompt_tokens_details.cached_tokens`） |
| **LLM 三档超时** | `crates/llm/src/client.rs`（W266） | connect / response-header / stream-idle 三段语义；TS 需 `AbortController` + idle 定时器复刻，**不能只用一个总超时** |
| **取消轮次 tool_call/tool_result 配对** | `crates/agent-loop/src/loop.rs` + `session/src/log.rs`（W267） | 取消时合成 `"cancelled before execution"` 结果，避免上游 400；**回放对拍必测项** |
| **沙箱 P0-3 安全套件** | `crates/tools/src/sandbox.rs` **2,527 行** | ToolGuard 路径白名单、bwrap 默认隔离网络 + 私有 tmpfs + seccomp 开关、v1 rlimit 对齐、超时杀进程组 |
| **后台进程 + 完成推送** | `crates/tools/src/process.rs` 661 行（W251） | 会话级 `ProcessRegistry`、512KiB 环形缓冲、自然退出推 mailbox → autowake |
| **文档体系** | Studio `DEVELOPMENT/api-contract/data-files/pitfalls/deployment`；引擎 `DEVELOPMENT/run-code-sdk` 等 | **这是本轮最大红利**：契约已逐条核对到符号名，P0 可直接把它们冻结成机器可读契约 |

---

## 3. 两种范围分开评（A 降为对照，B 为主结论）

### 3.1 场景 A0：维持 Rust axum（对照基准）

- **人日**：0（迁移）+ 可选 sidecar 7 pd（W229 §2.3）。
- **风险等级**：低（现状即方案）。
- **仍然成立的优点**：单二进制 11.85 MiB、单进程、三平台发布矩阵已存在、编译期保证覆盖沙箱/路径白名单/SSRF、与引擎同构零类型边界成本、433 个测试已绿。
- **仍然成立的缺点**：语言不统一（TS 前端 + Rust 后端 + Rust 引擎）；后端语义改动循环 15–27s；单维护者要同时保持 Rust 熟练度。

### 3.2 场景 A：core 留 Rust，仅 Studio 后端换 TS（两条子路径）

| 子路径 | 做什么 | 重写量 | 人日 | 风险 | 结论 |
|---|---|---|---|---|---|
| **A1 薄代理**（W229 切分点 B） | Studio 只做静态 + `/api/*` → Rust sidecar 转发；**语义整体下移 Rust** | TS ≈200–400 行；Rust sidecar 新增 ~7 pd | **14–20**（W229 §7 同口径） | **低** | **换语言收益趋零**：语义仍在 Rust，语言并未统一，且**多一个进程** |
| **A2 语义重写** | TS 重写 Studio 全部语义（workspaces/providers/prompts/compact/config），引擎仍 Rust | TS ≈6,200–8,900 行 | **35–50** | **高**：语义在两种语言各写一份，逐条对齐 | 只解决「Studio 后端语言」，**引擎仍是 Rust**，语言统一目标只完成一半 |

> **A 的共同死穴**：用户的核心痛点是「语言不统一/心智负担」。A1 完全没解决（Rust 仍占 63% 的 churn），A2 只解决 16.5% 的 churn。若目标真是「单一语言」，A 是**投入产出比最差**的选择。

### 3.3 场景 B：引擎 + Studio 后端全量 TS（主结论）

- **人日**：**100–150**（§10 分解）。
- **风险等级**：**高**（沙箱 / 回放 / 并发取消三类，见 §8）。
- **范围**：7 crate 21,061 行 + Studio 6 文件 8,923 行 ≈ **29,984 行 Rust → TS**（其中生产代码 ≈12,300 行，其余为测试）。
- **成立前提**（缺一不可）：① 语言统一/心智负担是**主导**痛点；② 接受 5–14 个月的迁移期；③ 接受沙箱必须用 `bwrap/prlimit/setsid` 等系统工具重新实现（或临时保留一个极小 Rust 沙箱 helper，但那会破坏「零 Rust」目标）；④ 接受发布形态从 11.85 MiB 单二进制变成 Node runtime + node_modules（或 78.8 MiB Bun 单文件）；⑤ 有 golden 回放对拍机制 + 五条止损线。

---

## 4. Rust → TS 模块映射表

> 图例：**机械** = 语义可直接翻译；**重设计** = 依赖 OS/运行时原语，必须换实现方式；**高风险** = 失败会损坏用户数据或安全边界。

### 4.1 引擎 7 crate

| Rust 模块（行数） | TS 模块 | 移植类型 | 关键难点 | 验收锚点 |
|---|---|---|---|---|
| `core` 1,157（10 文件） | `packages/core` | **机械** | `Context`（TypeId 键 + parent 链）→ `Map<symbol, unknown>` + parent；`EventBus` 三种派发（on/emit、bail/run_bail、waterfall）→ 纯函数工具；`SessionEvent` 判别联合 → TS discriminated union + zod 校验 | 类型定义与 Rust serde 形状逐字段一致；`SessionEvent` 8 个变体的 JSON 序列化/反序列化 round-trip |
| `llm` 2,177 | `packages/llm` | **机械 + 细节** | **裸 SSE 解析**（不能用 typed SDK，会丢 `reasoning_content`）；usage 三种 cache 键名探测；**三档超时**（connect/response-header/stream-idle）；`reasoning_effort` 自由字符串直通 | 录制真实上游 SSE 帧回放；`extract_usage` 五字段 + 三种键名；timeout 错误前缀 `llm timeout` |
| `session` 2,186 | `packages/session` | **高风险机械** | JSONL append + `flush_each_append`；**撕裂尾**：保留最长合法前缀并 `truncate`；**turn id 单调**：replay 后取 max+1；`derive_messages` 投影（含 `parent_id.is_some()` 跳过、thinking 跳过、取消合成结果）；mailbox FIFO | golden 对拍：3 个真实会话 + 合成 fixtures（撕裂尾/取消/子调用/thinking）投影结果与 Rust **逐字节一致** |
| `tools` 7,209 | `packages/tools` | **重设计为主** | `sandbox.rs`（2,527）**无法机械移植**；`process.rs`（661）后台进程/reaper/环形缓冲；`http.rs`（557）SSRF + 逐跳重定向复检；`run_code.rs`（1,636）broker 协议；`guard.rs`（482）路径白名单 | 见 §4.3 沙箱验收矩阵；run_code 用**现有 Python SDK** 端到端跑通 |
| `agent-loop` 2,235 | `packages/agent-loop` | **机械 + 并发** | turn/step 驱动；上下文裁剪；`UsageTracker`；`LoopEvent`；**协作式取消**（Rust `watch` → TS `AbortSignal` + 检查点）；并行工具调用上限 | 取消语义：中途取消 → 每个未执行 tool_call 合成 `cancelled before execution`；终态五值；事件顺序与 Rust 一致 |
| `workers` 3,300 | `packages/workers` | **机械 + 高风险** | `registry.tsv` **原子替换**（tmp+rename）+ 字节格式；mailbox 驱动循环；watchdog（30s 巡检、10min 宽限、重派上限 2）；3 个 worker 工具；回执格式 `WORKER_<wid>_DONE/FAILED` | registry.tsv 与 Rust 互读互写；worker 闭环（spawn→brief→回执→宿主 autowake）用 FakeLlm 复现 |
| `runtime` 2,754 | `packages/runtime` | **机械** | `compose` 15 步顺序；profile 解析（TOML/JSON、lenient/strict、12 键、key 三路解析）；`run_turn` 流式 + 取消；`shutdown` 幂等；`summarize_turn` | compose 后工具面 = 10；避免强引用环（Rust 用 `Weak`）；shutdown 顺序：abort 驱动→杀进程→purge mailbox→清 registry |

### 4.2 Studio 后端 6 文件

| Rust 文件（行数） | TS 模块 | 移植类型 | 关键难点 |
|---|---|---|---|
| `main.rs` 2,105 | `apps/studio/src/server.ts` + `bus.ts` + `static.ts` + `statusline.ts` | **机械 + 并发** | Hono 路由 38 条；SSE 总线 **512 容量 + lagged→`status{phase:"lagged"}`** + 2s progress tick + KeepAlive；`Gen` 代际 + `swap_gen`；autowake；静态 + SPA fallback |
| `api.rs` 597 | `apps/studio/src/routes/engine.ts` | 机械 | tools/config/status/worker 三端点；JSONL 解析 + `session_event_to_message` 全 kind 映射 |
| `workspaces.rs` 2,416 | `apps/studio/src/workspaces/` | **高风险机械** | 路径穿越防护、legacy 迁移、激活重放、重命名碰撞、分支复制、归档/回收站、`%2F` 编码 id；**active 会话保护（400）** |
| `providers.rs` 1,318 | `apps/studio/src/providers/` | **机械 + 安全** | **0600 原子写**（tmp+rename 每次重断言 mode）；`public_view` 绝不回显 key；`/models` 探测；keyless 同源借用引擎 key（请求级、不落盘） |
| `prompts.rs` 1,608 | `apps/studio/src/prompts/` | 机械 | 10 段 builtin 顺序、4 级覆盖优先级、`{{var}}` 插值（未知变量报错）、8192 字节截断、两阶段热应用（busy 409 不落盘） |
| `compact.rs` 879 | `apps/studio/src/compact/` | **高风险** | 完整轮切分、摘要轮 + 最近 K=4 轮**重编号**、`rewrite_atomic` + `.precompact` 单副本、**先写日志后重绑引擎**（失败不回滚 → 只能靠 `.precompact`） |

### 4.3 沙箱：必须重新设计的部分（本报告最大风险）

Rust 侧依赖的 OS 原语与 Node 的可得性：

| Rust 原语 | 用途 | Node 原生 | 可行替代（已实测） | 风险 |
|---|---|---|---|---|
| `pre_exec` + `setrlimit`（CPU/AS/NPROC/FSIZE/NOFILE/CORE） | v1 与 v2 都套用 | ❌ 无 API | **`prlimit --nproc=… --cpu=… --as=… --fsize=… --nofile=… -- cmd`**（5.1 ms/次串行） | 中：需保证所有 spawn 路径都被包装 |
| `process_group(0)` + 组 SIGKILL | 超时杀整组、防孤儿 | 部分（`detached`） | `spawn(..., {detached:true})` + `process.kill(-pid, 'SIGKILL')` | 中：POSIX 语义需逐条测 |
| `bwrap`（mount/user/pid/ipc/uts + 只读根 + 私有 tmpfs + 独立 netns） | v2 隔离 | ❌ | **直接 spawn `/usr/bin/bwrap`**（13 ms/次） | **高**：探测与降级逻辑复杂；本机因 `/dev/zero` 不可读而**未启用** |
| `unshare(CLONE_NEWUSER…)` + `chroot` | raw 回退 | ❌ | `/usr/bin/unshare`（本机 EPERM）/ `chroot` | 高：本机不可用 |
| seccomp 最小白名单 | 可选加固 | ❌ | `bwrap --seccomp <blob>`（blob 需生成；Rust 侧仅 Linux x86_64 实现） | 高：默认关闭，迁移可先对齐「默认关闭」 |
| 环境变量白名单 | 所有路径 | ✅ | `spawn(env: {...})` | 低 |
| 输出上限 64KiB/流 + 继续 drain | 防管道阻塞 | ✅ | stream 计数 + 丢弃 | 低 |
| 结构化错误码（`timeout/workdir/arg/config/spawn`） | 契约 | ✅ | 统一 error 类 + `code=` 前缀 | 低 |
| ToolGuard 路径白名单（canonicalize + 最近已存在祖先） | 读写根裁决 | ✅（`fs.realpath`） | 纯逻辑 | 低（但有 TOCTOU 残余风险，Rust 侧已文档化） |

**结论**：Node **不能**原生做 rlimit/unshare/seccomp；可行路线是「**能力探测 + 系统工具包装**」：优先 `bwrap`，否则 `prlimit` + `setsid`/进程组 + env 清洗 + 超时杀组的 userspace 路径——这恰好**与本机当前实际运行的路径一致**，因此「先对齐 userspace 回退路径，再补 bwrap 路径」是最稳的迁移顺序。

---

## 5. 运行时选型对比（落到可执行建议）

### 5.1 Node 24 LTS + Hono（推荐基线）

| 维度 | 实测/评估 |
|---|---|
| 版本 | v24.19.0（LTS）；`process.features.typescript === 'strip'` → 可直接跑 `.ts`（开发期免构建） |
| SSE | Hono `streamSSE`；实测 500 并发连接 109.4 MiB RSS（~104 KiB/连接）、event-loop p99 16.9 ms |
| 子进程 | `child_process.spawn` + `prlimit`/`bwrap` 包装，实测 1.6–5.1 ms/次、bwrap 13 ms/次 |
| 类型共享 | 与 `frontend/src/types.ts` 同包引用；zod 做运行时校验（替代 Rust serde 的严格性） |
| 测试 | `node:test` 内置；`vitest` 可选（需 npm 安装，registry 可达） |
| 打包 | 需 node runtime + node_modules（`hono` 依赖仅 2.8 MB，但 node_modules 通常 50–105 MB）；或 `--experimental-sea`（实验性） |
| 结论 | **基线**：生态最稳、SSE/子进程实测达标、与前端同族 |

### 5.2 Bun + Hono（打包备选）

| 维度 | 实测/评估 |
|---|---|
| `bun build --compile` | **0.31s → 82,580,680 B（78.8 MiB）单文件**，可直接执行，无 node runtime 依赖 |
| 优势 | **正面回应 W229 的「Node 需要装 runtime」反对意见**；部署形态回到「单文件」 |
| 限制 | ① **只能目标平台本机构建**（无交叉编译）→ Windows/macOS 需各自构建；② 原生模块不可用（本项目可接受）；③ 体积 6.6× Rust 二进制；④ Bun 生态/兼容性风险高于 Node |
| 结论 | **若「单二进制发布」是硬需求 → Bun compile 作为发布通道**；运行时语义（尤其是 SSE/子进程）仍建议以 Node 为准并双跑验证 |

### 5.3 Deno

未安装；`deno compile` 同样本机构建；OpenAI 兼容客户端与 `eventsource` 生态弱于 Node。**不推荐作为主选**。

### 5.4 CPU 密集段：worker_threads 的真实代价（性能已降权，但需诚实量化）

| 操作 | 主线程实测 | 是否需要 worker |
|---|---|---|
| 解析 0.91 MB 会话 JSONL（606 事件） | **6.0 ms** | 否 |
| 解析 1.70 MB（967 事件） | **6.7 ms** | 否 |
| 全量 stringify + 计字（token 估算） | 5.1 / 7.6 ms | 否 |
| 100 MB 级日志（外推，本机无此规模样本） | ~0.4–0.7 s | **是**（会阻塞所有 SSE 连接） |
| `/compact` 日志重写 | 与日志体量线性；当前最大 1.7 MB → 数十 ms | 否（除非引入 100 MB 级会话） |

> **修正 W229**：把「JSONL 解析必须 worker 化」从**前置风险**降级为**规模化后的优化项**（阈值建议：单文件 >20 MB 或单次解析 >50 ms 再上 worker）。真实瓶颈不在这里。

---

## 6. 迭代速度的量化结论（回答架构师的关键问题）

### 6.1 真实改动分布（最近 80 个提交，`git log --numstat`）

```bash
cd /src/celestea_studio && git log --numstat --pretty=format:'%H' -80 | awk 'NF==3 {...}'   # 见 §附录 A
cd /src/celestea_harness && git log --numstat --pretty=format:'%H' -80 | awk 'NF==3 {...}'
```

| 区域 | 改动行数 | 占比 | 迁移后语言 |
|---|---|---|---|
| 引擎 `crates/**` | 45,714 | **63.0%** | 现在 Rust → 迁移后 TS |
| Studio 后端 `src/*.rs` | 11,953 | **16.5%** | 现在 Rust → 迁移后 TS |
| 前端 `frontend/src/**` | 14,899 | 20.5% | 已是 TS（不变） |
| **合计（代码）** | **72,566** | 100% | — |

> 提交量：Studio 65 个提交（58 个在 2026-09-07 之后）、引擎 39 个（26 个之后）。**79.5% 的代码改动落在 Rust**（引擎 63.0% + Studio 后端 16.5%）。

### 6.2 循环对比

| 改动位置 | 现状循环 | 全量 TS 后 | 改善 |
|---|---|---|---|
| 引擎语义（63.0% churn） | 引擎仓内 3.3–6.3s；**经 Studio 重建 17.8–19.2s** | `tsc --noEmit` ≈2s（或 strip-types 直接跑）+ 重启 0.04s | **~18s → ~2s** |
| Studio 后端（16.5%） | 14.8–26.9s | ~2s + 0.04s | **~20s → ~2s** |
| 前端（20.5%） | 3.7s（tsc 2.0 + vite 1.7） | 不变 | 0 |
| 全量干净构建 | 1m13s | 未测（TS 无「全量编译」概念；冷装依赖 17s） | 大幅改善 |

### 6.3 对「用 TS 换迭代速度」这一收益假设的裁定

- **收益是真的，但被高估了**：省下的是**每次改动 15–25 秒**，不是「省人日」。按每天 20 次重建计算 ≈ 5–8 分钟/天，一年 ≈ 20–35 小时——**约 3–5 人日/年**。
- **它不能单独支撑 100–150 人日的迁移成本**（回收期 20–50 年）。
- **但它确实是场景 B 相对场景 A 的实质优势**：A1 薄代理下引擎改动循环**完全不变**（仍 18s），只有 A2/B 才吃到这个收益。
- **真正的收益主体是「语言统一/心智负担」**（无法直接货币化），迭代提速只是它的附带红利。**报告据此把 D6 迭代速度权重定为 10%，而不是主导项。**

---

## 7. 测试等价策略（364 + 69 怎么迁）

### 7.1 分类迁移

| 类别 | 引擎（364） | Studio（69） | 迁移方式 |
|---|---|---|---|
| **纯逻辑/单元**（类型、投影、usage 提取、配置合并、guard 决策、协议解析、路径消毒、prompt 装配、compact 规划） | ≈180–220 | ≈55–65 | **1:1 复刻**为 `node:test`/`vitest`；用同一批 fixtures |
| **宿主相关**（沙箱 rlimit/bwrap/超时、进程注册表、fork 健康、上游超时） | ≈80–110 | 0 | **改为契约测试**：断言结构化错误码、输出上限、进程组被杀、超时行为；能力探测失败时 **skip 而非 fail**（修掉 §1.2 那个 fail 行为） |
| **golden / 回放对拍** | 新增 | 新增 | 从 Rust 实现导出 fixtures（真实 JSONL、SSE transcript、messages 投影、registry.tsv），TS 侧断言**逐字节/逐字段一致** |
| **端点契约** | — | 39 端点 | 对 Hono app 发真实 HTTP 请求，断言 status + 错误原文 + 响应形状（`docs/archive/api-contract.md` 是唯一真源） |
| **前端** | — | 无测试框架 | 保持 `tsc --noEmit` + `FRONTEND-RULES.md` 人工核对（迁移不改前端） |

### 7.2 三条硬性验收线（不通过不进入下一阶段）

1. **回放对拍 100%**：3 个真实会话 + ≥15 个合成 fixtures（撕裂尾、取消、子调用、thinking、step_limit、interrupted）的 `derive_messages` 与 messages 端点输出与 Rust **逐字节一致**。
2. **SSE 契约 100%**：8 种事件名 + `{turn,seq,payload}` 信封 + `lagged` 语义 + 2s tick + KeepAlive，用录制/回放脚本对拍。
3. **沙箱契约矩阵**：≥20 个用例（超时/工作目录逃逸/输出截断/env 白名单/rlimit/网络隔离/进程组回收）全绿，且 `sandbox` 对象形状与错误码与 Rust 一致。

---

## 8. 风险清单（具体到「哪一天会炸」）

### R1 会话日志与回放语义（**最高**）

- **炸点**：JSONL 追加/flush 策略不同 → 崩溃丢记录；撕裂尾处理不同 → 半条记录进 replay；**turn id 不单调**（Rust 在 `PersistentSessionLog::open` 取盘上 max+1）→ 事件覆盖；`parent_id` 子调用未跳过 → 上下文被几十条子调用撑爆；取消轮次未合成 `cancelled before execution` → 上游 400 `insufficient tool messages`；thinking delta 未聚合 → 回放顺序错乱。
- **防线**：§7.2 第 1 条 golden 对拍；两套实现**互读互写**同一批日志文件。

### R2 SSE 契约（**高**）

- **炸点**：`turn` 字段丢失（前端只发 payload 会丢 turn）；**512 事件缓冲 + lagged→`status{phase:"lagged"}`** 未复刻 → 慢客户端静默丢事件；断线重连不重放 mid-turn 事件（**现有限制**，迁移期不要顺手改行为）；KeepAlive/2s tick 缺失 → 反代超时断流。
- **防线**：SSE 录制/回放对拍；nginx 配置（`proxy_buffering off`、3600s）不变。

### R3 并发取消 + 代际热切（**高**）

- **炸点**：busy 槽未在所有路径释放（成功/取消/错误/409 前置）→ 服务永久 409；`swap_gen` 未迁移旧代 mailbox 中的 worker 回执 → 回执丢失；`gen_epoch` 顺序颠倒 → autowake 绑在已 drop 的旧代上；`shutdown` 顺序错 → 子进程泄漏。
- **防线**：把 `swap_gen`/`shutdown`/busy 释放写成**状态机测试**（TS 侧用 fake runtime）；双跑期观察 `/api/worker/status`。

### R4 `/compact` 重写 + 引擎重绑（**高**）

- **炸点**：**先写日志、后重绑引擎**（Rust 现状），重绑失败时磁盘已是压缩后日志，唯一回滚通道是 `.precompact`（单副本、覆盖式）。TS 若把顺序改成「先重绑后写」或写失败后未保留备份 → **对话历史不可恢复**。
- **防线**：契约测试钉死「409 守卫 → 计划 → 原子写 + 备份 → 重绑」顺序；双跑期对 `/compact` 做**磁盘快照对比**。

### R5 沙箱原语（**高**）

- **炸点**：rlimit 未包装 → 失控子进程吃满 CPU/内存；进程组未杀 → 孤儿进程；`/dev/zero` 类探测差异 → provider 选择与 Rust 不一致（本机 Rust 已因 `/dev/zero` 降级 userspace，TS 必须复刻同样的探测）；seccomp blob 生成缺失 → 加固失效。
- **防线**：§4.3 验收矩阵；**默认先对齐 userspace 路径**，bwrap 路径单列 gated 测试。

### R6 ToolGuard 路径白名单（**中**）

- **炸点**：`canonicalize` 等价物用错（`fs.realpath` 对不存在路径抛错，Rust 会 canonicalize 最近已存在祖先）→ 白名单绕过或误拒；TOCTOU 残余风险（Rust 已文档化）。
- **防线**：把 Rust 的 guard 测试用例（16 条）逐条复刻。

### R7 SSRF 失败即拒（**中**）

- **炸点**：Node `fetch` **默认跟随重定向**，必须手工 `redirect:'manual'` 并逐跳重新检查；`CELESTEA_HTTP_ALLOW/DENY` 解析失败必须 **fail-closed**（全拒），不能静默放行；必须禁用环境代理。
- **防线**：SSRF 用例矩阵（IPv4/IPv6/CIDR/DNS 多 IP/重定向跳出策略）。

### R8 key 与文件权限（**中**）

- **炸点**：`providers.json` 写入未重断言 0600；`public_view` 回显 key；key 落盘/进日志；keyless 借用引擎 key 时把 key 写进 provider 记录。
- **防线**：`fs.chmod(0o600)` 在每次 tmp+rename 后断言；对 `public_view` 输出做「不含 key 子串」断言（Rust 已有同类测试 13 条）。

### R9 打包与运维（**中**）

- **炸点**：Node runtime + node_modules 部署（体积/权限/版本漂移）；Bun 单文件不可交叉编译；systemd 从 `ExecStart=run-studio.sh` 改为 `node dist/server.js`；nginx SSE 参数被改动。
- **防线**：双 unit 并存 + nginx 一行切换 + 回滚脚本（§11）。

### R10 双跑期数据一致性（**中**）

- **炸点**：两个实现同时写同一 `cli-main.jsonl` / `providers.json` → 竞争写坏文件。
- **防线**：双跑期**只允许一套写**（Rust 写生产，TS 只读 + 影子写临时目录），用文件 diff 对比；切换前做一次全量 round-trip 校验。

---

## 9. 加权决策矩阵 + 敏感性分析

### 9.1 权重（按用户新口径重设，性能降权）

| # | 维度 | 权重 | 理由 |
|---|---|---|---|
| D1 | 维护成本与语义耦合（`swap_gen`、回放、compact、providers 热切、SSE、409 守卫） | **20%** | 用户指定第一重心；语义耦合决定长期维护成本 |
| D2 | 回归风险（39 端点 + SSE 契约 + 364 + 69 测试） | **18%** | 失败代价是用户可见的数据/事件损坏 |
| D3 | 双进程 / 运行时运维（supervisor、IPC、启动顺序、日志） | **14%** | 场景 A 的核心成本；场景 B 是单进程但引入 node runtime |
| D4 | 语言统一 / 心智负担（前端已 TS；引擎是否仍需 Rust） | **16%** | 用户决策的主导痛点 |
| D5 | 打包发布形态（单二进制 vs node runtime；Bun compile 是否缓解） | **12%** | 单维护者日常摩擦 |
| D6 | 迭代速度 | **10%** | §6：真实收益 3–5 人日/年，不能主导 |
| D7 | 安全 / 权限面（沙箱、guard、SSRF、0600） | **6%** | 与 D2 有重叠，单列防低估 |
| D8 | 性能 / 并发 | **4%** | **用户明确非延迟敏感**；实测已达标 |

### 9.2 评分（1–5）

| 维度（权重） | A0 维持 Rust | A1 薄代理（Rust core） | A2 Studio 语义重写 | **B 全量 TS** |
|---|---|---|---|---|
| D1 维护/语义耦合 (20%) | 4 | 2 | 3 | 3 |
| D2 回归风险 (18%) | 5 | 3 | 2 | 2 |
| D3 双进程/运维 (14%) | 5 | 2 | 2 | 3 |
| D4 语言统一 (16%) | 2 | 2 | 3 | **5** |
| D5 打包发布 (12%) | 5 | 3 | 3 | 3（Bun compile 可到 4） |
| D6 迭代速度 (10%) | 3 | 3 | 4 | **5** |
| D7 安全/权限 (6%) | 5 | 4 | 3 | 3 |
| D8 性能/并发 (4%) | 5 | 4 | 4 | 4 |
| **加权总分** | **4.12** | **2.60** | **2.78** | **3.38**（Bun compile：**3.50**） |
| 排序 | **1** | 4 | 3 | 2 |

**评分解读（诚实）**：
- **A0 仍最高**（4.12）：因为它在风险/运维/打包/安全上几乎满分，而 D4 语言统一只有 2 分。
- **B 第二**（3.38–3.50）：D4（5 分）+ D6（5 分）两项拿到最高分，但 D2（2 分）与 D7（3 分）拖累总分。
- **A1 最低**（2.60）：它同时继承了「双进程运维」和「语言仍不统一」两个缺点——**薄代理是最差的折中**。

### 9.3 敏感性分析

| 场景 | A0 | B | 结论 |
|---|---|---|---|
| 基准权重（性能 4%） | **4.12** | 3.38 | A0 胜 |
| B 采用 Bun compile（D5 3→4） | 4.12 | 3.50 | A0 胜 |
| **「语言统一」权重升至 30%**（D1 15%、D2 12%、D3 10%、D4 30%、D5 12%、D6 12%、D7 5%、D8 4%） | 3.71 | **3.88** | **B 反超** |
| 性能权重回到 W229 的 8%（其余按比例） | 4.15 | 3.40 | A0 胜 |
| 若沙箱能在 ≤8pd 内对等（D2 2→3、D7 3→4） | 4.12 | 3.74 | A0 仍略胜 |

> **裁定**：只有当「语言统一/心智负担」被明确当作**主导痛点**（权重 ≥30%）时，场景 B 才在加权上胜出。用户已按此口径决策——**决策成立的前提是承认这是一次「为语言统一付 100–150 人日」的主动重构，而不是一次「省钱/提速」的投资**。

---

## 10. 分阶段 strangler 迁移计划（单维护者，人日为估算）

> 原则：**Rust 版全程可用、随时可回退**；每个阶段都有「可验收产物」，不做大爆炸式切换。

### P0 契约冻结与骨架（5–7 pd）

| 项 | 内容 |
|---|---|
| 交付 | ① pnpm workspace 骨架（`packages/{core,llm,session,tools,agent-loop,workers,runtime}` + `apps/studio`）；② 从 `docs/archive/api-contract.md` / 引擎 `DEVELOPMENT.md` 提取**机器可读契约**（39 端点 JSON、8 SSE 事件、`SessionEvent` JSONL schema、10 工具 spec、数据文件 schema）；③ golden fixture 导出器（跑 Rust 实现导出真实 JSONL / SSE transcript / messages 投影 / registry.tsv）；④ 回放对拍脚本骨架；⑤ Node 24 + Hono + node:test/vitest 工具链 |
| 验收 | `pnpm typecheck` 全绿；契约 JSON 入库；对拍脚本能跑通 3 个真实会话并输出 diff 报告（此时 diff 必然非空，只要求工具链可用） |
| 回滚 | 不触碰生产，无需回滚 |
| 风险 | 低 |

### P1 语义内核：core + session + agent-loop（18–26 pd）

| 项 | 内容 |
|---|---|
| 交付 | TS `core`（类型/seam/EventBus）、`session`（JSONL append/replay/撕裂尾/turn id/derive_messages/mailbox）、`agent-loop`（turn/step 驱动、上下文裁剪、UsageTracker、LoopEvent、取消语义） |
| 验收 | §7.2 第 1 条 **回放对拍 100%**（3 真实 + ≥15 合成 fixtures）；镜像 Rust 纯逻辑单测 ≈150–190 条 |
| 回滚 | 无生产路径 |
| 风险 | **中**（回放语义） |

### P2 LLM + 工具面 + 沙箱（22–30 pd）

| 项 | 内容 |
|---|---|
| 交付 | `llm`（裸 SSE / usage 三键名 / 三档超时 / reasoning_effort 直通）、`tools`（registry/guard/builtin/http/process/**sandbox**/**run_code broker**） |
| 验收 | ① LLM：录制帧回放 + timeout 分类；② **沙箱契约矩阵 ≥20 用例**（§7.2 第 3 条）；③ run_code 用**现有 Python SDK** 端到端通过；④ SSRF fail-closed 矩阵；⑤ guard 16 条用例复刻 |
| 回滚 | 无生产路径 |
| 风险 | **最高**（沙箱；单独预算 8–12 pd，且尾部风险大） |

### P3 运行时装配 + worker 编排（14–20 pd）

| 项 | 内容 |
|---|---|
| 交付 | `runtime`（compose 15 步 / profile 12 键 / key 三路 / run_turn 流式 + 取消 / shutdown 幂等）、`workers`（registry.tsv 原子写 / 驱动循环 / watchdog / 3 工具 / 回执格式） |
| 验收 | 工具面 = 10；worker 闭环（spawn→brief→回执→宿主 autowake）用 FakeLlm 复现；registry.tsv 与 Rust **互读互写**；`swap_gen` 回执迁移用例 |
| 回滚 | 无生产路径 |
| 风险 | 中高 |

### P4 Studio HTTP 层（Hono）+ 前端对接（18–26 pd）

| 项 | 内容 |
|---|---|
| 交付 | 38 路由 / 43 method+path / 39 契约；SSE 总线（512 + lagged + 2s tick + KeepAlive）；静态 + SPA fallback；statusline；autowake；workspaces / providers / prompts / compact 四模块；0600 写入；key 不回显 |
| 验收 | 39 端点契约测试全绿（status + 错误原文 + 形状）；SSE 对拍（§7.2 第 2 条）；**用 fake engine 与真 Rust engine 各跑一遍** |
| 回滚 | 无生产路径（跑在 :3778） |
| 风险 | 中 |

### P5 双跑对比 + 数据兼容验证（10–15 pd）

| 项 | 内容 |
|---|---|
| 交付 | Rust(:3777) 与 TS(:3778) 并行；**单一写入方**（Rust 写生产，TS 影子写临时目录）；SSE transcript 与 REST 响应自动 diff；数据文件 round-trip 校验（workspaces/providers/prompts/cli-main.jsonl/registry.tsv/.precompact） |
| 验收 | ≥7 天真实使用零分歧；`/compact` 磁盘快照一致；provider 热切 / 取消 / lagged / worker 闭环全部对拍通过 |
| 回滚 | 停 TS 进程即可 |
| 风险 | **高**（数据一致性） |

### P6 切换与退役（5–8 pd）

| 项 | 内容 |
|---|---|
| 交付 | 新 systemd unit（`celestea-studio-ts.service`）、nginx upstream 一行切换、回滚 runbook（<15 分钟）、Rust 仓只读归档 |
| 验收 | 生产跑 TS ≥2 周；**回滚演练一次成功**；旧 unit 保留但 disabled |
| 回滚 | nginx 切回 3777 + `systemctl start celestea-studio` |
| 风险 | 中 |

### 10.1 汇总

| 阶段 | 人日 |
|---|---|
| P0 契约冻结 | 5–7 |
| P1 语义内核 | 18–26 |
| P2 LLM+工具+沙箱 | 22–30 |
| P3 runtime+workers | 14–20 |
| P4 Studio HTTP | 18–26 |
| P5 双跑 | 10–15 |
| P6 切换退役 | 5–8 |
| **小计** | **92–132** |
| **含 15% 缓冲** | **106–152 → 报告口径 100–150（中位 ≈125）** |

**关键路径**：P0 → P1 → P2 → P3 → P5 → P6（P4 可在 P0 后用 fake engine 并行启动，但不缩短单维护者的总工时）。

---

## 11. 切换与回滚策略

### 11.1 端口与进程

| 阶段 | Rust | TS | nginx |
|---|---|---|---|
| P0–P4 | `:3777`（生产） | `:3778`（开发/测试） | 不变 |
| P5 双跑 | `:3777`（**唯一写入方**） | `:3778`（只读 + 影子写） | 不变 |
| P6 切换 | disabled | `:3777` | `proxy_pass` 改一行 → 仍是 3777（进程换） |
| 回滚 | `systemctl start celestea-studio` | stop | 无需改 nginx |

### 11.2 数据文件兼容（**格式冻结**）

- `workspaces.json` / `providers.json` / `prompts.json` / `<ws>/<session>/cli-main.jsonl` / `session.json` / `cli-main.jsonl.precompact` / `.celestea-archived` / `.celestea-trash` / `/tmp/celestea-workers-registry.tsv`：**迁移期一律不改格式**（不新增 `version` 字段，避免双实现分歧）。
- 每个文件都有 **read → write → re-read** round-trip 测试，两套实现互为对照。
- 切换前：用 TS 实现读一遍全部生产数据（只读），确认 0 解析错误。

### 11.3 systemd / nginx

- 新增 `celestea-studio-ts.service`（`ExecStart=/usr/bin/node /src/celestea_studio-ts/apps/studio/dist/server.js`，环境变量与旧 unit 一致，**key 仍从 `/opt/dsh/.credentials.yaml` 经启动脚本注入，不落盘**）。
- 旧 `celestea-studio.service` **保留但 disabled**，至少 2 周。
- nginx 的 SSE 参数（`proxy_buffering off` / `proxy_cache off` / 3600s / chunked）**一个都不改**。

### 11.4 回滚触发条件（任一命中即回滚）

1. 会话日志出现**分歧或损坏**（replay 结果不一致、turn id 重复、日志被截断）；
2. SSE 事件丢失/顺序错乱/`lagged` 语义异常；
3. `/compact` 后历史不可恢复；
4. 沙箱出现逃逸、rlimit 失效或孤儿进程；
5. 39 端点任一出现契约偏差且 2 小时内无法修复；
6. 生产错误率或 5xx 显著上升。

---

## 12. 若痛点只是「语言不统一/心智负担」，更便宜的路（成本对比）

| 方案 | 成本 | 收益 | 与场景 B 的差距 |
|---|---|---|---|
| **S0 维持现状** | 0 | 语言仍不统一 | 用户已否决 |
| **S1 契约生成 TS client**（从 `api-contract.md` 生成 zod schema / `openapi.json` → `openapi-typescript` / `ts-rest`） | **3–5 pd** | 前后端类型契约自动对齐，消除手工 `types.ts` 漂移 | 拿到「类型统一」的 80%，**不解决后端语言** |
| **S2 引擎 sidecar 化**（W229 §6 契约；Rust 引擎独立进程 + 冻结 HTTP 契约） | **7 pd** | 解耦引擎与 HTTP 层、任何语言/前端都能接入、换代更安全 | 拿到「架构解耦」，**不解决语言** |
| **S3 S1 + S2 组合** | **10–12 pd** | 类型契约 + 架构解耦 | 仍不解决「引擎是 Rust」 |
| **S4 场景 B 全量 TS** | **100–150 pd** | **单一语言**（前端 + 后端 + 引擎） | 唯一能达成用户目标的路 |

> **诚实结论**：如果用户的痛点是「类型漂移 / 契约不同步」，S1 用 3–5 人日解决；如果是「引擎与 HTTP 层耦合」，S2 用 7 人日解决；**只有「我要整个仓库只有一种语言」这个目标，才必须付 100–150 人日**。用户已明确选择后者。

---

## 13. 结论与触发条件

### 13.1 结论

**按用户决策执行场景 B（引擎 + Studio 后端全量 TS），预算 100–150 人日，按 §10 的 7 阶段推进；Rust 版全程保留可回退。**

### 13.2 三个不可妥协的前置

1. **P0 的 golden 回放对拍必须先于任何沙箱/回放代码**——没有对拍，迁移就是盲飞。
2. **沙箱分两层实现**：先 1:1 对齐本机实际运行的 `userspace` 回退路径，再补 `bwrap` 路径（gated 测试）；**不允许**在没有对等测试的情况下替换生产沙箱。
3. **P5 双跑期只能有一个写入方**（Rust 写，TS 影子写），切换前做全量数据 round-trip 校验。

### 13.3 止损线：什么条件下放弃并回退 Rust

| # | 条件 | 动作 |
|---|---|---|
| 1 | P2 沙箱阶段投入 **>12 pd** 仍无法通过 ≥20 用例矩阵，或必须保留 Rust helper 才能完成 | **停止**；保留 Rust（helper 方案已破坏「零 Rust」目标） |
| 2 | P1 回放对拍分歧 **>5%** 且 5 pd 内无法收敛 | **停止**，维持 Rust |
| 3 | **6 个月**仍未完成 P4 | **停止**，重新评估（此时已投入 ~50–70 pd，继续的边际收益不确定） |
| 4 | 单二进制发布成为硬需求（Windows/macOS 分发）且 Bun compile 不可接受（体积/兼容性） | **停止** |
| 5 | 单维护者无法在 TS 侧安全驾驭进程/沙箱（出现沙箱逃逸或 rlimit 失效事故） | **立即回退**（§11.4） |

### 13.4 什么条件下应重新评估（若未来选择维持 Rust）

规模阈值、维护者数量、发布需求、性能指标任一发生下列变化时，重开评估：
- 后端 + 引擎代码量再翻倍（>60k 行）且维护者仍为 1 人；
- 需要 ≥3 人协作且其中 ≥2 人只写 TS；
- 需要发布 Windows/macOS 桌面客户端（单二进制成为硬需求）；
- SSE 并发从「个位数客户端」变成「数百客户端 + 多租户」；
- 引擎需要被第三方以库形式嵌入（此时 sidecar 化优先级高于换语言）。

---

## 附录 A：实测命令清单（可复现）

```bash
# ---- 代码规模 ----
cd /src/celestea_harness && for d in crates/*/; do n=$(find "$d" -name '*.rs'|wc -l); \
  l=$(find "$d" -name '*.rs' -print0|xargs -0 cat|wc -l); echo "$(basename $d) files=$n lines=$l"; done
find . -name '*.rs'|wc -l; find . -name '*.rs' -print0|xargs -0 cat|wc -l
cd /src/celestea_studio && find src -name '*.rs'|xargs wc -l|sort -n
find frontend/src -name '*.ts'|xargs wc -l|tail -1; find frontend/src -name '*.css'|xargs wc -l|tail -1
grep -c '\.route(' src/main.rs; grep -cE '^### ' docs/archive/api-contract.md

# ---- 测试 ----
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
cd /src/celestea_harness && time cargo test --workspace
CELAESTEA_RUN_SHELL_V2_NPROC=0 cargo test --workspace
cd /src/celestea_studio && time cargo test && time cargo test --release

# ---- 构建 / 迭代循环 ----
CARGO_TARGET_DIR=/tmp/w268-target cargo build --release              # 1m13s
touch src/main.rs && CARGO_TARGET_DIR=/tmp/w268-target cargo build --release
cd /src/celestea_harness && touch crates/session/src/log.rs && cargo build --workspace --release
touch crates/core/src/lib.rs && cargo build --workspace --release
touch /src/celestea_harness/crates/tools/src/sandbox.rs   # 在 Studio 侧重建
cd /tmp/w268-fe && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build

# ---- 运行态 ----
ls -la /src/celestea_studio/target/release/celestea-studio
ps -o pid,rss,vsz,etime,pcpu,pmem -p $(pgrep -f 'target/release/celestea-studio')
systemctl show celestea-studio.service -p MainPID,MemoryCurrent,NRestarts
for p in /api/health /api/status /api/tools /api/sessions /api/workspaces /api/providers /api/prompts /api/worker/status; do \
  curl -s -o /dev/null -w "$p %{http_code} %{time_total}s %{size_download}B\n" http://127.0.0.1:3777$p; done

# ---- 宿主能力 ----
for t in node npm pnpm bun deno go dotnet python3 rustc cargo bwrap unshare prlimit; do command -v $t; done
node -v; bun -v; npm view hono version
unshare -Urn -- /bin/echo ok                     # EPERM
bwrap --unshare-all --dev /dev --proc /proc --ro-bind / / --tmpfs /tmp --bind /tmp /tmp -- \
      /bin/sh -c 'exec 3</dev/zero 2>/dev/null && printf ok || printf no'
grep -m3 -i sandbox /tmp/celestea-studio.log     # os sandbox unavailable -> userspace

# ---- Node 侧 scratch 基准（不落仓库） ----
node /tmp/w268-bench/jsonl.mjs <cli-main.jsonl>  # JSONL 解析吞吐
node /tmp/w268-bench/sse.mjs 500                 # SSE 500 并发
node /tmp/w268-bench/spawn.mjs                   # prlimit/bwrap 包装
cd /tmp/w268-bun && bun add hono && bun build --compile ./app.ts --outfile ./app

# ---- churn ----
cd /src/celestea_studio && git log --numstat --pretty=format:'%H' -80 | awk 'NF==3 {...}'
cd /src/celestea_harness && git log --numstat --pretty=format:'%H' -80 | awk 'NF==3 {...}'
```

## 附录 B：核对过的源码与文档

- Studio：`docs/archive/backend-language-eval.md`（W229 全文）、`docs/DEVELOPMENT.md`（W264 全文）、`docs/archive/api-contract.md`（端点标题清单）、`src/{main,api,workspaces,providers,prompts,compact}.rs`（规模、符号、关键常量）、`frontend/src/sse.ts`、`frontend/package.json`、`Cargo.toml`、`workspaces.json`、`providers.json`（仅权限位）、`scripts/run-studio.sh`、`/etc/systemd/system/celestea-studio.service`、`/etc/nginx/sites-available/studio.celestea.top.ssl`
- 引擎：`docs/DEVELOPMENT.md`（W265 全文 987 行）、`crates/*/src/**`（规模 + 关键实现：`tools/src/{sandbox,run_code,guard,http,process}.rs`、`session/src/{log,persistent,registry,mailbox}.rs`、`agent-loop/src/{lib,loop,context}.rs`、`runtime/src/{compose,run,config}.rs`、`llm/src/client.rs`、`workers/src/{registry,watchdog,tools}.rs`、`core/src/{session_log,tool,message,event_bus}.rs`）、`Cargo.toml` / `Cargo.lock`
- 运行态：`/tmp/celestea-studio.log`（沙箱降级证据）、systemd 状态、只读 GET 延迟、真实 `cli-main.jsonl`（2 个）
- 本报告所有数字均为 W268 在 2026-09-10 实测；架构师提供的数字（Studio 28.9s / 引擎 20.7s / 前端 5.4s / 重启 0.03s）已逐项复核，差异见 §1.5。

## 附录 C：本会话用量（W268，`report_usage` 实测）

| 项 | 值 |
|---|---|
| uncached input tokens | 97,593 |
| output tokens | 80,438 |
| cache read tokens | 4,207,104 |
| context pressure | 171,733 / 1,000,000（17.2%） |
| turns / steps | 1 / 47 |
| LLM 耗时 / 工具耗时 | 1,140,001 ms / 150,068 ms |
| TTFT | 514,811 ms（48 steps） |
