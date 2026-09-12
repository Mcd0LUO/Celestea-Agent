# 特性设计 · 提权通道（前端点击按钮授予会话权限）

> 状态：**已实现**（2026-09-11 核实）。落地见 `apps/studio/src/store/grants-service.ts`、`apps/studio/src/handlers/grants.ts`、前端 `frontend/src/ui/grants.ts`。
> ⚠️ **残余风险（2026-09-11 架构师实测）**：§5.5 第 2 层「同源证据」依赖 `Sec-Fetch-*` 请求头，可被同主机 HTTP 客户端伪造，且 Studio API 在回环端口无鉴权 —— 故「必须人工点击」对同主机调用者**不成立**。本通道当前定位为**运维/UX 控制**（可见性、可撤销、审计、最小权限默认），**不是**对恶意/被注入模型的硬安全边界；硬边界需给 grants 端点加模型拿不到的凭据。
> 依赖：`feature-session-independence.md`——**会话级授权的前提是"每会话独立实例"**，因为安全边界（guard 链、沙箱、SSRF 策略）都在 compose 时构造，只有一个会话一个实例，授权才能"只作用于该会话"且"下一轮生效"。
> 一句话目标：默认最小权限；用户在**前端点按钮**为**当前会话**临时放宽某项能力；随时可撤销；全程可审计；**永不可被模型自己触发**。

---

## 0. 结论速览

| # | 设计决定 | 落点 |
|---|---|---|
| G1 | **会话级授权**，落盘 `<session dir>/grants.json`（与 `session.json` 同级，原子写，缺失/损坏 = 无授权） | 新增 `apps/studio/src/store/grants.ts` |
| G2 | **6 项能力**：`network`、`read_roots`、`write_roots`、`net_hosts`、`tool_extra`、`unsandboxed`；每项带 `expires_at` / `uses_left` | 见 §2 |
| G3 | **只增不减**：grants 只能**放宽**现有策略（加 roots、共享网络、扩 allow），**永不能**关闭 guard、缩小白名单、覆盖 SSRF deny、关 rlimits/seccomp | 见 §5.6 不可绕过清单 |
| G4 | 生效点 = **每会话实例 compose 时**读该会话 grants；授予/撤销 → bump 该会话 epoch → **下一轮生效**（轮内边界不变） | `apps/studio/src/runtime/engine-plugins.ts:51-69`、`packages/tools/src/plugin.ts:52-67` |
| G5 | **fail-closed**：解析失败/未知 version/类型错 → 视为空授予集 + 告警；非法 roots（不存在/非目录/是 `/`）→ **忽略该条**（回到最小权限）+ 审计 | 见 §4.3 |
| G6 | **提权必须人工点击**：`POST` 需要一次性 `confirm_token`（60s、绑定 session+cap+scope 哈希、用后即焚）；`unsandboxed` **不能在同一轮内使用**；授予端点不接受模型提供的任何文案 | 见 §5.5 |
| G7 | **审计双写**：本地 append-only `<data dir>/grants-audit.jsonl` + best-effort 平台审计；写失败如实记，不静默 | 见 §4.4 |
| G8 | **凭据零容忍**：白名单 schema + 落盘前 redact + 已知密钥拒绝写入 | 见 §5.4 |
| G9 | 新增 **4 个** method+path（`GET/POST/DELETE /api/sessions/{id}/grants` + `GET .../grants/confirm-token`）→ 契约端点 39 → **43** | 见 §6.5 |

---

## 1. 现状：今天的安全边界

现状**没有任何 grant/permission 机制**。安全完全由三组**进程级**策略承担，且在 **compose 时读一次 env**：

| 层 | 现状策略 | 位置 | 作用范围 |
|---|---|---|---|
| 路径白名单（ToolGuard） | workspace（`CELESTEA_TOOL_WORKDIR`，默认 cwd）是**唯一可写根**；`CELESTEA_TOOL_ROOTS` 是额外**只读**根；声明了 roots 但某一项不可用 → **fail-closed 拒绝一切带 path 的调用**（`tool_roots_invalid`） | `packages/tools/src/guard/path-guard.ts:50-119` | 只仲裁 `read_file`/`list_dir`（读）与 `write_file`（写）的 `path` 参数（`path-guard.ts:134-139`）；`run_shell`/`process_control`/`http_request` **不经过**它 |
| 沙箱（执行边界） | `bwrap`（探测可用时）否则 `userspace`；`CELESTEA_SANDBOX_FALLBACK=userspace`（默认降级）/ `=fail`（拒绝执行）；`CELESTEA_SANDBOX_NET=1` 保留宿主网络；`SHARE_TMP`/`SECCOMP`/`MASK`/`RLIMITS` 一组开关 | `packages/tools/src/sandbox/provider.ts:34-128`、`sandbox/config.ts:18-46` | `run_shell`（前台 + 后台）与 `process_control` 拉起的子进程 |
| SSRF | `CELESTEA_HTTP_ALLOW` / `CELESTEA_HTTP_DENY`（IP/CIDR，逗号分隔）。**两者都未设 = 策略不生效，全部放行**（以 `active:false` 显式暴露）；设了则目标与每个重定向跳的**每个解析 IP** 都要过；deny 恒优先；解析失败 → fail-closed 全拒 | `packages/tools/src/http/ssrf.ts:1-20` | `http_request` |

**结构性缺口（本设计要补的三点）**：

1. **粒度只有进程级**：`PathGuard.fromEnv` / `selectSandbox` / `HttpTargetPolicy.fromEnv` 都在 compose 时一次性构造（`packages/tools/src/plugin.ts:52-67`），改一次影响全部会话——没有"只给这个会话"的手段。
2. **没有临时性**：env 是部署姿态，改它要重启；用户无法"就这一次"放宽。
3. **没有撤销与审计**：放宽（比如直接 `CELESTEA_TOOL_ROOTS=/`）是不可审计的、永久的运维动作。

> 设计 1 已经提供了前提：**每会话一个 runtime 实例**，所以"compose 时按会话组装安全边界"变成自然落点（G4）。反过来，若不做设计 1，本设计只能退化为"进程级提权"——那等于没有会话隔离，**不建议**。

---

## 2. 权限模型

### 2.1 落盘位置与形状

**位置**：`<session dir>/grants.json`（`<ws>/<session>/grants.json`，与 `session.json` 同级）。
**理由**：会话自带的权限属于该会话；会话目录被归档/删除/回收（trash）时授权随之消失，不需要额外的生命周期管理。（备选：集中在 `<data dir>/grants/<ws>/<session>.json`——便于整体审计与备份，但会让"删除会话"漏删授权。选前者。）

```jsonc
{
  "version": 1,
  "session": "ws1/cli-main",          // 自述，读取时与目录不符即忽略整份（防复制粘贴串台）
  "updated_at": 1760000000,            // unix 秒
  "grants": [
    {
      "id": "g-7f3a2c9d",             // 随机 8 hex，撤销与审计的稳定引用
      "cap": "write_roots",
      "scope": { "roots": ["/srv/data/out"] },
      "granted_at": 1760000000,
      "granted_by": "ui:celestea",     // 只记来源类型与主体，不记 IP/UA 之外的东西
      "expires_at": 1760003600,        // null = 不过期
      "uses_left": null,               // null = 不限；1 = 一次性
      "note": ""
    }
  ]
}
```

- **原子写**：复用 `apps/studio/src/store/fs-json.ts` 的 `<path>.tmp` → rename 模式，模式 `0600`（权限数据虽不含凭据，但仍是敏感面）。
- **缺失或损坏 = 没有任何授予**（不是"忽略错误继续"）——见 §4.3 第 1 条。
- 文件**不含**任何凭据（§5.4）。

### 2.2 能力清单（v1）

| `cap` | `scope` | 语义 | 默认 | 危险度 |
|---|---|---|---|---|
| `network` | `{}` | 允许本会话 `run_shell`/`process_control` 拉起的子进程**保留宿主网络**（等价 `CELESTEA_SANDBOX_NET=1`） | 关 | **高** |
| `read_roots` | `{roots: string[]}` | 追加**只读**根（等价扩展 `CELESTEA_TOOL_ROOTS`） | `[]` | 中 |
| `write_roots` | `{roots: string[]}` | 追加**可写**根（workspace 之外也能写） | `[]` | **高** |
| `net_hosts` | `{hosts: string[]}` | 放宽 `http_request` 的目标策略：把列出的主机/IP 段**并入 allow**（并集放宽，永不收窄；且仅在进程级站点策略已启用时才生效，见下注 2 / §6.1） | `[]` | 中 |
| `tool_extra` | `{tools: string[]}` | 启用**默认未挂载的额外工具**（为将来的 browser/net 工具预留；**不是**用来放行被 guard 拒绝的工具） | `[]` | 中 |
| `unsandboxed` | `{}` | 允许在**无 OS 隔离**（`userspace`）下执行，即使 provider 策略是 `fail` | 关 | **最高** |

**明确说明三点**：

1. `network` 在 v1 是**布尔**（全有或全无）。原因：`bwrap --share-net` 是命名空间级开关，无法按 host 过滤；真正的 host 级网络控制需要 v2（netns + 用户态 DNS/proxy）。想按站点控制网络请用 `net_hosts`（只约束 `http_request`，而 `http_request` 是唯一"按 URL"的出网通道）。
2. `net_hosts` 与进程级策略的关系：**它是并集放宽，不是白名单**。进程级 `CELESTEA_HTTP_ALLOW` / `CELESTEA_HTTP_DENY` **两者都未设**时策略是 inactive（全放行）——此时 `net_hosts` **不会**把策略收紧成白名单（收紧不是 grants 的职责），而且**它自己也完全不生效**：清单被并进一个不被使用的策略里，会话可访问的范围一个字节都没变。进程级 `DENY` 恒优先，grants 无法覆盖。
   - 换言之：`net_hosts` 的真实语义是"把下列站点加入放行清单"，**不是**"只允许访问下列站点"；在未配置站点策略的部署下它等于空操作。
   - 这个部署事实由 `GET /api/sessions/{id}/grants` 如实报告：结构化字段 `net_hosts_effective`（false = 会话确实带着清单，但本部署会整份忽略它）+ `warnings` 里一条可读条目（`net_hosts_ineffective: …`）。判定复用引擎挂载工具时的同一条构造路径（`HttpTargetPolicy.fromEnv` → `netHostsIneffective`），不另写一套判断；权限面板在 `net_hosts` 行标「当前部署下不生效」。
3. `unsandboxed` 建议**默认在 UI 中隐藏**，需运维设 `CELESTEA_GRANTS_ALLOW_UNSANDBOXED=1` 才出现（§8 开放问题）。

### 2.3 有效期与一次性

- `expires_at`：绝对 unix 秒；授予时由 `ttl_sec` 换算。**每种 cap 有 TTL 上限**（服务端强制，前端只做提示）：

| cap | TTL 上限 | 说明 |
|---|---|---|
| `network` | 3600s | 1 小时 |
| `write_roots` / `read_roots` / `net_hosts` / `tool_extra` | 86400s | 24 小时 |
| `unsandboxed` | **900s** | 15 分钟，且**强制** `uses_left: 1` |

- `uses_left`：`null` = 不限；`1` = 一次性（消费后立即从文件移除并 bump epoch）。
- **过期判定在读取时**（`now >= expires_at` → 该条视为不存在），另有一个惰性 GC：下一次写盘时顺手剔除已过期条目。**不依赖定时器**（进程可能没有后台 tick）。
- 默认 TTL 建议：交互 UI 授予时预填 `1800`（30 分钟），用户可改（受上限约束）。

### 2.4 为什么不是全局/工作区级

- **全局**：与"每个会话都是独立的"直接冲突。
- **工作区级**：会让"同一工作区里新开的会话自动继承提权"——违反最小权限，且用户的心智模型是"我刚刚给**这个**会话放权"。
- 如果确实需要"该工作区新会话默认带某项只读授权"，只能作为**默认值模板** `<data dir>/grants-defaults.json`，且（a）模板自身必须有 `expires_at`，（b）UI 必须在新建会话时**明示**"该工作区的新会话将自动获得：读取 /srv/shared（至 HH:MM）"，（c）模板不适用于 `unsandboxed`。v1 不实现模板，仅登记为 v2 方向。

---

## 3. UI

### 3.1 入口位置

**状态栏右侧**（`frontend/src/statusline.ts` 里 `#slStop` 一带），新增一个**盾牌图标按钮** `#slGrant`：

| 状态 | 外观 | tooltip |
|---|---|---|
| 未授予 | 灰色空心盾 | `本会话权限：默认（仅工作区，无网络）` |
| 已授予 | 橙色实心盾 + 角标数字（生效条数） | `本会话已放宽 N 项权限 · 点击查看` |
| 即将过期（<2min） | 橙盾 + 小圆点 | `本会话有权限即将失效 · 点击查看` |

**不放在输入栏**：输入栏是"这一条消息"的动作区，权限是"这个会话"的长期状态；状态栏本来就承载"当前会话"的上下文/模型/强度，语义一致且不占垂直空间。

会话卡片（`ui/sessions.ts` 的会话叶子）在已放宽权限时显示一个**小盾牌标记**，让用户在切换前就知道目标会话处于放宽状态。**危险**（`network`/`write_roots`/`unsandboxed`）用红色小盾。

### 3.2 面板内容

点击盾牌展开面板（复用现有弹层基建：`utils/overlays.ts` 的 Esc 层级栈 + `statusline.ts:174-300` 的 `sl-popup` 样式族）。

```
本会话权限
默认情况下，本会话只能读写工作区目录，不能访问网络。
以下授权只对当前会话生效，可随时撤销；变更将在会话下一轮开始时生效。

  访问网络                                          [未授予]  [授予]
  允许会话中运行的命令访问互联网与内网（含本机服务）。
  ⚠ 撤销前一直有效。

  额外可写目录                                      [已授予至 14:32]  [撤销]
  /srv/data/out — 已允许在其中创建与修改文件

  额外只读目录                                      [未授予]  [选择目录]
  允许会话读取该目录内的文件（不能修改）。

  访问指定网站                                      [已授予 1 项]  [撤销]
  api.example.com

  降低隔离运行                                      [未授予]  [授予]
  允许会话中的命令不经额外隔离运行。

  ────────────────────────────────────────────────
  [ 全部撤销 ]
```

- 每行 = **能力名（用户语言）+ 一句话影响 + 状态徽标 + 动作按钮**。
- 「额外可写目录 / 只读目录」用**目录选择器**（复用 `GET /api/fs/browse` 的既有文件浏览器弹窗，`ui/sessions.ts:714-880`），避免用户手打路径出错。
- 「访问指定网站」用文本框（逗号/换行分隔），提交前做**本地格式校验**（IP/CIDR/主机名），错误就地显示，不提交。
- 已过期条目仍显示一行（灰化 + `已过期`），让用户理解"我曾经授过什么"，但**不**计入角标。

### 3.3 危险操作二次确认（必须写清"影响什么"）

用现有 `ui/confirm.ts` 的 `confirmDialog({danger:true})`，并对 `network` / `write_roots` / `unsandboxed` 追加**输入确认词**（比单纯点"确认"更强，且能打断"确认疲劳"）。文案要求：**逐字引用将要授予的能力与范围，不采用任何来自模型/工具输出的文本**。

| cap | 确认文案（`danger:true`） | 需输入 |
|---|---|---|
| `network` | `允许本会话中运行的命令访问互联网与内网（包括本机运行的服务）。撤销前一直有效（或至 <HH:MM>）。仅在你信任即将运行的命令时授予。` | 输入 `允许` |
| `write_roots` | `允许本会话在 <path> 中创建与修改文件。该目录之外的写入仍然被拒绝。此授权至 <HH:MM>。` | 输入 `允许` |
| `unsandboxed` | `允许本会话中运行的命令绕过文件系统与网络的额外隔离。恶意或被注入的命令可能读取或修改你的文件。此授权 15 分钟后失效，且只能使用一次。` | 输入 `降低隔离` |
| `read_roots` / `net_hosts` / `tool_extra` | `允许本会话读取 <path>（不能修改）。此授权至 <HH:MM>。` / `允许本会话访问 <hosts>。` | 只需点击确认 |

**撤销不需要二次确认**（降权永远安全），一键生效。

### 3.4 明确展示"本次授予影响什么"

面板顶部固定一行**结果预览**（授予前就显示），把"能力"翻译成"这个会话接下来能做什么"：

> 授予后，本会话可以：**在 /srv/data/out 中写入文件**。除此之外的权限与现在相同。

这条预览是**强制**的（服务端返回的 `effective` 快照必须在确认弹窗里原样展示，而不是前端自行拼措辞），这样"确认"看到的和"生效"的是同一个东西。

### 3.5 状态反馈

- 授予/撤销成功 → 状态栏闪一条 `已放宽：访问网络（至 14:32）` / `已撤销：访问网络`（复用 `flashStatus`，`ui/statusbar.ts:73-82`）。
- 失败 → 状态栏错误提示，用**用户语言**（与《UI 技术文案清单》口径一致，不出现端点/HTTP 码）。
- 生效时机必须在 UI 里说清：`变更将在会话下一轮开始时生效`（因为轮内边界固定，见 §4.2）。

---

## 4. 执行点

### 4.1 组装点（唯一）

`engineTools()`（`apps/studio/src/runtime/engine-plugins.ts:51-69`）→ `assembleTools()`（`packages/tools/src/plugin.ts:52-67`）。每会话实例 compose 时，宿主把该会话的有效授权集注入：

```ts
// apps/studio/src/runtime/engine-grants.ts（新增）
export interface EffectiveGrants {
  network: boolean;
  readRoots: readonly string[];    // 追加到 env roots 之后
  writeRoots: readonly string[];   // 追加到 workspace 之后
  netHosts: readonly string[];
  toolExtra: readonly string[];
  unsandboxed: boolean;
  /** 审计与 UI 展示用：每条生效授权的来源。 */
  sources: ReadonlyArray<{ cap: string; grantId: string; expiresAt: number | null }>;
}

/** 读取并校验，返回"只能放宽"的有效集；任何问题都不抛，只降级 + 上报。 */
export function effectiveGrantsOf(sessionDir: string | null, env: NodeJS.ProcessEnv, now: number): {
  grants: EffectiveGrants;
  warnings: string[];
};
```

改造三处构造调用（**都是"增量"而非"替换"**）：

| 现状 | 目标 |
|---|---|
| `PathGuardPolicy` 只有 `workspace` + `readRoots`，`checkWrite` 硬编码只允许 workspace（`path-guard.ts:104-111`） | 增加 `writeRoots` 字段（`[workspace, ...grants.writeRoots]`）；`checkWrite` 改为"在任一可写根内"。`readRoots = [workspace, ...envRoots, ...grants.readRoots]` |
| `bwrapOptionsFromEnv(env)` 只读 env（`provider.ts:107-114`） | `shareNet = envFlag(env[ENV_SANDBOX_NET]) \|\| grants.network`；`fallbackMode` 在 `grants.unsandboxed` 生效且 env 为 `fail` 时降级为 `userspace`（**并记录一条 `degraded_by_grant` 审计**） |
| `HttpTargetPolicy.fromEnv(env)`（`http-request.ts:36`） | allow 列表 = env allow ∪ `grants.netHosts`；**deny 不变、恒优先**；当 env 两者都未设（策略 inactive）且 grants 有 hosts 时，仍维持 inactive（放宽不收紧），但在审计里记一次 `net_hosts_ineffective`；**同一个判定**（`netHostsEffective`，`engine-grants.ts`）也被 `GET /api/sessions/{id}/grants` 用来报告 `net_hosts_effective`（§6.1）——一处判定，两处消费，不复制逻辑 |

### 4.2 生效时机

- 授予/撤销 → 写 `grants.json` → **bump 该会话实例的 `profileEpoch`**（复用设计 1 的失效机制，`SessionRuntimeRegistry.invalidateAll()` 的单会话版本）→ 该会话**下一个 turn 开始时**重建实例并重新组装安全边界。
- **轮内不改边界**：一个 turn 内的所有工具调用共享同一套边界。这既避免了"同一轮里前后两次 `run_shell` 隔离级别不同"的诡异状态，也是 §5.5 里"`unsandboxed` 不能同轮使用"的实现基础。
- `POST /api/turn` 的自动 `ensure` 路径同样先读 grants 再 compose（所以"新会话没有实例时直接发消息"也能拿到已授予的权限）。

### 4.3 fail-closed 规则（逐条）

1. **文件层**：`grants.json` 不存在 → 空授予集（正常）。存在但解析失败 / `version` 未知 / `session` 自述与目录不符 / `grants` 非数组 → **整份视为空授予集**，并在审计与 UI 上告警（`grants_unreadable`）。**绝不"修复"或"猜测"**（与 `session.json` 的容错策略一致：`session-meta.ts:20-30`）。
2. **条目层**：单条 `cap` 未知 / `scope` 类型错 → **忽略该条** + 审计 + UI 提示。
3. **路径类 scope 的校验**（`read_roots`/`write_roots`）——必须**全部**满足才采纳该条，任一不满足则忽略该条：
   - 必须是**绝对路径**；
   - 必须 `realpath` 成功（存在）且是**目录**；
   - **不得是 `/`**；
   - **不得**等于或包含 `<data dir>`（`dirname(workspacesFile)`）——防"授予写权限后改 `providers.json`/`workspaces.json` 实现持久提权；
   - **不得**是 `$HOME` 本身（允许 `$HOME/xxx` 子目录，但直接给 `$HOME` 等价于给 `~/.ssh`、`~/.aws`、`~/.gnupg`——与沙箱"环境变量白名单里刻意不含 `HOME`"的既有立场一致，`sandbox/config.ts:1-9`）；
   - `write_roots` 额外：**不得**包含任何已在 `readRoots` 中的根（语义冲突：一个根不能既只读又可写——直接忽略该条并告警，而不是"写胜出"）。
4. **根路径的"只增不减"**：`writeRoots` 永远包含 workspace；grants **不能**移除 workspace，也**不能**把某个根从可写降为只读（那是另一个动作，不在 grants 范围内）。
5. **沙箱类**：`unsandboxed` 只在 `env=userspace`（本就无隔离）或 `env=fail`（本会拒绝）时有意义；在 `bwrap` 可用时**忽略该条**（`bwrap` 下隔离已经生效，用户要的是"更少隔离"，而 grants 的哲学是"只在策略拒绝时提供显式出口"）。
6. **HTTP 类**：`net_hosts` 中无法解析的条目 → 忽略该条（**不是** fail-closed 全拒）——理由见下。
7. **为什么"路径/host 非法 → 忽略该条"而不是"全拒"**：进程级 `CELESTEA_TOOL_ROOTS` 的 fail-closed（`path-guard.ts:15-21`）是**正确的**，因为那是"操作员声明的运行环境"，一个拼写错误会让整个部署姿态不明。会话级 grants 完全相反——它是**额外的放宽**，"忽略即回到最小权限"，本身就是安全的一侧；而"全拒"会把用户锁在外面，反而**诱导**他去用 `CELESTEA_TOOL_GUARD=0` 这类更危险的逃生门。**两者策略相反是有意的，必须写进代码注释免得后人"统一"它们。**

### 4.4 审计

每次**授予 / 撤销 / 使用 / 过期 / 拒绝**都写审计：

- **本地通道（权威）**：`<data dir>/grants-audit.jsonl`，append-only，一行一 JSON：
  ```jsonc
  {"ts":1760000000,"event":"grant","session":"ws1/cli-main","grant_id":"g-7f3a2c9d",
   "cap":"write_roots","scope":{"roots":["/srv/data/out"]},"actor":"ui:celestea",
   "expires_at":1760003600,"uses_left":null,"effective_after":{...}}
  ```
  `event` ∈ `grant | revoke | use | expire | deny | grants_unreadable | platform_audit_failed`。
  文件轮转：与平台审计一致的做法——超 16MB 轮转保留旧链（复用 LTS `ops/index.md` 的审计纪律口径）。
- **平台通道（best-effort）**：投递 `POST /api/audit {category, summary, detail}`（server-center，见 LTS `ops/index.md` 的"审计双通道"）。**失败不阻塞授予**，但必须在本地审计里补一条 `platform_audit_failed`——**写失败如实报，不静默**。
- **`use` 的采样**：
  - `network` / `write_roots` / `unsandboxed`：**每次实际使用**都记（分别由沙箱 spawn、guard 的 write 放行、降级 spawn 触发），因为它们直接改变进程的执行环境；
  - `read_roots` / `net_hosts` / `tool_extra`：每轮最多记一次（避免日志爆炸）；
  - 记 `use` 时**不记命令原文**（可能含凭据）——只记 `cap`、`grant_id`、`tool` 名、`pid` 与 `sandbox.provider`。
- **拒绝**：guard/沙箱/SSRF 因**未授予**而拒绝时，记 `deny` 并在 UI 上提示"如需允许，可在本会话权限中授予"（一次会话只提示一次，避免打断）。
- 审计**不可被 grants 关闭**（§5.6）。

---

## 5. 安全不变量

1. **默认最小权限**：没有 `grants.json` 时行为与今天逐字一致（workspace 可写、env roots 只读、网络隔离、SSRF 按 env）。grant 只能**放宽**，永不收紧、永不替代任何既有策略。
2. **授予只作用于该会话且可撤销**：写在该会话目录；撤销**下一轮生效**；撤销即从内存与磁盘移除（并 bump epoch）。撤销是幂等的（`{ok:true, revoked:[]}`）。
3. **所有授予/使用写审计**（§4.4，本地 + 平台 best-effort）。
4. **不得把 key/凭据写入 grants**：
   - `grants.json` 的 schema 是**字段白名单**（`version/session/updated_at/grants[].{id,cap,scope,granted_at,granted_by,expires_at,uses_left,note}`），未知字段**丢弃**（不是透传）；
   - `scope.roots`/`scope.hosts` 必须是路径或主机名，**显式拒绝**疑似凭据的值：匹配 `sk-`/`Bearer `/含 `\n`/长度 >200/命中 `packages/core/src/redact.ts` 的已知密钥集合（`collectKnownSecrets`）；
   - `note` 落盘前做 redact（同一个 `redact` 能力）；
   - 拒绝时返回 `400 invalid scope for cap '<x>': value looks like a credential`，且**不回显该值**（防回显进日志/UI）。
5. **防止提权被 prompt injection 触发（必须人工点击）**——这是本设计的核心不变量，用**四层**实现：
   1. **一次性确认令牌**：`POST`/`DELETE` 授予端点要求头 `X-Celestea-Grant-Confirm: <token>`。令牌由 `GET /api/sessions/{id}/grants/confirm-token?cap=&scope_hash=` 签发，**TTL 60s、绑定 (session, cap, scope_hash)、用后即焚**。令牌只经**浏览器 UI 交互路径**获取（见第 3 层）。
   2. **同源证据**：签发端点要求请求带 `Sec-Fetch-Site: same-origin`（或 `Sec-Fetch-Mode: cors` + 无 `Origin` 不匹配），否则 `403 grant confirmation is not available over this transport`。会话内的 `http_request` 工具即使能打到 `localhost`，也拿不到浏览器签发的令牌。
   3. **轮内边界固定**：`unsandboxed` **不能在同一 turn 内被使用**——授予后必须等到**下一轮**（§4.2 的"轮内不改边界"）。这直接切断"注入 → 当轮提权 → 当轮执行"的链条。
   4. **文案不可由模型提供**：UI 的确认文案、按钮标签、影响预览**逐字由前端常量 + 服务端 `effective` 快照决定**，绝不采用工具输出/模型文本中的任何字符串（否则模型可以伪造一个无害的"确认"按钮）。工具输出里出现的"请点允许"只作为**普通文本**显示在消息流里，与权限面板无任何数据通路。
   5. **反确认疲劳**：每会话**每分钟最多 3 次**授予请求（`429`），连续 3 次拒绝后冷却 5 分钟（`409` + 剩余秒数）。危险能力还需输入确认词（§3.3）。
6. **不可绕过清单**（grants 无法触及，实现时写成显式断言 + 单测）：
   | 不可绕过项 | 位置 |
   |---|---|
   | `CELESTEA_TOOL_GUARD=0` 的**挂载决策**（grants 不能挂载或卸载 guard 链） | `path-guard.ts:157-160` |
   | `checkRead` 的"必须落在某个 read root 内"（只能加根） | `path-guard.ts:91-101` |
   | `checkWrite` 的"必须落在某个可写根内"（只能加根；新根受 §4.3 第 3 条约束） | `path-guard.ts:104-111` |
   | SSRF 的 `deny` 列表（grants 只能扩 allow，deny 恒优先） | `http/ssrf.ts` |
   | 沙箱的 `RLIMITS` / `SECCOMP` / `MASK` / `SHARE_TMP` 开关（grants 不得关闭它们） | `sandbox/provider.ts:107-114` |
   | 子进程的环境变量白名单（grants **不能**注入 `HOME` 或任意 env；如确需 env，属于 v2 的独立能力 `extra_env`，且必须走 §5.4 的凭据校验） | `sandbox/config.ts:33-46` |
   | **worker 子会话不继承父会话 grants**（每会话独立；worker 的权限由它自己的会话文件决定） | 设计 1 §2.7 |
   | 审计写入（grants 不能关闭或改写审计） | §4.4 |
7. **可观测**：`GET /api/status` 增 `grants_active: string[]`（cap 名列表，不含路径细节）——让运维一眼看出"哪个会话正在放宽"。

---

## 6. API 契约

### 6.1 `GET /api/sessions/{id}/grants`

| 项 | 内容 |
|---|---|
| 请求 | 无 body。 |
| 200 响应 | `{ok:true, session:"<ws>/<sess>", grants:[{id,cap,scope,granted_at,granted_by,expires_at,uses_left,note,expired:bool}], effective:{network:bool, read_roots:[], write_roots:[], net_hosts:[], tool_extra:[], unsandboxed:bool}, max_ttl_sec:{<cap>:<n>}, unsandboxed_available:bool, net_hosts_effective:bool, warnings?:string[]}` |
| 404 | `{"ok":false,"error":"unknown session '<id>'"}` |
| 备注 | 无文件时返回 `grants: []` + `effective` = 默认值（**200，不是 404**） |
| W757 增量（additive，无破坏性） | `net_hosts_effective:boolean`：`effective.net_hosts` 为空 ⇒ `true`（没有可被丢弃的清单）；非空时由 `netHostsEffective(env, effective)` 判定，`false` = 本部署未设 `CELESTEA_HTTP_ALLOW`/`CELESTEA_HTTP_DENY`，该清单**整份不生效**。此时 `warnings` 追加一条 `net_hosts_ineffective: …`（与既有形如 `grants_unreadable: …` / `… — ignored` 的条目同列）。该字段只做**报告**：不改变授权结果、不改变 `ssrf.ts` 的并集语义、不触碰令牌/同源/限流/审计任何一环 |

### 6.2 `POST /api/sessions/{id}/grants`

| 项 | 内容 |
|---|---|
| 请求 | `{"cap":string, "scope"?:object, "ttl_sec"?:number, "uses_left"?:number\|null, "note"?:string}`，头 `X-Celestea-Grant-Confirm: <token>` |
| 200 响应 | `{ok:true, grant:{...}, effective:{...}}` |
| 400 | `invalid cap '<x>'` / `invalid scope for cap '<x>': <why>` / `ttl_sec exceeds the maximum for cap '<x>' (<n>)` / `value looks like a credential` |
| 403 | `grant confirmation required`（缺令牌 / 令牌过期 / 令牌与 (session,cap,scope) 不匹配） |
| 404 | `unknown session '<id>'` |
| 409 | `confirmation token already used` / `a grant request was just denied; retry in <n>s` |
| 429 | `too many grant requests; retry in <n>s` |
| 500 | `cannot persist grants: {e}` |
| 语义 | 同一 `cap` 已存在时 = **替换**（不是追加），保证"一个 cap 一个生效集"，避免语义叠加歧义 |

### 6.3 `DELETE /api/sessions/{id}/grants`

| 项 | 内容 |
|---|---|
| 请求 | `{"cap"?:string, "grant_id"?:string}`（都省略 = 全部撤销）。**不需要** confirm_token（降权永远安全） |
| 200 | `{ok:true, revoked:["g-…"], effective:{...}}`（无可撤销项时 `revoked:[]`，幂等） |
| 404 | `unknown session '<id>'` |
| 500 | `cannot persist grants: {e}` |

### 6.4 `GET /api/sessions/{id}/grants/confirm-token`

| 项 | 内容 |
|---|---|
| 请求 | query `?cap=<cap>&scope_hash=<sha256-hex>`（`scope_hash` 由 GET grants 的 `effective` 或前端规范序列化算出；服务端用同一序列化复核） |
| 200 | `{ok:true, token:"<opaque>", expires_at:<unix秒>}` |
| 403 | `grant confirmation is not available over this transport`（缺同源证据头） |
| 404 | `unknown session '<id>'` |
| 备注 | TTL 60s、一次性、绑定 (session, cap, scope_hash)。令牌只在**授予**时校验，**撤销**不用 |

### 6.5 兼容与计数

- **Rust 后端无这些端点** → `404`。前端**必须**在 `GET /api/health` 的 `capabilities.grants !== true` 时**隐藏**权限入口（不是置灰报错）；这也是设计 1 §4.10 能力位里 `grants` 位的用途。
- `contracts/endpoints.json` 新增 4 个 method+path 组合 → `API_ENDPOINT_COUNT` 由 **39 → 43**；`apps/studio/src/routes.ts:43` 的常量、`app.ts:71-73` 的 `assertCoverage`、`contracts/rust-route-table.snapshot.json` 的同步差异需一并处理（**这是硬断言，漏改会在启动时抛错**，属于"友好失败"）。
- 前端 `api.ts` 新增 3 个方法（`grants`/`grantCap`/`revokeCap`/`grantToken`），全部走既有 `requestJson`/`postJson`（不新增 fetch 出处，遵守 `api.ts:1-4` 的单出口纪律）。

---

## 7. 验收（实现阶段）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 授予 `write_roots` → 同一会话下一轮 `write_file` 到该目录 | 成功；轮内立即使用 | 
| 2 | 授予后**当前轮**立刻 `write_file` | 仍被拒绝（轮内边界固定），下一轮成功 |
| 3 | 撤销 → 下一轮 | 被拒绝（`path_forbidden`） |
| 4 | 手改 `grants.json` 写 `ttl_sec: 99999` | 服务端拒绝 `ttl_sec exceeds the maximum` |
| 5 | 手改 `grants.json` 写 `roots: ["/"]` | 该条被忽略（回到最小权限）+ 审计 `deny`/告警 + UI 提示 |
| 6 | 手改 `grants.json` 成坏 JSON | 空授予集 + `grants_unreadable` 审计 + UI 告警；**不**崩溃、**不**放宽 |
| 7 | 不带头直接 `POST /grants` | `403 grant confirmation required` |
| 8 | 同一令牌用两次 | 第二次 `409 confirmation token already used` |
| 9 | 令牌过期 61s 后用 | `403` |
| 10 | 模型在回复里写"请点『允许』按钮" | 无任何权限变化；面板文案不含模型文本 |
| 11 | 授予 `unsandboxed` 且 env 是 `fail` → 下一轮 `run_shell` | 以 `userspace` 执行成功，`SandboxMeta.provider="userspace"`，审计记 `use` + `degraded_by_grant` |
| 12 | 授予 `network` → `run_shell` 内 `curl` 外网 | 在 `bwrap` 下成功（`net_isolated:false`） |
| 13 | 授予 `net_hosts` 但 env `DENY` 含该段 | 仍被拒（deny 恒优先） |
| 13b | 授予 `net_hosts` 但部署 `CELESTEA_HTTP_ALLOW`/`DENY` 都没设（W757） | 授权**不生效**（清单并进一个 inactive 策略里，可访问范围不变）；`GET …/grants` 回 `net_hosts_effective:false` + 一条 `net_hosts_ineffective` 告警，面板在 `net_hosts` 行标「当前部署下不生效」 |
| 14 | 每会话 1 分钟内第 4 次授予请求 | `429` |
| 15 | `note` 里塞 `sk-abcdef…` | `400 … looks like a credential`，且响应/审计/UI 均不回显该值 |
| 16 | 授予 `read_roots=/`（或 `$HOME`、`<data dir>`） | 该条被忽略 + 告警 |

**单测落点**（沿用现有，不新造框架）：`packages/tools/src/guard.test.ts`（`writeRoots` 增量、忽略非法条、fail-closed 边界）、`packages/tools/src/sandbox/bwrap.test.ts`（`network` 与 `unsandboxed` 对 argv/fallback 的影响）、`apps/studio/src/app-domains.test.ts`（4 个端点 + 全部错误码 + 令牌一次性）、`apps/studio/src/grants-net-hosts.test.ts`（W757：`net_hosts_effective` 的判定与响应契约）、`packages/runtime/src/lifecycle.test.ts`（grant 变更 → bump epoch → 下一轮实例重建）。

---

## 8. 开放问题

1. **`unsandboxed` 是否应该存在**：最保守的选择是**不实现**（只保留 `network` + roots + hosts）。建议：实现但在 UI 默认隐藏，需运维设 `CELESTEA_GRANTS_ALLOW_UNSANDBOXED=1` 才出现，且强制 TTL ≤900s + 一次性 + 输入确认词。请产品/运维裁决。
2. **`network` 的 host 级粒度**需要 v2（bwrap netns + 用户态 DNS/proxy）。v1 只有布尔；按站点控制只能走 `net_hosts`（仅约束 `http_request`）。
3. **`extra_env` 能力**（给子进程注入指定 env，如 `HTTP_PROXY`）：一旦开放就是凭据外泄通道，需要独立设计（值必须是引用而非字面量，如 `from:env:NAME`）。v1 不做。
4. **工作区级默认模板** `<data dir>/grants-defaults.json`（§2.4）：v2 方向，需先在 UI 上有"新会话将自动获得"的明示。
5. **grants 与 `session.json` 是否合并**：**不建议**。`session.json` 的容错策略是"损坏即忽略"（`session-meta.ts:20-30`），grants 的容错策略必须更严（损坏即空 + 告警），两者的失败语义不同，合并会让它们互相污染。
6. **多标签页并发**：同一会话在两个 tab 各自点授予 → 后写覆盖先写（`grants.json` 是最后写者胜）。建议：`POST` 响应返回新 `updated_at`，前端在 `409`/冲突时提示"权限已被另一个窗口修改，请刷新"。v1 只用"最后写者胜 + 审计留痕"。
7. **审计通道**：`POST /api/audit` 属于跨服务调用（server-center），需要确认 Studio 到 server-center 的鉴权方式与网络可达性；不可达时退化为纯本地通道（已设计）。
