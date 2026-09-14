> ⚠️ **已过时（仅存史）**：本文描述的是已退役的 Rust 后端 `celestea-studio.service`。生产现为 TypeScript 后端 `celestea-studio-ts.service`（127.0.0.1:3777）。退役与回滚见仓库根 `LEGACY-RUST-BACKEND.md`。

# Celestea Studio · 部署与运维

> 📦 历史文档（2026-09-11 归档）：描述的是已退役 Rust 后端 `celestea-studio.service` 的 systemd / nginx 部署（紧邻的原「已过时」提示仍然有效）。当前权威入口见 [/src/celestea_studio-ts/scripts/run-studio-ts.sh](/src/celestea_studio-ts/scripts/run-studio-ts.sh) 与 [/src/celestea_studio-ts/docs/README.md](/src/celestea_studio-ts/docs/README.md)。

> 目标机器：`ubuntu-mc-server`，服务运行用户 `celestea`（uid 1003），仓库 `/src/celestea_studio`。
> 本文所有内容都来自机器上的**实际配置**（systemd 单元、`scripts/run-studio.sh`、nginx 站点文件），不是设计稿。

---

## 1. 拓扑

```
浏览器
  ├─ http://127.0.0.1:3777        直连（本机 / ssh -L 3777:localhost:3777）
  └─ https://studio.celestea.top  → nginx(443, basic auth) → 127.0.0.1:3777
                                        （proxy_buffering off，SSE 流式透传）

celestea-studio.service (systemd, User=celestea)
  └─ scripts/run-studio.sh
       ├─ 从 /opt/dsh/.credentials.yaml 取 CELESTEA_API_KEY（sudo python3 + yaml）
       └─ exec ./target/release/celestea-studio   （WorkingDirectory=/src/celestea_studio）
```

- 进程只监听 **环回**（`127.0.0.1:3777`），外部访问一律经 nginx 或 ssh 隧道。
- 前端产物 `frontend/dist/` 由后端**从磁盘**静态服务，改前端只需 `pnpm build`，**不用重启**。
- 引擎在进程内（`celestea-runtime`），没有独立引擎服务要起。

---

## 2. systemd 单元

文件：`/etc/systemd/system/celestea-studio.service`

```ini
[Unit]
Description=Celestea Studio backend (axum + SSE)
After=network.target

[Service]
Type=simple
User=celestea
WorkingDirectory=/src/celestea_studio
Environment=CELESTEA_TOOL_ROOTS=/src/celestea_studio:/src/celestea_harness:/tmp
Environment=CELESTEA_SANDBOX_NET=0
ExecStart=/src/celestea_studio/scripts/run-studio.sh
Restart=always
RestartSec=3
StandardOutput=append:/tmp/celestea-studio.log
StandardError=append:/tmp/celestea-studio.log

[Install]
WantedBy=multi-user.target
```

要点：

- `Restart=always` + `RestartSec=3`：进程崩溃会自动拉起（但**不会**自动重编，改了代码必须自己 build + restart）。
- 日志**直接 append 到 `/tmp/celestea-studio.log`**（不是 journald）。`/tmp` 会被清理，长期留档需另行转存。
- `CELESTEA_TOOL_ROOTS=/src/celestea_studio:/src/celestea_harness:/tmp`：**引擎**工具（`read_file` / `list_dir` 等）的读取根白名单（`/src/celestea_harness/crates/tools/src/guard.rs:44-46`）。它**不**限制 Studio 的 `GET /api/fs/browse`（那个端点不受 roots 约束，见 `docs/pitfalls.md` 附表）。
- `CELESTEA_SANDBOX_NET=0`：保持引擎 shell 沙箱的默认"网络隔离"（`=1` 才恢复宿主网络）。
- 单元里**没有** `CELESTEA_PROVIDERS_FILE` / `CELESTEA_WORKSPACES_FILE` / `CELESTEA_PROMPTS_FILE`，所以它们取默认值：相对 `WorkingDirectory` 的 `providers.json` / `workspaces.json` / `prompts.json`。

### 2.1 启动脚本

文件：`scripts/run-studio.sh`（root:root 0755）

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /src/celestea_studio
CKEY=$(sudo python3 -c "import yaml;print(yaml.safe_load(open('/opt/dsh/.credentials.yaml'))['refs']['CELESTEA_API_KEY'])" 2>/dev/null || true)
if [ -z "$CKEY" ]; then
  echo "[run-studio] failed to resolve CELESTEA_API_KEY from /opt/dsh/.credentials.yaml" >&2
  exit 1
fi
export CELESTEA_API_KEY="$CKEY"
export CELESTEA_SESSION_DIR="${CELESTEA_SESSION_DIR:-/src/celestea_studio/sessions}"
exec ./target/release/celestea-studio
```

- key **只存在于进程环境**，不写文件、不打日志；本仓库与文档中**绝不出现明文 key**。
- `CELESTEA_SESSION_DIR` 在这里只是兜底；`main()` 启动时会用 `workspaces.json` 的 `active_session` 覆盖它（`src/main.rs:1219-1254`），所以"重启后仍在原会话"。
- 脚本用 `sudo` 读凭据（`celestea` 在本机有 `NOPASSWD: ALL`，例外只有 visudo/passwd/chage/su）。

---

## 3. nginx（公开站点）

站点文件：`/etc/nginx/sites-available/studio.celestea.top`（80 → 301 到 https）与 `/etc/nginx/sites-available/studio.celestea.top.ssl`（443）：

```nginx
server {
    listen 443 ssl;
    server_name studio.celestea.top;
    ssl_certificate     /etc/letsencrypt/live/studio.celestea.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/studio.celestea.top/privkey.pem;

    auth_basic "Celestea Studio";
    auth_basic_user_file /etc/nginx/.htpasswd-studio;      # 基本认证

    location / {
        proxy_pass http://127.0.0.1:3777;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # ← SSE 必须：禁用缓冲
        proxy_cache off;
        proxy_read_timeout 3600s;     # ← 长连接/长轮次
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
```

- **`proxy_buffering off` + 长 read timeout 是 SSE 能实时工作的前提**；改 nginx 时别把这两条去掉。
- 证书是 Let's Encrypt，续期配置在 `/etc/letsencrypt/renewal/studio.celestea.top.conf`。
- 访问需要 basic auth（用户名/口令不在本文档，也不在仓库里）。
- 从**服务器本机**直接 `curl https://studio.celestea.top` 可能因出口/回环路径失败（实测连接被拒），用 `curl -k -H 'Host: studio.celestea.top' https://127.0.0.1/api/health` 可验证 nginx → 后端链路（未带凭据应返回 **401**）。
- 另有同域反代路径 `/cstudio/`（W316/W323，挂在 `temp.celestea.top` 站点上）把 Studio 嵌进中心门户；相关配置在 `/etc/nginx/sites-available/temp.celestea.top`，本文不展开。

---

## 4. 环境变量

### 4.1 Studio 自己的

| 变量 | 默认 | 作用 | 代码位置 |
|---|---|---|---|
| `STUDIO_BIND` | `127.0.0.1:3777` | HTTP 绑定地址 | `src/main.rs:77`、`1379` |
| `CELESTEA_WORKSPACES_FILE` | `workspaces.json` | 工作区注册表路径 | `src/main.rs:1199-1204` |
| `CELESTEA_PROVIDERS_FILE` | `providers.json` | 提供商存储路径（0600） | `src/main.rs:1278-1283` |
| `CELESTEA_PROMPTS_FILE` | `prompts.json` | 全局提示词注册表路径 | `src/prompts.rs:159` |
| `CELESTEA_AUTOWAKE` | 开 | `0`/`off`/`false`/`no` 关闭 worker 回执自动唤醒 | `src/main.rs:1044-1049` |
| `CELESTEA_SESSION_DIR` | 由活动会话决定 | 引擎要回放的**会话目录** | `src/main.rs:1219-1254` 等 |

### 4.2 引擎读的（Studio 透传）

| 变量 | 作用 |
|---|---|
| `CELESTEA_API_KEY` | 引擎 key（`api_key_env` 默认指向它）；由 `run-studio.sh` 从凭据文件注入 |
| `DEEPSEEK_BASE_URL` | `resolve_base_url` 的 env 兜底（`celestea.toml` 未写 `base_url` 时） |
| `CELESTEA_TOOL_ROOTS` | 引擎工具读取根白名单（单元里已设） |
| `CELESTEA_SANDBOX_NET` | `1` 恢复沙箱网络；默认隔离 |
| `CELESTEA_SHELL_MAX_TIMEOUT_MS` | 引擎 shell 工具超时上限（默认 300000ms） |

> **不要**把这些变量写进仓库文件；key 只能来自凭据文件或运行环境。

---

## 5. 健康检查

```bash
# 后端存活 + 当前模型/网关
curl -s http://127.0.0.1:3777/api/health
# {"ok":true,"name":"celestea-studio","model":"...","base_url":"...","bind":"127.0.0.1:3777"}

# 状态栏快照 + 活动会话
curl -s http://127.0.0.1:3777/api/status

# systemd 视角
systemctl status celestea-studio --no-pager
systemctl is-active celestea-studio
tail -n 50 /tmp/celestea-studio.log
```

- `GET /api/health` 恒 200，只要进程活着；**不**探测上游 LLM 是否可用（要探上游用 `POST /api/providers/test`）。
- 判断"前端是否构建"：`curl -sI http://127.0.0.1:3777/ | head -1`，若正文是"先构建前端"提示页说明 `frontend/dist/index.html` 缺失。
- nginx 链路：`curl -k -o /dev/null -w '%{http_code}\n' -H 'Host: studio.celestea.top' https://127.0.0.1/api/health` → 期望 **401**（未带 basic auth）。

---

## 6. 部署 / 重启 / 回滚

### 6.1 后端改动

```bash
cd /src/celestea_studio
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
cargo test --release                 # 全绿再往下（校对时 69 passed）
cargo build --release
sudo systemctl restart celestea-studio
systemctl is-active celestea-studio
curl -s http://127.0.0.1:3777/api/health
tail -n 20 /tmp/celestea-studio.log
```

> 重启会**重放当前活动会话**（`workspaces.json` 的 `active_session`），对话历史不丢；但**正在跑的 turn 会被中断**。选空闲时段做。

### 6.2 前端改动

```bash
cd /src/celestea_studio/frontend
pnpm typecheck && pnpm build         # 产物落到 frontend/dist/
curl -sI http://127.0.0.1:3777/ | head -1
# 浏览器强刷（dist 资源名带 hash，但 index.html 是 no-cache）
```
**不需要重启服务**（`get_static` 每次请求读磁盘，`Cache-Control: no-cache`）。

### 6.3 回滚

| 回滚对象 | 做法 |
|---|---|
| 代码 | `git revert` / `git checkout <旧 commit> -- <文件>` → 重编 + 重启 |
| 二进制 | 重启前先 `cp target/release/celestea-studio /tmp/celestea-studio.bak`，回滚时换回并重启 |
| 前端 | `git checkout <旧 commit> -- frontend/src` → `pnpm build` |
| 压缩坏了的会话 | 用同目录的 `cli-main.jsonl.precompact` 覆盖回 `cli-main.jsonl`（先停掉对该会话的写入：不要 activate 它，最好在服务空闲时操作） |
| 数据文件 | `workspaces.json` / `providers.json` / `prompts.json` 都是人可读 JSON，改前先 `cp` 一份 |

### 6.4 不要做的事

- 不要在用户正在用的时候重启（会中断 turn）；
- 不要 `git add -A` / `git commit -am` / `git push`（本仓库约定只提交明确列出的文件）；
- 不要把 `providers.json` / `workspaces.json` / `sessions/` / `frontend/dist/` 提交进版本库（`.gitignore` 已排除）；
- 不要为了"验证"在生产实例上跑 `POST /api/clear`（无备份、无 409，见 `docs/pitfalls.md` P11）；
- 不要直接把 `STUDIO_BIND` 改成 `0.0.0.0`（`/api/fs/browse` 无鉴权，会暴露任意目录名枚举）。

---

## 7. 排障速查

| 现象 | 先看什么 |
|---|---|
| 页面显示"先构建前端" | `frontend/dist/index.html` 是否存在 → `cd frontend && pnpm build` |
| 页面 404 / 空白但 API 正常 | 浏览器控制台；`curl -s http://127.0.0.1:3777/` 是否返回 index.html |
| `POST /api/turn` 返回 409 | 已有 turn 在跑（或 autowake 正在跑）；`GET /api/status` + 日志 |
| 状态栏不动 | SSE 是否被代理缓冲（nginx `proxy_buffering off`）；`curl -N /api/events` |
| 模型调用失败 | `GET /api/config` 看 `model`/`base_url`；`POST /api/providers/test` 测上游；日志里的 engine 错误 |
| 服务起不来 | `tail -50 /tmp/celestea-studio.log`；常见原因：`workspaces.json` 畸形（进程 `exit(1)`）、端口占用、compose 失败、`run-studio.sh` 取不到 key |
| 改了前端没变化 | 忘了 `pnpm build`；或浏览器缓存了旧 `index.html`（强刷） |
| 改了后端没变化 | 忘了 `cargo build --release` 或忘了 `systemctl restart` |
