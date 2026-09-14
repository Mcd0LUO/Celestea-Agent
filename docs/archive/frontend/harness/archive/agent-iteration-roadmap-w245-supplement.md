# Agent 迭代路线图：W245 独立验证补充

> 📦 历史文档（2026-09-11 归档）：描述的是 Rust 期主路线图的 W245 独立验证补充，属已被取代的评估过程留痕。当前权威入口见 [../DEVELOPMENT.md](../DEVELOPMENT.md)。

> 日期：2026-09-07（UTC+8）。复核会话：`session-6da2fcc2-2ab2-40ca-aec5-7084b4dd29af`。  
> 按架构主会话最新分工，本报告只补充独立验证与分歧，不覆盖 W246 已交付的 [主路线图](agent-iteration-roadmap.md)，不修改业务源码、不 commit、不 push。

## 1. 结论与版本

**认可主路线图的总体判断与优先级，无方向性分歧**：保留七 crate、Rust/axum 内嵌、日志单一事实源和引擎内 worker；先处理真实终态、强引用环/shutdown、工具权限、会话隔离与发布漂移，再开展性能、可恢复多 agent 与条件化扩展。不要恢复已否决的 DSH 桥接，不以单测全绿替代端到端可靠性。

本会话独立阅读了两仓核心生产路径、相关测试、引擎 backend-optimization-eval 及 Studio 三份既有评估，并阅读全文主路线图。版本口径如下：

- 引擎测试时源码基线：`8004efb`。收口 HEAD：`8bce45e`（主路线图文档提交，非本会话提交）。
- Studio 起始 HEAD：`61839f7`；测试针对当时包含 `src/{api,main,workspaces}.rs` 修改及新增 `src/prompts.rs` 的工作树。收口 HEAD：`ef0d698`，提示词后端已由其他任务提交，工作树干净。**未声称另行重跑了该干净 HEAD。**
- 本会话不将其他会话的 systemd/HTTP 只读探针冒充自己的验证；未运行真实模型调用、攻击验证、长时 RSS 压测或浏览器 E2E。

## 2. W245 实际命令与结果

Rust 命令使用以下显式环境：

```bash
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
```

| 工作目录 | 实际命令 | 结果 | 本会话证据 |
|---|---|---|---|
| `/src/celestea_harness` | `cargo test --workspace` | **退出 0：272 passed / 0 failed** | 后台任务 `bash-78` 输出已收集 |
| `/src/celestea_studio` | `cargo test` | **退出 0：39 passed / 0 failed** | 后台任务 `bash-79` 输出已收集 |
| `/src/celestea_studio/frontend` | `pnpm run build` | **退出 0：tsc --noEmit + Vite 成功，50 模块** | 后台任务 `bash-76` 输出已收集 |
| `/src/celestea_harness` | `cargo metadata --no-deps --format-version 1` | **退出 0：7 package，没有 celestea-cli** | 本会话命令输出 |
| `/src/celestea_harness` | `cargo build --release -p celestea-cli` | **退出 101：package ID 不匹配任何 package** | 失败发生在包选择，未完成 release 构建 |

引擎分项：agent-loop **25**、core **22**、llm **34**、runtime **62**、session **41**、tools **46**、workers **42**，总计 **272**；各 crate doc-test 为 0。

验证限制与过程记录：

- 首次直接调用 cargo（`bash-75`、`bash-77`）均退出 127，原因是 PATH 未包含托管工具链；设置上述环境后成功，不是代码编译失败。
- Studio 测试曾更新 crates.io index，出现 `/opt/cargo/registry/index/.../toml` cache 写入权限 warning，但最终退出 0、39 项测试实际执行。没有更改依赖锁定版本来规避失败。
- 引擎报告一处未使用测试辅助函数 warning，Studio 报告一处未使用 import warning；没有使用 cargo fix。
- OS sandbox capability 测试可能在能力不足时直接 return，并被测试框架计为 passed；272/272 不能证明 bwrap/raw/rlimit 每条路径均已执行。
- **前端验证实际重建了现有 `frontend/dist`，不是只做 typecheck。** 产物包括 `index.html`、`index-CRXorE-_.css`、`index-CxhSVz0t.js`。未修改前端源码，未重启服务；dist 是现有静态服务目录，因此该构建属于超出“仅文档”的产物刷新，本报告如实记录，不应说成绝无运行产物变化。
- Rust 两个测试命令曾同时启动并等待共享 package cache 锁；不作为建议执行方式。后续依服务器负载规范采用串行、低并发、预先检查负载的验证窗口。

## 3. 与主文档的分歧、澄清与新增风险

### 3.1 验证结论差异：来自不同执行条件，不互相覆盖

1. 主文 §1.3 记录 **W246 的 Studio offline 测试因索引缺版本退出 101，测试未执行**；本会话使用上述共享 Cargo home、未加 `--offline` 的命令，**39/39 实际通过**。两条记录均应保留，不能合并成“所有环境都可离线构建”。可复现离线依赖/索引仍属于发布改进项。
2. 主文记录 **W246 只 typecheck、未重建 dist**；本会话执行的是完整 **tsc + Vite build**，且重建 dist。构建通过仅证明编译/打包，不证明 scope、编辑回填、竞态或浏览器行为正确。
3. 主文对 CLI release 漂移提供源码/metadata 判断；本会话额外执行了原命令，得到明确 **exit 101**。这加强了阻断证据，不构成架构判断分歧。

### 3.2 补充纳入持久化与身份验收的静态风险

以下都由源码路径推导，**未线上注入故障复现**；不需要为此推翻主路线图。

| 风险 | 证据（引擎仓根相对路径） | 建议验收归属 |
|---|---|---|
| `sync_each_append=true` 且 `flush_each_append=false` 时，直接对 BufWriter 底层文件 sync_data，未保证用户态缓冲先 flush | `crates/session/src/persistent.rs:191-203` | durability 契约测试覆盖四种选项组合；sync 确认前先 flush，失败可见。默认组合不受此特定配置触发。 |
| clear 在重建文件失败后仍清内存，writer 已被 take，可能造成磁盘/内存分裂 | `crates/session/src/persistent.rs:236-250` | clear 错误必须反馈并保留可恢复状态；P0 明确失败语义，P1 writer/事务实现闭合。 |
| `SessionRegistry::create` 的 session-N 计数不与外部 register 协调，生成同 ID 时无条件 insert 可覆盖现有会话 | `crates/session/src/registry.rs:99-110,113-123` | 唯一身份验收增加 register("session-0")→create 不覆盖用例，并支持实例/会话稳定身份。 |

### 3.3 对既有旧评估的共同校准

- `PersistentSessionLog::replay` 已用 `BufReader::read_until` 逐行读（`persistent.rs:311-351`），问题是**全量事件物化**，不是尚未实现流式读取。
- 历史 projection 是**每模型 step**执行；trim 候选后缀重复估算存在最坏 O(n²) 风险，`str.len()` 本身为 O(1)。旧“每 turn 2–3 次字节扫描”的口径不精确。
- 当前 worker 已有 mailbox 消费循环；休眠 seam、无界队列、watchdog 未接线/语义冲突、实际 Arc 环才是剩余风险。
- `prompt-injection-eval.md` 是提示词装配/变量机制评估，不是恶意提示词注入防御审计；模板插值成功不等于工具授权安全。
- 投递建议是**至少一次 + ack/执行幂等**，不承诺不可逆外部副作用 exactly-once；SSE 断连也不应默认取消后台任务。

## 4. 交付边界

- 主文 `docs/archive/agent-iteration-roadmap.md` 的分期、预算、验收和决策清单保持不动；本报告作为独立验证附录。
- 本会话没有提交或推送，也未修改业务源码、配置或服务；前端验证刷新 dist 的边界偏差见 §2。
- 文件 write 工具因宿主 root 与会话 celestea 执行身份不匹配拒绝操作；按工具明确提示使用 bash 以 uid 1003 落盘，不使用权限升级。
- 完成报告：`/server-center/runtime/worker-exec/results/W245-Agent迭代路线图.md`。
- 回执目标：`session-56597d5b-c030-4514-9869-17bdaf94b4b2`。回执送达确认后再写本任务要求的 `W245.receipt-ok`；既有同名标记不作为本次送达证据。
