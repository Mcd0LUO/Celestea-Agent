# Celestea Agent

> **自托管的 AI Agent 工作台**：一个网页界面 + 一个 TypeScript 后端，让 agent 在你自己的机器上带着工具干活。

Celestea Agent 把「一个能读写文件、执行命令、跑代码、并行派子任务的 agent」放进你自己的服务器。
会话、工作区、模型提供商、权限与沙箱、成本账本**全部自持**，数据不出你的机器。

![Celestea Studio 界面：左侧工作区/会话树，右侧对话区（多模态识别 + LaTeX 公式渲染），底部 statusline 与发送栏](docs/assets/studio-overview.png)

## 能力

- **会话即工作区** —— 每个会话绑定一个真实目录；agent 的每一步（读文件、改代码、跑命令）都发生在那儿，日志逐行落盘、可回放。
- **18 个内置工具** —— `read_file` `write_file` `list_dir` `load_skill` `run_shell` `run_code` `read_image` `http_request` `process_control` `remember` `forget` `ask_user_question` `send_message` `spawn_worker` `stop_worker` `worker_status` `browser_open` `browser_act`。
- **并行子 agent（worker）** —— 一个会话可派出多个 worker 会话并行干活；主会话能读它们的实时状态，也能**直接和它们对话**。
- **沙箱执行** —— `bwrap` + `prlimit` 隔离文件系统、网络与资源；环境不具备时按策略**降级或拒绝**，不静默放行。
- **权限档位** —— 内置 `read-only` / `write-read` / `full-access` 三档，可逐会话固定，也可由你在界面上**临时提权**（一次性授权、可撤销、全程审计、**永不可由模型自触发**）。
- **多模型 / 多提供商** —— 任意 OpenAI 兼容端点；模型、推理档位、降级链可配，**可逐会话覆盖模型**。
- **看得见的成本** —— 逐轮 usage 账本与费用视图。
- **多模态** —— 图片附件；`md`/`txt` 等文本文件直接进上下文；LaTeX 公式（KaTeX + mhchem）。
- **选段提及** —— 在消息里选中一段文字，点「引用」即可把这段**内容快照**随下一条消息发出；纯文本块、历史可回放。
- **工作区持久记忆** —— 工作区可放一份 `MEMORY.md`（项目层随仓库提交，全局层只在本机），每轮自动作为背景资料注入；没有文件就零开销。
- **中英双语界面** —— 全前端文案走 zh/en 字典（840+ key），设置页可切换，`<html lang>` 跟随切换。
- **可插拔** —— 提示词库、前端插件、工具披露策略都长在插件缝上，可热开关。
- **可选登录门** —— 自带 `/login` + HMAC cookie，可直接对公网暴露（也可只监听环回）。

---

## 快速开始

### 1. 安装

已发布到 npm（`celestea-agent` 及其 8 个 `@celestea/*` 依赖包）。需要 **Node.js ≥ 24 < 27**。

```bash
npm install -g celestea-agent      # 或 pnpm add -g celestea-agent
celestea web                       # 起服务并自动打开浏览器
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port N` | 3777 | HTTP 端口（`0` = 随机空闲端口） |
| `--bind ADDR` | `127.0.0.1` | 绑定地址 |
| `--no-open` | — | 不自动打开浏览器 |
| `--token SEC` | — | 要求 `Authorization` 才能访问 `/api/*`（也读 `CELESTEA_AUTH_TOKEN`） |

> **非环回绑定默认拒绝启动**，除非配了 token。`--bind 0.0.0.0` 不只是「开了个网页」：
> `POST /api/exec` 会以当前用户身份执行任意命令。公网姿势见 [部署与安全模型](docs/deployment.md)。
>
> 版本自检：`celestea --version`；`celestea --help` 有完整用法。

### 2. 配一个模型

```bash
export CELESTEA_API_KEY="sk-..."                        # 或写进 providers.json 的 api_key
export CELESTEA_BASE_URL="https://api.example.com/v1"   # 可选
export CELESTEA_MODEL="your-model-id"                   # 可选
```

更完整的提供商/模型管理在界面的**设置 → 提供商**里做。全部配置项（数据根、权限档位、沙箱策略）见 [配置](docs/configuration.md)。

### 3. 从源码运行（开发）

```bash
git clone https://github.com/Mcd0LUO/Celestea-Agent.git
cd Celestea-Agent && pnpm install --frozen-lockfile
pnpm --dir apps/web run build          # 前端产物（后端从磁盘静态服务）
pnpm --filter @celestea/studio start   # 默认 127.0.0.1:3778
```

开发流程、门禁与提交规范见 [AGENT.md](docs/AGENT.md)。

---

## 文档

- **[docs/README.md](docs/README.md)** —— `docs/` 全量索引（每篇的状态、一句话、权威入口）。**找文档先看它。**
- [AGENT.md](docs/AGENT.md) —— 开发与提交规范（铁律 / 完成定义 / 发布流程 / 派工协议）
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构契约（分层、包职责、插件缝、扩展点）
- [configuration.md](docs/configuration.md) —— 数据根与环境变量、模型接入、权限档位
- [deployment.md](docs/deployment.md) —— 生产部署（systemd + nginx）、隧道、**安全模型**
- [pitfalls.md](docs/pitfalls.md) —— 踩坑档案（症状 → 根因 → 正确做法）

## 许可证

[MIT](LICENSE) © 2026 Mcd0LUO
