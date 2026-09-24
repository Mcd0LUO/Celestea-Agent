# `packages/tools/src/sandbox` — 执行边界（provider 层）

`run_shell` / `process_control` 只依赖 `@celestea/core` 的 `Sandbox` seam；**隔离强度由本目录的 provider 决定**，
调用点一行不改。P2c 落地的 OS 隔离 provider 是 `bwrap`（bubblewrap），依据沙箱探索期的实测结论（探索脚本 `spikes/sandbox/` 已于 W881 移出公开仓）。

## 1. 文件分工

| 文件 | 职责 |
|---|---|
| `config.ts` | `SandboxConfig` 的 env 归口（`CELAESTEA_RUN_SHELL_*`）+ 子进程环境白名单 |
| `workdir.ts` | workdir 解析：规范化 + 必须落在 `root` 内（**词法**校验，见 §7） |
| `launch.ts` | provider 共用的进程管线：`detached` 进程组 → 流式限量捕获 → 超时 SIGKILL 整组 |
| `bwrap-argv.ts` | **argv 顺序真源**（`--unshare-all → --ro-bind / / → --dev /dev → --proc /proc`）+ `SandboxMeta` 映射 |
| `enforcement.ts` | **每个 provider 自报 completeness**（`full`/`partial` + `promise_gaps`），证据来自 `probe.ts` |
| `bwrap.ts` | `BwrapSandbox`：探测门禁 + 组命令 + 上报真实隔离度（`BwrapMeta`） |
| `provider.ts` | provider 选择策略（bwrap 探测 → userspace）与 `CELESTEA_SANDBOX_FALLBACK` |
| `probe.ts` | 宿主自检：bwrap 存在性 + **按正确顺序**的设备冒烟 + **隔离证据实测**（命名空间 token / 只读根 / 私有 tmp）；结果进程内缓存、可注入 |
| `limits.ts` | 6 类 rlimit 的类型/默认值 + **按 UID 全机线程数推导 `RLIMIT_NPROC`** |
| `rlimit.ts` | rlimit 施加层：`prlimit` 优先，缺失时退 `/bin/sh` 的 `ulimit` 内建 |
| `seccomp.ts` | 纯 TS 的 cBPF 白名单（322 条指令 / 2576 字节），交给 `bwrap --seccomp FD` |
| `userspace.ts` | P2b 的 userspace 实现，保留为**显式回退**与测试对照 |
| `fake-sandbox.ts` | 脚本化测试替身（证明 seam 可替换） |
| `async.ts` / `child.ts` | 超时竞速 / `SandboxChild` 包装与进程组信号 |

## 2. 分层顺序（外 → 内）

```
node spawn(detached: true)                     → 自成进程组，超时 kill(-pid) 整组回收
  prlimit --cpu/--as/--nproc/--fsize/--nofile/--core
    bwrap --unshare-all --die-with-parent      → user/mount/pid/net/ipc/uts ns
      --ro-bind / /  →  --dev /dev  →  --proc /proc
      [--share-net]  [--tmpfs /tmp | --bind /tmp /tmp]  [--tmpfs <mask>…]
      --bind <workdir> <workdir> --chdir <workdir>  [--seccomp 3]
        /bin/sh -c <command>                   → 仅当 prlimit 缺失时改走 ulimit 包装
```

### argv 顺序铁律（W274 §2 的核心修复）

bwrap 按参数顺序叠加挂载，**后挂的覆盖先挂的**。引擎旧顺序 `--dev /dev` 在 `--ro-bind / /` 之前，
宿主根会把私有 devtmpfs 整块盖掉，`/dev/zero` 变 `EACCES` → 启动探测误判「bwrap 不可用」→ 生产静默跑在
userspace 弱沙箱上。本实现锁死顺序并由回归测试断言：

- `bwrap.test.ts`：`buildBwrapArgv()` 前缀必须是 `--unshare-all, --die-with-parent, --ro-bind, /, /, --dev, /dev, --proc, /proc`；
- `bwrap-live.test.ts`：真机跑设备冒烟（`DEV-OK`），并对照旧顺序（stdout 为空 + stderr `Permission denied` + 非零退出），
  证明该断言不是空转。

`--die-with-parent` **始终**添加：父进程被 SIGKILL 时（Node 的 `exit` 钩子覆盖不到）由内核回收整个沙箱树。
真机用例同时给出反证：去掉该 flag 时同一棵树会变成孤儿。

## 3. Provider 选择与 fail-closed 策略

```
probeHost(): bwrap 在 PATH？→ `bwrap --version` 成功？→ 按正确顺序的设备冒烟返回 ok？
  ├─ 可用 → BwrapSandbox（net 隔离 / 私有 /tmp / 只读根 / seccomp 可选）
  └─ 不可用 → CELESTEA_SANDBOX_FALLBACK
               ├─ userspace（默认）→ UserspaceSandbox，选择结果显式标注 degraded=true + reason
               └─ fail              → 抛结构化错误，**拒绝执行**（不静默降级）
```

- 未知的 `CELESTEA_SANDBOX_FALLBACK` 取值 = 配置错误（fail-closed）：不因为一个拼写错误就决定安全姿态。
- `BwrapSandbox` 自身在**每次调用**前复查探测结果：运行期 bwrap 消失/失效 → `SandboxError`，不会退回 userspace。
- 错误码：`SandboxError` 的 kind 仍限于 core 契约的 `timeout|workdir|arg|config|spawn`，
  「沙箱不可用」走 `config`，消息前缀固定 `sandbox_unavailable:`（渲染为
  `run_shell-sandbox: code=config msg="sandbox_unavailable: …"`）。

### 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `CELESTEA_SANDBOX_FALLBACK` | `userspace` | bwrap 不可用时的策略：`userspace` 降级 / `fail` 拒执行 |
| `CELESTEA_SANDBOX_BWRAP` | PATH 查找 | 指定 bwrap 二进制绝对路径 |
| `CELESTEA_SANDBOX_NET` | `0` | `1` → 加 `--share-net`（保留宿主网络），契约等价 `net_isolated=false` |
| `CELESTEA_SANDBOX_SHARE_TMP` | `0` | `1` → `--bind /tmp /tmp`（共享宿主 /tmp），否则私有 tmpfs |
| `CELESTEA_SANDBOX_SECCOMP` | `0` | `1` → 装载 cBPF 白名单（`--seccomp 3`） |
| `CELESTEA_SANDBOX_MASK` | 空 | 逗号分隔的绝对目录，用空 tmpfs 盖住（如 `/home,/root`，默认不开） |
| `CELESTEA_SANDBOX_NPROC` | 推导 | 显式覆盖 `RLIMIT_NPROC` |
| `CELESTEA_SANDBOX_NPROC_HEADROOM` | `512` | 推导时的余量 |
| `CELESTEA_SANDBOX_RLIMITS` | `1` | `0` → 完全不施加 rlimit |

## 4. `RLIMIT_NPROC`：唯一一个语义有毒的 rlimit

`RLIMIT_NPROC` 统计的是**该 real UID 全宿主机**的线程总数，不是沙箱内的进程树。W274 §3.2 实测：
本机 uid 有 347 线程时 `--nproc=346` 让 bwrap 连 user namespace 都建不出来（`clone` EAGAIN）；
引擎默认 512 只剩 ~165 余量，worker 并发一涨就会命中。因此：

```
nproc = max(NPROC_FLOOR(1024), threads(uid) + headroom(512))
```

`countUidThreads()` 通过扫描 `/proc/<pid>/task`（只统计本 uid 的 pid）求和；非 Linux / 无 `/proc` / 数不出来 → 退回 floor。
探测到的线程数与最终 `nproc` 都进 `BwrapMeta`（`uid_threads` / `nproc`），便于事后归因。

## 5. seccomp（可选，纯 TS）

`seccomp.ts` 逐字段移植引擎的 `seccomp_v2` 过滤器：x86_64 之外 → `EPERM`，x32 位标记 → `EPERM`，
白名单外 → `EPERM`（`clone3` 例外 → `ENOSYS`，让 glibc 回退 `clone`）。序列化为 bwrap 期望的
`--seccomp FD` blob（8 字节/指令，fd 固定为 3）。单测锚定 322 条指令 / 2576 字节与首尾字节；
真机用例断言 `Seccomp:\t2` 且普通命令（`echo`）照常工作。无 bwrap 时 **不静默忽略** —— 申请 seccomp 即失败。

## 6. 测试矩阵

| 用例 | 文件 | 性质 |
|---|---|---|
| argv 顺序 / `--die-with-parent` 恒在 / `--share-net` 与 `/tmp` 语义 | `bwrap.test.ts` | 纯单测 |
| `SandboxMeta` 与实际隔离度一致 | `bwrap.test.ts` | 纯单测 |
| seccomp blob 指令数、字节序、文件句柄生命周期 | `bwrap.test.ts` | 纯单测 |
| 探测失败 → 默认可见降级 / `=fail` 拒执行 / 未知取值报错 / 运行期复查 | `bwrap.test.ts` | 注入探测，纯单测 |
| `NPROC` 推导（含「必须严格大于线程数」）、`countUidThreads`、rlimit 两条路径 | `limits.test.ts` | 纯单测 |
| 设备冒烟（顺序回归）+ 旧顺序反证 | `bwrap-live.test.ts` | 真机 |
| 只读根 / 可写 workdir / 私有 `/tmp` 宿主不可见 | `bwrap-live.test.ts` | 真机 |
| 网络隔离（`/proc/net/dev` 只剩 `lo`） | `bwrap-live.test.ts` | 真机 |
| 输出上限：截断 + 不阻塞 + 退出码保留 | `bwrap-live.test.ts` | 真机 |
| 超时杀整组（零残留） | `bwrap-live.test.ts` | 真机 |
| `--die-with-parent` 回收（含去 flag 的孤儿反证） | `bwrap-live.test.ts` | 真机 |
| seccomp 装载 + 常规命令可用 | `bwrap-live.test.ts` | 真机 |

真机用例以 `probeHost().bwrapUsable` 为门禁（无 bwrap 的机器整组 skip，而不是变红或假装通过）。
残留进程检查一律匹配**每次运行唯一**的标记串，并且只 kill 自己扫到的 pid（共享宿主机纪律，W274 §10）。

```sh
pnpm vitest run packages/tools/src/sandbox            # 本目录全部用例
pnpm check                                            # typecheck + lint + lint:arch + test
```

## 7. 已知边界（如实记录）

- `--ro-bind / /` 让全盘**只读但仍可读**：隐藏目录需要显式 `CELESTEA_SANDBOX_MASK`（默认关闭，避免误伤构建）。
- 后台进程（`run_shell background:true`）同样带 `--die-with-parent`：跨 turn 存活，但服务器进程消失即随之回收，
  不再像 userspace 路径那样留下孤儿（这正是我们要的语义）。
- workdir 越界是**词法**校验（宿主无 `CAP_SYS_CHROOT`，raw `unshare+chroot` provider 在本机与引擎侧同样不可用）。
- userspace 回退无法提供 netns / 私有 tmp / 只读根 / seccomp，且 `setsid()` 逃逸与父死孤儿都会泄漏（W274 §6）。
  这正是默认策略要「可见降级」而不是静默降级的原因：`selectSandboxDetailed()` 的 `degraded` / `reason` 应进启动日志。
- `SandboxMeta` 仍是 core 契约的字段；额外观测（`readonly_root` / `rlimit_via` / `nproc` / `uid_threads` / `bwrap_version`）
  以 `BwrapMeta` 形式附加在结果里，core 契约未改动。

## 8. enforcement（W1483）：事实之外的那一层

`SandboxMeta` 的 `net_isolated` / `tmp_private` / `seccomp` 报告**事实**；`enforcement: "full" | "partial"`
报告**这份事实是否覆盖了该模式承诺的每一个效果**，`promise_gaps` 逐项列出缺了什么。

- **provider 自报**：`bwrapEnforcement()` / `userspaceEnforcement()` 分别在构造 meta 的地方调用，
  消费方不得从一堆 boolean 自己拼。
- **证据说话**：bwrap 的命名空间承诺由冒烟子进程实测（`/proc/self/ns/*` 是否与宿主不同），
  只读根与私有 tmp 同批测出；**没测到 = gap**，绝不因为「参数写了」就报 `full`。
  这条正是「bwrap 起来了但某个隔离没生效」的兜底。
- **绝对承诺的消费方**：`CELESTEA_SANDBOX_FALLBACK=fail` 在 `partial` 时于选择阶段拒绝
  （复用既有 `sandbox_unavailable:` 词汇，不新造机制）；`unsandboxed` 会话授权仍是唯一的显式豁免。
  默认模式则**显式降级**并把 `enforcement` / `promiseGaps` 放进 `SandboxSelection`。

### denial 词汇（W1483）

三个前缀是**冻结契约**（Rust parity + 多套测试逐字钉住），W1483 不改名，改的是「只有一个声明点」：

| family | prefix | 产生者 |
|---|---|---|
| `args` | `toolargs` | `registry.ts` 的 schema 阶段 |
| `guard` | `toolguard` | `registry.ts` + `guard/path-guard.ts` |
| `sandbox` | `run_shell-sandbox` | `core` 的 `SandboxError` |

`packages/tools/src/errors.ts` 的 `DENIAL_PREFIXES` 是唯一真源，`denialFamily()` 让消费方按家族
分支而不是自己 string-match 三个字面量；渲染统一走 `contractDenial()`（core）→ `contractError()`（tools）。
