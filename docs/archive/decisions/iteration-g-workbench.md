# 迭代方向 G · 交互工作台（命令面板 / 多面板工作区 / 目标）

> 📦 **历史文档**。本文件是**已实现决策的归档记录**（为什么这样设计、当时的验收标准），
> W893 起从 `docs/` 移入 `docs/archive/decisions/`。它**不是**现行口径：
> 当前行为请看 `contracts/`（线格式）、[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)（架构规则）、
> 以及各功能对应的现行文档。归档**不删除正文** —— 决策的理由仍然可查。

> 状态：**历史参考**（本决策**已实现**）。本文是当时的决策依据与验收记录，**不再随代码更新**；现行行为见 [`docs/README.md`](../../README.md) 与 [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)。原状态：已实现（G1–G4，v2.7.x）。本文是目标契约、验收标准与冻结线格式的记录；落地见 apps/web/src/ui/workbench/、apps/studio/src/handlers/exec.ts。
> 前置：`./iteration-f-capabilities.md`（F1-F4 体例）、`docs/ARCHITECTURE.md`。
> 一句话目标：**把对话框从唯一入口变成工作台的一格**——命令可直达、面板可停靠、目标可持久。

---

## 0. 结论速览

| # | 能力 | 现状 | P0 | P1 |
|---|---|---|---|---|
| G1 | 斜杠命令面板 | **零**（只有硬编码的 `/compact`） | 打 `/` 自动弹补全框；`/run` `/goal` `/model` `/compact`；`!` 前缀 = `/run` | 命令别名、自定义命令、历史 |
| G2 | 立即执行（`/run`、`!`） | 只能靠模型调 `run_shell` | **`POST /api/exec`**：不经过模型、复用同一沙箱、过权限门 | 后台长驻进程接线 |
| G3 | 持久目标 | **产品里没有「目标」概念** | `/goal` + `POST /api/sessions/{id}/goal`；每轮注入、界面可见 | 目标驱动自动续跑 |
| G4 | 多面板工作区 | **零** | 右上角图标 → 文件管理器（Win 风格，可点文件夹/文件）；可开终端 / 浏览器；多开、可拆分停靠（底部/右侧） | 布局持久化、拖拽换位 |
| G5 | 文件列举 | 只有 `/api/fs/browse`（**只列目录，不列文件**） | `GET /api/fs/list`（目录+文件+大小+mtime） | 文件搜索（供 `@提及`） |
| G6 | `@提及文件` | 消息正文里的路径**点了没反应** | **延后**（依赖 G5） | 输入 `@` 弹文件补全 |

**顺序**：G5 → G1/G2/G3（并行）→ G4 → G6。

---

## 0.1 已冻结的线格式（实现方不得各自发明）

```
GET /api/fs/list?path=<abs>
  200: { path: string; parent: string|null; entries: Array<{
           name: string; type: "dir"|"file"; size: number|null; mtime: string|null }> }
  4xx: { error: string }

POST /api/exec
  body: { command: string; session?: string; workdir?: string; timeout_ms?: number }
  200 : { ok: true; exit_code: number|null; signal: string|null;
          stdout: string; stderr: string; duration_ms: number;
          sandbox: { provider; net_isolated; tmp_private; seccomp; cpu_sec? } }
  4xx : { error: string; code?: string }

POST /api/sessions/{id}/goal
  body: { text: string }                       # 空串 = 清除
  200 : { ok: true; goal: { text: string; createdAt: string; updatedAt: string } | null }
```

**端点计数**：61 → 62（`/api/fs/list`）→ 63（`/api/exec`）→ 64（goal）。
每加一个都必须同步 `contracts/endpoints.json` + `API_ENDPOINT_COUNT` + 契约断言。

---

## 1. G2 立即执行（关键裁决）

**用户原话：「立即执行 与模型无关」**。

因此 `/run` 与 `!` **不走 `/api/turn`、不花 token、不等模型**，直接调 `POST /api/exec`。

三条硬约束：
1. **复用 `run_shell` 的真实执行路径**（同一 `Sandbox` seam、sanitized env、workdir 解析、输出上限）——**不许另写一套执行器**，否则隔离会分叉；
2. **必须过权限门**：档位不允许 shell / 无授权 ⇒ **结构化拒绝 + 可读原因**，绝不静默放行；
3. **不是工具**：不进 `contracts/tools.json`、不进模型工具面。它只服务 UI。

`sandbox` 块遵守刚收敛的口径（**只给契约字段**，主机诊断字段不进结果）。

---

## 2. G3 持久目标

**用户裁决「b」**：像 DSH 那样——一等概念，agent 每轮都看到，可查看、可完成。

- 存储：会话级（`<session>/goal.json` 或会话 meta），**append-only 不适用**，这里是可变状态；
- 注入：走既有 `turnContext` 车道（与技能目录、记忆同一处），**作为数据呈现**；
- UI：`/goal xxx` 设置、`/goal` 查看、`/goal done` 清除；目标要在界面上**一眼可见**；
- **P0 明确不做**：目标不驱动自动续跑（agent 不会自己一轮轮推进）。

---

## 3. G4 多面板工作区

右上角一个图标 → 弹出**文件管理器（Win 风格，可点文件夹/文件）**，并可**打开终端 / 浏览器**。
面板**可同时开多个、可自由拆分移动到底部或右侧**。

- 文件管理器数据来源 = `GET /api/fs/list`（G5）；
- 终端面板的**真 TTY 可行性先 spike**（项目零运行时依赖：本机有无 `script`/`socat`？）；
- 停靠/拆分是纯前端布局问题：**不动 `#layout` 的三栏骨架**，用可拖拽的分割容器；
- 既有铁律全部适用（离屏构建+单次替换、竞态守卫、弹层 / 面板开关不重建背景）。

---

## 4. 未验证 / 待确认

1. **终端能否零依赖拿到真 TTY**——spike 进行中；
2. 面板停靠的**布局持久化**是否要跨刷新（P0 不做，刷新即重置）；
3. `@提及文件` 的**作用是「把文件内容带进上下文」还是「只是引用路径」**——待定（依赖 G5 落地后再拍）；
4. `/api/exec` 的**权限门口径**：是「会话档位允许 shell」，还是「必须显式授权一次」——实现时定，必须写进报告。
