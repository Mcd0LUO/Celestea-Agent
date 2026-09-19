# 配置

> 状态：**当前**。本文是运行配置的唯一入口：数据根、环境变量、模型接入、权限档位。
> 快速开始见根 `README.md`；数据文件的 schema 见 `data-files.md`。

---

## 1. 数据根（`CELESTEA_HOME`）

会话、附件、归档、回收站、run-code 临时程序**不该**落在仓库里，它们由 `CELESTEA_HOME` 决定。
解析顺序（第一个命中者胜）：

1. `$CELESTEA_HOME` —— 显式覆盖。生产**应当**设为 `/var/lib/celestea-agent`（FHS 的 `/var/lib/<service>`）。
2. `$XDG_DATA_HOME/celestea` —— Linux 上尊重 [XDG Base Directory](https://specifications.freedesktop.org/basedir/latest/)。
3. `~/.celestea` —— Linux / macOS 默认（同类 agent CLI 的通行落点：`~/.claude`、`~/.codex`、`~/.gemini`）。
4. `%USERPROFILE%\.celestea` —— Windows 默认。

其下按工作区分桶：

```
<home>/workspaces/<工作区名>/sessions/<会话>/   会话日志（cli-main.jsonl）
<home>/workspaces/<工作区名>/archive/           归档会话
<home>/workspaces/<工作区名>/trash/             回收站
<home>/workspaces/<工作区名>/run-code/         run_code 的临时程序
<home>/workspaces/<工作区名>/prompts.json      该工作区的提示词库
```

> 注册表 / 提供商 / 提示词这几个文件由**各自的变量**指定，默认是**当前目录**——
> 所以从源码本地跑时请显式指走（见下一节），否则会落在仓库里。

最小设置：

```bash
export CELESTEA_HOME="$HOME/.celestea"
export CELESTEA_WORKSPACES_FILE="$CELESTEA_HOME/workspaces.json"
export CELESTEA_PROVIDERS_FILE="$CELESTEA_HOME/providers.json"
export CELESTEA_PROMPTS_FILE="$CELESTEA_HOME/prompts.json"
export CELESTEA_USAGE_LEDGER_FILE="$CELESTEA_HOME/usage-ledger.jsonl"
mkdir -p "$CELESTEA_HOME"
```

---

## 2. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CELESTEA_HOME` | `~/.celestea` | 会话/归档/回收站/run-code 的数据根（见上） |
| `CELESTEA_WORKSPACES_FILE` | `<cwd>/workspaces.json` | 工作区注册表（工作区 = 一个真实目录） |
| `CELESTEA_PROVIDERS_FILE` | `<cwd>/providers.json` | 提供商与模型（含密钥，0600） |
| `CELESTEA_PROMPTS_FILE` | `<cwd>/prompts.json` | 提示词库 |
| `CELESTEA_USAGE_LEDGER_FILE` | 未设 | 用量/成本账本（`jsonl`） |
| `STUDIO_TS_PORT` / `STUDIO_TS_BIND` | `3778` / `127.0.0.1` | 监听端口 / 地址（生产用 3777） |
| `STUDIO_STATIC_ROOT` | `apps/web/dist` | 前端静态根 |
| `CELESTEA_API_KEY` / `CELESTEA_BASE_URL` / `CELESTEA_MODEL` | — | 模型接入（见 §3） |
| `CELESTEA_PERMISSION_DEFAULT` | `full-access` | 新会话的默认权限档位 |
| `CELESTEA_PERMISSION_MAX` | `full-access` | 权限**上限**，任何提权都夹在它之内 |
| `CELESTEA_SANDBOX_FALLBACK` | `userspace` | `bwrap` 不可用时：`userspace` 降级 / `fail` 拒绝执行 |
| `CELESTEA_SANDBOX_NET` | 跟随权限 | `1` 强制开网 / 由档位决定 |
| `CELESTEA_TOOL_ROOTS` | — | 工具可读根白名单（**fail-closed**） |
| `CELESTEA_AUTH_SECRET_FILE` | 与 `workspaces.json` 同目录 | 登录 cookie 的 HMAC 密钥文件 |
| `CELESTEA_AUTH_HTPASSWD_FILE` | `/etc/nginx/.htpasswd-studio` | 登录口令文件（`htpasswd -vbi` 校验） |

完整清单另见 `scripts/run-studio-ts.sh`（生产实际设置的那一份）与 `data-files.md`（数据文件 schema）。

---

## 3. 接入一个模型

最小配置是给一个 API key。引擎的解析顺序：**env → `api_key_file` → `~/.celestea` 配置**。

```bash
export CELESTEA_API_KEY="sk-..."                        # 或写进 providers.json 的 api_key
export CELESTEA_BASE_URL="https://api.example.com/v1"   # 可选，默认见 providers.json
export CELESTEA_MODEL="your-model-id"                   # 可选
```

更完整的提供商/模型管理在界面的**设置 → 提供商**里做，落盘为 `providers.json`。
该文件**含密钥，权限 0600，切勿入库**；密钥只从文件/环境读，绝不写进会话日志。

---

## 4. 权限档位

| 档位 | 含义 |
|---|---|
| `read-only` | 只读工作区，不执行命令 |
| `write-read` | 可读写工作区，命令在沙箱内执行 |
| `full-access` | 整盘可读写、允许联网、允许非沙箱执行（**默认**） |

**默认是 `full-access`**：这是为了「自己机器上少点摩擦」，**不是**面向多租户的默认值。
要收紧就设 `CELESTEA_PERMISSION_DEFAULT=write-read`（或 `read-only`）与 `CELESTEA_PERMISSION_MAX`。
上限一旦设死，会话**不可能**越过它。安全模型详见 `deployment.md` §4。
