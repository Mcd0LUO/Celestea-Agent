# 部署与安全模型

> 状态：**当前**。本文覆盖生产部署（systemd + nginx）、隧道访问、以及**务必读一遍**的安全模型。
> 配置项见 `configuration.md`；登录门的实现见 `feature-studio-auth.md`。

---

## 1. 生产部署（systemd + nginx）

生产由 `scripts/run-studio-ts.sh` 拉起：它解析密钥、把数据指到 `/var/lib/celestea-agent`、
设好沙箱读根，最后 `exec pnpm --dir apps/studio start`。

```bash
sudo systemctl restart celestea-studio-ts
curl -s http://127.0.0.1:3777/api/health
```

> ⚠️ 若数据根用 `CELESTEA_HOME` 覆盖，**必须**在 systemd unit 里显式设置
> （例如 `Environment=CELESTEA_HOME=/var/lib/celestea-agent`），否则会落到 `~/.celestea`。

公网暴露建议：

- 进程只监听 `127.0.0.1`，由 nginx 反代 + Studio 自带登录门（`/login` + HMAC cookie）。
- SSE 需要 `proxy_buffering off`，否则事件会被缓冲。
- `POST /api/exec` 与 `GET /api/fs/list` 在应用内**没有**鉴权，安全完全交给 nginx 的 `auth_request`：
  没有登录门就等于把「以当前用户身份执行任意命令」暴露出去。

---

## 2. 走隧道访问（服务器上跑、本地看）

```bash
ssh -L 3777:localhost:3777 <server>
# 然后打开 http://localhost:3777
```

---

## 3. 从源码构建并启动（开发）

```bash
pnpm --dir apps/web run build          # 前端产物 -> apps/web/dist（后端从磁盘静态服务）
pnpm --filter @celestea/studio start   # 源码默认监听 127.0.0.1:3778
```

打开 <http://127.0.0.1:3778> 即可。

> 改了前端**不需要重启**：重新 `pnpm --dir apps/web run build` 后刷新页面即可
> （后端每次请求都从磁盘读 `dist`）。

开发流程与提交规范见 `AGENT.md`。

---

## 4. 安全模型（请务必读一遍）

- **默认档位是 `full-access`**：整盘可读写、允许联网、允许非沙箱执行。这是为了「自己机器上少点摩擦」，
  **不是**面向多租户的默认值。要收紧就设 `CELESTEA_PERMISSION_DEFAULT=write-read`（或 `read-only`）
  与 `CELESTEA_PERMISSION_MAX`——上限一旦设死，会话**不可能**越过它。
- **提权只能由人触发**：模型不能给自己加权限。界面上的提权是**一次性 grant**，有 TTL、可撤销、写入审计日志。
  `unsandboxed` 是「一次」语义（`uses_left=1`），不会变成长期放行。
- **沙箱是真实隔离**：`bwrap` 负责文件系统与网络命名空间，`prlimit` 负责 CPU/内存/文件数/输出上限。
  `CELESTEA_SANDBOX_FALLBACK=fail` 可以做到「没有 OS 隔离就拒绝执行」；默认 `userspace` 会**降级并说明**，不静默放行。
- **密钥只从文件/环境读，绝不写进会话日志**：导出黄金样本时有独立的脱敏与泄漏自检。
- **非环回绑定默认拒绝启动**（`celestea web --bind 0.0.0.0` 需要 token）：
  那不只是「开了个网页」，而是把命令执行面暴露出去。

### 4.1 Windows 上的运行与限制

Windows 上**能跑**（`.github/workflows/ci.yml` 有 `windows-latest` 的 `pnpm check`），
但「沙箱」退化为**权限档位 + 工具白名单**，**不要**把它当多租户隔离。

| 能力 | Linux | Windows | 影响 |
|---|---|---|---|
| OS 级隔离 | `bwrap` + `prlimit` | 无（走 userspace 降级） | 文件系统/网络命名空间隔离不存在；`CELESTEA_SANDBOX_FALLBACK=fail` 会直接拒绝执行 |
| 资源上限 | `prlimit` / `ulimit` / seccomp | 无（尽力而为，缺失记日志继续） | CPU / 内存 / 文件数 / 输出上限**不生效**，`cpu_exceeded` 不会触发 |
| 进程树回收 | 进程组信号 `kill(-pid)` | 无 POSIX 进程组 | 关闭浏览器/子进程要逐进程终止，残留风险更高 |
| 命令执行 shell | `/bin/sh -c` | gitbash > pwsh > cmd（都缺则结构化报错 + 安装提示） | 工具调用的命令行语义随 shell 变 |
| 数据根默认 | `~/.celestea` | `%USERPROFILE%\.celestea` | 也可用 `CELESTEA_HOME` 覆盖 |
| Playwright 浏览器缓存 | `~/.cache/ms-playwright` | `%LOCALAPPDATA%\ms-playwright` | 由 `playwrightCacheRoot()` 按平台解析；`PLAYWRIGHT_BROWSERS_PATH` 可覆盖 |
| 原子写（tmp+rename） | `rename(2)` 原子 | `MoveFileEx` 可能被占用句柄挡下（EPERM/EBUSY） | `renameWithRetry()` 短退避重试；仍失败按原有结构化错误上报 |
| 登录门（`htpasswd`） | 系统自带 | 需自行提供 `htpasswd` 二进制 | 缺失时校验失败即拒绝 |
| 服务托管 | systemd `celestea-studio-ts.service` | 无 systemd | 用 `celestea web` 或 `pnpm --filter @celestea/studio start`（要常驻可挂 Windows 服务/任务计划） |

**在 Windows 上从源码跑**：`pnpm install` → `pnpm --dir apps/web run build` → `pnpm --filter @celestea/studio start`
（默认 `127.0.0.1:3778`）。这台机器的路径 / 端口 / 装了哪些工具写在 `docs/AGENT.local.md`（不入库），不写进本文。
