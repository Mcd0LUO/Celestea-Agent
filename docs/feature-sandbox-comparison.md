# 特性设计 · 沙箱机制横向评估（DSH / ZCode / Claude Code → 本仓）

> 状态：**设计**（只调研与设计，不落地代码）。
> ⚠️ 状态行只出现一个类别词（`classifyStatus` 先命中先归类，见 `AGENT.md` §7 第 2 条）。
> 依赖：[ARCHITECTURE.md](./ARCHITECTURE.md) 的分层与 seam 纪律、[deployment.md](./deployment.md) §4 的安全模型、[configuration.md](./configuration.md) 的环境变量表。

## 1. 一句话目标

**给本仓的沙箱机制找一条「有据可依」的演进路线**：把三个同类系统（DSH、ZCode、Claude Code）
的沙箱实现读实、按机制而非按宣传对比，指出本仓现在**站在哪里**、**缺什么**、**哪些设计值得抄**、
**哪些是本仓已经做得更好的**。

本文不落地代码。所有结论都标注来源，并区分**实读**（读源码/实测）与**转述**（读对方文档）。

## 2. 四个系统的沙箱机制（实读）

### 2.1 机制对照

| | DSH | Claude Code（`sandbox-runtime`）| ZCode | 本仓（Studio）|
|---|---|---|---|---|
| 抽象层 | `dsh-sandbox`（策略）+ `dsh-sandbox-local`（runner 链）| `srt` 单包 | 无 OS 层，只有 `permission/` 规则引擎 | `packages/tools/src/sandbox/`（28 文件 4548 行）|
| Linux | `bwrap` → `landlock` | `bwrap` + `apply-seccomp` | **无** | `bwrap` → `userspace` |
| macOS | `seatbelt`（`sandbox-exec`）| `sandbox-exec` + SBPL + 违规日志监控 | `sandbox-exec`（仅 `zcode-acp` 桥，非官方 CLI）| **无** |
| Windows | `windows-acl`（受限令牌 WRITE_RESTRICTED）| `srt-sandbox` 本地账户 + WFP 出网栅栏 | **无** | **无**（降级 userspace）|
| 网络 | 命名空间隔离，**不做域名过滤** | 代理强制域名白名单（HTTP + SOCKS5）| 无 | `CELESTEA_SANDBOX_NET` 开关 + `CELESTEA_HTTP_ALLOW/DENY` |
| 读写策略 | `read-only` / `workspace-write` / `danger-full-access` | 读「先拒后允」、写「仅允许」**两条独立规则** | `allow`/`ask`/`deny` 规则 + 风险等级 | 三档 preset + `allPaths` + grants |
| 提权路径 | 被拒后请求**严格更宽**模式 + 人工批准 | 无（配置期决定）| `ask` 弹窗（once/always）| grants（`network`/`unsandboxed`/`write_roots`）|

### 2.2 DSH：策略与 runner 分离，四种机制同一个缝

`dsh-sandbox` 是**策略层**，`dsh-sandbox-local` 是**执行层**，两者通过一个 seam 对接：

```ts
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: SessionId   // 后端据此键控每会话状态（如 windows-acl 的私有 temp）
}
```

**值得抄的设计**：

1. **`SANDBOX_UNAVAILABLE` 而不是静默降级** —— 「如果请求的模式无法强制执行，调用失败而不是无约束运行」。
2. **`enforcement: 'full' | 'partial'`** —— 后端自报完整性，调用方据此决定是否接受。
3. **runner 链是数据，不是分支** —— Linux 的 `bwrap → landlock` 是一个候选链，逐个功能探测，
   而不是 `if (linux) ... else if (darwin) ...`。`chain?: readonly SelectedRunner['runner'][]`
   是**可注入的测试缝**。
4. **提权是「严格更宽」而非「任意」** —— `WIDER_MODES` + `ESCALATION_TARGETS`，
   被拒后模型可请求**恰好宽一档**的模式，由人工批准（`approveEscalation`）。
   这比「弹一个 allow/deny」更难被社工。

**本仓与它的差距**：本仓的 provider 选择是 `if (bwrap) else userspace` 的**二选一硬编码**
（`provider.ts:120`），没有「链」的概念，也没有「严格更宽」的提权语义
（本仓的 grants 是任意 `write_roots`，没有「只宽一档」的约束）。

### 2.3 Claude Code `sandbox-runtime`：机制最完整，且**网络**是它的差异化

这是三家里唯一把**网络**做成一等公民的：

- **读/写用两条相反的规则**（这是最值得抄的一条）：
  - **读**：默认全允许，`denyRead` 划走大块（如 `/Users`），`allowRead` 再**洞里开窗**（如 `.`）。
    **`allowRead` 优先于 `denyRead`**。
  - **写**：默认全拒，`allowWrite` 显式放行。**`denyWrite` 优先于 `allowWrite`**。
  - 且 `denyRead` 里比 `allowRead` 更具体的条目（如 `**/.env`）**仍然被拒**。
- **网络走代理，不是走命名空间**：Linux 上 `--unshare-net` 移除整个网络命名空间，
  所有流量必须走 bind-mount 进沙箱的 **Unix socket** → 宿主的 HTTP/SOCKS5 代理。
  代理按请求查 `allowedDomains`/`deniedDomains`。
- **强制拒绝清单**（`DANGEROUS_FILES`）：`.gitconfig` `.gitmodules` `.bashrc` `.bash_profile`
  `.zshrc` `.zprofile` `.profile` `.ripgreprc` `.mcp.json`，外加目录 `.vscode` `.idea`
  `.claude/commands` `.claude/agents`；`.git` 只锁 `hooks` 与 `config`（保留其余可写以便 git 操作）。
- **seccomp 拦 `AF_UNIX`**（`apply-seccomp`）—— 连 Unix socket 都限制。
- **凭据掩码**：把假文件 bind 到真文件之上，沙箱读到 sentinel 而不是真 key
  （`credential-mask-files.ts` / `credential-mask-env.ts` / `credential-aws-pairs.ts`）。
- **违规监控**：Linux 用 `USER_NOTIF` 观察过滤器把写意图路径通过 socket 流出来。

**它也踩了本仓踩过的同一个坑**（这条最重要，见 §3.2）：`--unshare-user` 下仓库属主 uid
未映射，git 会报 `detected dubious ownership`；它的解法是注入
`GIT_CONFIG_*` 的 `safe.directory`（`gitSafeDirectories`）。

### 2.4 ZCode：**没有 OS 级沙箱**，只有规则引擎

这条必须说清楚，因为容易被「沙箱」二字误导。

官方仓库 `zai-org/ZCode` 的 `apps/zcode-cli/packages/core/src/` 下：

- **`permission/`**：`service.ts`(22KB) + `broker.ts` + `rule-matching.ts` + `plan-mode-policy.ts`
  —— 一套 **`allow`/`ask`/`deny` 规则引擎**，带 `riskLevel`、`sideEffectScope`、
  `CollaborationMode`（含 `plan`）、`alwaysAsk`（不可被 hook 抹掉的确认）。
- **`tool/path-policy.ts`**：路径**规范化**，且注释明说**不**硬拦工作区外：

```ts
// Current release intentionally does not hard-block paths outside workspaceRoot.
// Cause: subagents may need to inspect user-requested sibling repos or external files
// before the filesystem permission adapter grows explicit ask/deny rules for them.
return resolvedPath
```

- 全文件搜索 `bwrap` / `seatbelt` / `sandbox-exec` / `seccomp` / `landlock` / `sandbox`：
  **`permission/service.ts` 里 0 次命中**。

**唯一的 OS 级沙箱在第三方桥 `william0wang/zcode-acp`**（非官方 CLI）：
macOS-only 的 Seatbelt，写白名单 = 工作区 + `~/.zcode*` + 系统 temp + 可再生缓存，
读与进程执行**保持开放**。它的自我定位也很诚实：

> This targets **accident prevention, not malice**：indirect escapes（agent 改过的 `.bashrc`、
> build script、git hook 由**你自己**在沙箱外运行）are out of scope.

**ZCode 值得抄的两点**：
1. **`alwaysAsk` 是结构化标记，不是字符串匹配** —— 下游 hook 靠这个布尔识别「不可抹掉的确认」，
   而不是去匹配 `ruleId`。本仓的 `toolDeny` 是纯减法，没有「强制确认」这一档。
2. **沙箱配置文件由沙箱外写** —— `zcode-acp` 里 agent **无法**编辑
   `<workspace>/.zcode/acp/sandbox.json`（沙箱拒写该目录），由桥在沙箱外代写。
   这堵死了「agent 自己给自己扩权」。

## 3. 本仓现状（实读，带 file:line）

### 3.1 已经做得比三家好的地方

1. **enforcement 承诺清单是显式的、可探测的**（`enforcement.ts:40` `BWRAP_PROMISES`）：
   「未经观测的承诺不算已交付」（`enforcement.ts:19`）—— 缺席的观测**计为 gap**。
   这比 DSH 的 `full/partial` 更细：它逐条列出**缺了哪一个效果**。
2. **`partial` + `fail` 的组合拒绝执行**（`provider.ts:154`）—— 不是「降级但继续」。
3. **环境变量 fail-closed**（`path-guard.ts:24`）：`CELESTEA_TOOL_ROOTS` 有错就拒绝**所有**
   带路径的调用，而不是静默忽略那一项。与 grants 的「忽略坏条目」形成**刻意的双标准**
   （env 是运维姿态，typo 必须响；grants 是会话级放宽，忽略即最小权限）。
4. **平台是参数不是常量**（`AGENT.md` §8）：`platformGates()` / `isAbsolutePath` / `joinPath`
   全是可注入缝，所以 win32 分支能在 Linux 上被单测。三家里只有本仓把这条写成了规范。

### 3.2 缺什么

| 缺口 | 证据 | 影响 |
|---|---|---|
| **没有读侧策略** | `BWRAP_PROMISES` 只有 `readonly_root`（整根只读），没有「洞」的概念 | 无法表达「读大部分，但拒 `~/.ssh`」—— 而这是 Claude 的核心能力 |
| **网络是开关不是策略** | `CELESTEA_SANDBOX_NET=0/1` + `CELESTEA_HTTP_ALLOW/DENY` | 没有「域名白名单 + 代理强制」；开了 net 就是全通 |
| **Windows 上 OS 隔离为零** | `probe.ts:136` 非 linux 直接 reject bwrap；`rlimit.ts:36` → `none` | 只剩路径守卫（`deployment.md` §4.1 已如实登记）|
| **没有强制拒绝清单** | 无 `DANGEROUS_FILES` 等价物 | agent 可写 `.bashrc` / `.gitconfig` / `.mcp.json` —— 与 ZCode 的「意外防护」定位同一水位 |
| **提权是任意放宽而非「宽一档」** | grants 的 `write_roots` 可指向任意绝对目录 | 缺 DSH 的 `WIDER_MODES` 约束 |
| **无凭据掩码** | 无对应实现 | 沙箱内进程能读到环境里的 key |
| **runner 链是硬编码二选一** | `provider.ts:120` | 加 macOS/Windows runner 要改分支，不是加数据 |

### 3.3 与「开放所有权限」的关系

本轮会话把生产 unit 改成了 `User=root` + `CELESTEA_SANDBOX_BWRAP=/nonexistent/bwrap`，
即**主动走 userspace 降级**。这不是缺陷，是**配置选择**，但它意味着：

- 上面 §3.2 的缺口**在当前部署下全部不设防**（连 `readonly_root` 都没有了）。
- `enforcement` 会如实报 `partial`（`userspaceEnforcement` 返回
  `["no_os_isolation"]` 或 `["no_os_isolation", "rlimits"]`，`enforcement.ts:138`）。
- **审计含义**：任何「本仓有沙箱」的表述，在当前部署下都指 **Linux + bwrap 路径存在**，
  而不是**正在生效**。

## 4. 建议的演进路线（按性价比排序）

### P0 · 强制拒绝清单（抄 Claude，成本最低，收益最直接）

加一份**不可被 preset 放宽**的写拒绝清单：`.bashrc` `.bash_profile` `.zshrc` `.profile`
`.gitconfig` `.gitmodules` `.mcp.json` `.ripgreprc`，目录 `.vscode` `.idea` `.claude/commands`。
**理由**：这些文件是「agent 写一次、用户下次自己执行」的执行面 —— 正是 ZCode 自己承认
超出范围的攻击面，而它**不需要任何新机制**：在 `bwrap-argv.ts` 里加 `--ro-bind /dev/null <path>`
或 `--tmpfs` 即可，路径守卫里加一条 deny。

### P1 · 读侧「洞」（抄 Claude 的 deny-then-allow）

把 `BWRAP_PROMISES` 的 `readonly_root` 扩展成「整根只读 + `denyRead` 打洞 + `allowRead` 回填」。
本仓已有 `allPaths`（`engine-grants.ts:209`）在做「根」的替换，改造点集中。

### P2 · 网络从开关变策略（抄 Claude 的代理模型）

现成的起点是 `CELESTEA_HTTP_ALLOW/DENY`（已有策略对象，见 `httpOptions`）。
差距是：现在是**应用层**过滤，不是**内核强制** —— 非 HTTP 流量（SSH、裸 TCP）绕得过去。
完整抄 Claude 需要 `--unshare-net` + Unix socket 代理桥，是**大工程**，建议只做
「HTTP 走代理 + 文档写明裸 TCP 不受控」。

### P3 · runner 链数据化（抄 DSH 的 seam）

把 `provider.ts:120` 的二选一改成候选链 + 功能探测，让 `windows-acl` 这类
新 runner 是**加数据**而不是**改分支**。这条同时是 §3.2 里 Windows 缺口的**前置条件**。

### 不建议抄的

- **ZCode 的「不硬拦工作区外」**：它的理由（subagent 要读兄弟仓）在本仓由
  `CELESTEA_TOOL_ROOTS`（多读根）已更好地解决 —— 显式声明优于默认放开。
- **Claude 的凭据掩码**：实现复杂度高（MITM CA、sentinel、AWS SigV4 配对），
  本仓的部署姿态是「单用户自己的机器」，性价比低。
- **DSH 的 `windows-acl` 受限令牌**：设计优秀（见其 README 的边界清单），但
  **ACE/label 是常驻的、`icacls` 清不掉**，且 Low 标签会超出 DSH 生命周期
  —— 引入前需要先接受这些副作用。

## 5. 验证方式（若落地）

- **强制拒绝清单**：变异负控制 —— 去掉一条 deny，断言「写 `.bashrc` 被拒」变红。
- **读侧洞**：`denyRead: ~/.ssh` + `allowRead: .` 后，断言 `cat ~/.ssh/id_rsa` 被拒而
  `cat ./README.md` 通过。
- **enforcement 诚实性**：新增 runner 必须让 `BWRAP_PROMISES` 逐条有观测，
  否则 `partial` —— 这是既有门禁（`enforcement.ts:19`），不要绕过。

## 6. 来源

| 系统 | 来源 | 类型 |
|---|---|---|
| DSH | `@deepseek-ai/dsh-sandbox` / `dsh-sandbox-local` / `dsh-sandbox-windows-acl` 的 `lib/types/*.d.ts` 与 README | 实读（本机安装）|
| Claude Code | [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) 的 README + `src/sandbox/*.ts` | 实读（GitHub 源码）|
| ZCode | [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 `apps/zcode-cli/packages/core/src/permission/*`、`tool/path-policy.ts` | 实读（GitHub 源码）|
| ZCode（第三方桥）| [william0wang/zcode-acp](https://github.com/william0wang/zcode-acp) 的 `docs/SANDBOX.md` | 实读（文档）|
| 本仓 | `packages/tools/src/sandbox/`、`packages/tools/src/guard/`、`apps/studio/src/runtime/` | 实读（本仓）|

## 7. 更正与实测（W1523）

**上一版这一节写着「Windows 真机 sshd 不可达，三者都没有实测」—— 那是错的，已作废。**

当时的失败是我的 ssh 命令**漏了 `-i` 私钥**（`/root/.dsh-win/id_ed25519`），
不是对方 sshd 异常。把「我的命令写错了」归因成「对方服务坏了」，并据此写进提交的文档 ——
这正是 `pitfalls.md` 记的那类错误：**没有区分「实读」与「实测」就下结论**。

补测后，Windows 通路与 `windows-acl` 的前提**全部实测通过**：

| 前提 | 实测结果 |
|---|---|
| SSH 通路 | ✅ `ssh -i /root/.dsh-win/id_ed25519 -p 2222` 通（Win11 家庭版 / 非管理员）|
| `CreateRestrictedToken` | ✅ `True`（非管理员账户也能创建）|
| Low 完整性标签（SACL）| ✅ `SetNamedSecurityInfo = 0`（owner + FullControl 即可，**不需要** `SeSecurityPrivilege`）|
| DACL 可写 | ✅ `Set-Acl` OK |

**这台机器已承担 Windows CI 职责**：clone 公开仓 → `pnpm install --frozen-lockfile`（4.3s，
store 热）→ `pnpm check`。首跑即抓到 `w1516-cpu-follows-wallclock.test.ts` 的固定 sleep
flake（见 §8），修复后 Windows 全量门禁 `EXIT=0`（52s）。

仍未实测的只剩：**Claude 的 Windows WFP 栅栏**（那需要装 `srt` 并建 `srt-sandbox` 本地账户，
本机没有）。
## 8. Windows CI 首跑抓到的真实缺陷（W1523）

Windows 门禁第一次跑就红了，红在**本仓自己的测试**上：

```
FAIL packages/tools/src/run-code/w1516-cpu-follows-wallclock.test.ts
TypeError: Cannot read properties of undefined (reading 'child')
  at w1516-cpu-follows-wallclock.test.ts:124:24
     sandbox.spawns[0]!.child.kill();
```

**根因**：测试用 `await new Promise(r => setTimeout(r, 20))` 等 broker 走到 `sandbox.spawn`。
固定 sleep 是在**猜**另一个任务需要多久 —— 28 核 Linux 上 20ms 够，Windows CI 上不够，
于是 `spawns[0]` 还不存在。

这与 `AGENT.md` §6 记录的 `tests/w795-optimistic-grants.test.ts` flake 是**同一类错误**，
处方也一样：**等条件本身成立，而不是等一个时长**。

```ts
await vi.waitFor(() => {
  expect(sandbox.spawns.length, "broker must reach sandbox.spawn").toBeGreaterThan(0);
}, { timeout: 5_000 });
sandbox.spawns[0]!.child.kill();
```

**验证**：变异负控制（把阈值改成 99，条件永不成立）⇒ 断言红
（`expected 1 to be greater than 99`）；还原 ⇒ 7/7 绿。Windows 上从 1 failed 变 **7/7 passed**，
随后全量 `pnpm check` **EXIT=0**。

**这条的价值**：它证明 Windows CI 不是装饰 —— 一个在 Linux 上永远绿、在 4 核/慢机器上
必现的 flake，被它当场抓住。

