# W781：本仓已全量并入 Celestea-Agent（2026-09-14）

> 状态：**历史参考**。本文件是调研/迁移阶段的记录，W890 起归档到 `docs/archive/`；现行口径见 [`docs/README.md`](../../README.md)。
> 📦 **历史文档**。

本仓（Celestea-Studio，目录 `celestea_studio`）的内容已**全量迁入** `celestea_studio-ts`
（Celestea-Agent，远端 `Mcd0LUO/Celestea-Agent`）。自此**唯一仓 = Celestea-Agent**。

## 去向对照

| 原位置（本仓） | 新位置（Celestea-Agent） |
| --- | --- |
| `frontend/` | `apps/web/` |
| `docs/DEVELOPMENT.md`、`data-files.md`、`pitfalls.md` | `docs/`（README 并入 `docs/archive/README-frontend.md`） |
| `docs/archive/**` | `docs/archive/frontend/`（W881 清理：退役历史文档已移出公开仓） |
| `tools/**` | `scripts/model-sync/`（本次起被 git 真正跟踪） |
| `notes/**` | `docs/notes/`（仅一篇 3 行插话测试残留，2026-09-15 清理时删除；内容为 `插话测试：立刻记下这条`） |
| `README.md` | 并入 Celestea-Agent 的 README「文档与仓库角色」段 |

运行数据（`providers.json` / `workspaces.json` / `sessions/` / `studio-auth.secret` /
`grants-audit.jsonl` / `usage-ledger.jsonl` / `worker-results/` / `results/`）**不再放本仓**，
已迁到 `/var/lib/celestea-agent/`（0750 `celestea:celesdev`；密钥文件 0600）。

## 线上依赖已同步改指

- `/server-center/runtime/bin/sync-models.py` → `celestea_studio-ts/scripts/model-sync/sync-models.py`
- `/server-center/runtime/bin/sync-upstream-models.py` → `celestea_studio-ts/scripts/model-sync/sync-upstream-models.py`
- cron `/etc/cron.d/celes-studio-models`、`/etc/cron.d/celes-sync-upstream-models` 的「脚本真源」注释已更新
- `celestea-studio-ts.service` 的 `WorkingDirectory` / `CELESTEA_TOOL_ROOTS` / 数据目录已指向新位置

## 本仓现状

工作树已于 W781 收束后**删除**（`/src/celestea_studio` 整个目录连同 `.git`）；构建产物目录在删除前已清理，回收 4.2 GiB。
**回滚**见 `/server-center/runtime/backups/celestea-merge-20260914-213707/`。
