# LEGACY：Rust 后端已退役（2026-09-11）

Studio 后端已完成 **TypeScript 全量重写**，生产实例为 `celestea-studio-ts.service`（127.0.0.1:3777，无构建步骤，tsx 直接跑源码）。
原 Rust 后端 `celestea-studio.service` 于 2026-09-11 退休。

## 现状
- `celestea-studio.service`：**masked**（`/etc/systemd/system/celestea-studio.service -> /dev/null`），`inactive`。
- `target/release/celestea-studio` 二进制：已移入归档，已从工作树删除。
- Rust 源码（`src/*.rs`、`Cargo.*`、`celestea.toml`）与 `target/`：**保留**（历史参考；`target/` 仍占约 4G，可按需 `cargo clean` 回收）。
- 本仓**继续作为线上前端 + TS 后端数据文件的宿主**，下列路径**不可删**：
  - `frontend/`（线上 dist 由 `celestea-studio-ts` 直接读取）
  - `providers.json` / `workspaces.json` / `prompts.json` / `sessions/`（TS 后端运行数据）

## 归档与回滚
- 归档：`/server-center/runtime/backups/celestea-studio-rust-retire-20260911-125917.tar.gz`
  （含旧 unit、`scripts/run-studio.sh`、release 二进制、当时的 git HEAD）
- 回滚步骤（如需）：
  ```sh
  sudo systemctl unmask celestea-studio
  sudo tar -xzf /server-center/runtime/backups/celestea-studio-rust-retire-20260911-125917.tar.gz -C /tmp/rust-restore
  sudo cp /tmp/rust-restore/celestea-studio.service /etc/systemd/system/
  sudo cp /tmp/rust-restore/celestea-studio /src/celestea_studio/target/release/
  sudo systemctl daemon-reload && sudo systemctl enable --now celestea-studio
  ```
  注意：`celestea-studio.service` 与 `celestea-studio-ts.service` 曾设 `Conflicts=`，两者不要同时启用。

## 相关文档
- `docs/archive/deployment.md`：**旧 Rust 部署文档（已过时，仅存史）**；TS 部署见 `/src/celestea_studio-ts/scripts/run-studio-ts.sh` 与 `/etc/systemd/system/celestea-studio-ts.service`。
- `docs/archive/api-contract.md`：**旧 Rust 后端 HTTP 契约（仅存史）**；TS 契约真源见 `/src/celestea_studio-ts/contracts/endpoints.json`。
- `docs/README.md`：本仓 `docs/` 索引（当前 / 历史一览；`DEVELOPMENT.md`、`data-files.md`、`pitfalls.md` 保留在 `docs/`）。
- `/src/celestea_harness`：Rust **引擎**（非 Studio 后端），保留作为参考实现与迭代路线图来源（路线图已归档：`/src/celestea_harness/docs/archive/agent-iteration-roadmap.md`）；文档索引见 `/src/celestea_harness/docs/README.md`。
- `/src/celestea_studio-ts`：Studio 后端（TypeScript，**生产**）；文档索引见 `/src/celestea_studio-ts/docs/README.md`，后端开发一律在那里。
