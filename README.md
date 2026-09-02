# celestea_harness

An "everything is a plugin" AI agent harness in Rust, inspired by DeepSeek Harness.

- Core seams live in crates/core/src/lib.rs (the pinned contracts).
- See ARCHITECTURE.md for the design and module ownership.

## 安装

### 方式一：下载预编译二进制（推荐）

无需本地编译，直接从 [GitHub Releases](https://github.com/Mcd0LUO/Celestea-harness/releases) 下载对应平台的预编译产物：

| 平台 | 产物 | 架构 |
| --- | --- | --- |
| Linux | `celestea-linux-x86_64.tar.gz` | x86_64 |
| macOS（Apple Silicon） | `celestea-macos-aarch64.tar.gz` | arm64 |
| Windows | `celestea-windows-x86_64.zip` | x86_64 |

解压后把 `celestea`（Windows 为 `celestea.exe`）加入 `PATH` 即可直接使用。

> 为什么发布预编译二进制：Windows 下 `aws-lc-sys` 需要 MSVC + CMake 工具链，本地编译成本高；直接下载产物可完全绕开。

### 方式二：从源码编译

需要 Rust 稳定版工具链（[rustup](https://rustup.rs)）：

```bash
cargo build --release -p celestea-cli
# 或安装到 ~/.cargo/bin（本仓库是虚拟 workspace，需指向 cli 包目录）
cargo install --path crates/cli
```

产物位于 `target/release/celestea`（Windows 为 `celestea.exe`）。

## 配置

CLI 通过 `celestea.toml`（TOML，优先）描述模型与运行时行为，兼容旧的 `profile.json`（JSON，回退），两者都缺则用默认值；也可用 `--profile <路径>` 指定任意文件（按扩展名自动识别 TOML/JSON）。未知键与错误类型默认忽略，加 `--strict` 则报错。

### API Key：三条设置路径（按优先级）

token 值**永不进入任何配置文件**，只从环境变量或独立 key 文件读取。按优先级：

1. **环境变量**（`api_key_env` 指定，默认 `DEEPSEEK_API_KEY`）
   - Linux/macOS：`export DEEPSEEK_API_KEY="sk-..."`（可写入 `~/.bashrc` / `~/.zshrc`）
   - Windows PowerShell：`$env:DEEPSEEK_API_KEY = "sk-..."`（当前会话）或 `setx DEEPSEEK_API_KEY "sk-..."`（持久）
   - 自定义变量名：配置 `api_key_env` 指向你自己的变量（如 `MY_DEEPSEEK_KEY`），token 仍只存于环境变量。
   - 一次性内联：`DEEPSEEK_API_KEY=sk-... celestea run -e "你好"`。
2. **`api_key_file` 文件**：配置 `api_key_file = "/path/to/deepseek.key"`，读取该文件并 trim 后的内容作为 key（环境变量未设置/为空时生效）。
3. **`.env` 文件**：启动时若当前目录存在 `.env` 会自动加载（静默，失败不报错），把 `DEEPSEEK_API_KEY=...` 写进去即可，无需导出到 shell。

三者都缺时命令以退出码 `1` 失败，stderr 提示 API key not found。

### 配置键（9 个，celestea.toml 与 profile.json 通用）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `model` | string | `deepseek-chat` | 模型名（非空即可，具体目录由 provider 决定） |
| `system_prompt` | string | `You are a helpful assistant.` | 系统提示词 |
| `max_steps` | integer | `16` | 单轮最大工具调用步数 |
| `max_parallel_tool_calls` | integer | `4` | 并行工具调用上限 |
| `base_url` | string | provider 默认 | 覆盖 API base URL；优先级 profile > env `DEEPSEEK_BASE_URL` > 默认 `https://api.deepseek.com` |
| `reasoning_effort` | string | 无 | 推理档位：`low` / `medium` / `high` |
| `max_output_tokens` | integer | 无 | 输出 token 上限 |
| `api_key_env` | string | `DEEPSEEK_API_KEY` | 存放 API key 的环境变量名（token 值不落盘） |
| `api_key_file` | string | 无 | 可选：API key 文件路径（trim 后作为 key；env 未设置/为空时生效） |

示例 `profile.json`：

```json
{
  "model": "deepseek-chat",
  "system_prompt": "You are a helpful assistant.",
  "max_steps": 16,
  "max_parallel_tool_calls": 4,
  "base_url": "https://api.deepseek.com",
  "reasoning_effort": "medium",
  "max_output_tokens": 4096,
  "api_key_env": "DEEPSEEK_API_KEY"
}
```

也可参考 `crates/cli/celestea.toml.example`（9 键带注释的 TOML 配置模板）。

## 用法

### chat — 交互式会话（默认命令）

```bash
celestea                    # 交互式 REPL：行编辑 / 历史 / Ctrl-C / Ctrl-D
celestea chat
celestea --profile my.json  # 指定配置文件
```

REPL 支持 `/` 命令：`/tools`、`/model`、`/clear`、`/profile`、`/exit`。当 stdin 非终端（管道/重定向）时，`chat` 自动把全部输入作为一轮一次性执行。

### run — 一次性执行

```bash
celestea run -e "帮我列出当前目录"   # 输入来自 -e / --input
echo "你好" | celestea run           # 输入来自 stdin
celestea run --json -e "1+1=?"       # 结构化 JSON 输出
```

`--json` 输出 `{turn, assistant_text, tool_calls, results, error?}` 文档。

### tools — 列出内置工具

```bash
celestea tools
```

无需模型/网络即可运行。内置工具共 7 个：四个文件/Shell 工具（`read_file`、`write_file`、`list_dir`、`run_shell`）加三个编排工具（`spawn_worker`、`session_send_message`、`worker_status`）。

### 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 配置 / 初始化错误（如缺少 API key、profile 非法） |
| `2` | turn 执行错误 |
| `3` | 运行时 I/O 或内部错误 |

### Windows 说明

- 下载 `celestea-windows-x86_64.zip`，解压后运行 `celestea.exe`（建议加入 `PATH`）。
- PowerShell 里不要用 `KEY=... cmd` 内联语法，改用 `$env:DEEPSEEK_API_KEY = "sk-..."` 或 `setx`。
- `run --json` 的 stdout 静默在 Windows 上为尽力而为（Unix 用 fd 重定向，Windows 回退为不静默）；需要纯净 JSON 时建议把 stdout 重定向到文件后再解析。
- `chat` 交互 REPL 依赖终端；在 Windows 上请使用 Windows Terminal / PowerShell 等支持 TTY 的终端。

## 开发

- 核心契约见 `crates/core/src/lib.rs`；架构设计见 `ARCHITECTURE.md`。
- CI：每次 push / PR 自动跑 `cargo test --workspace`；打 `v*` tag 自动构建 Linux / macOS(Apple Silicon) / Windows 三平台预编译产物并发布到 GitHub Releases（也可在 Actions 页手动 `workflow_dispatch` 触发）。

