# W188 · celestea-harness M8 — 高性能 + 无内存泄漏 审计与压力测试

> 审计范围：/src/celestea_harness（7 crate）。结论基于全仓源码审读。
> 验证：cargo build + cargo test 全绿（131 测试）。

## 一、审计结论

逐项排查泄漏向量：

| 向量 | 排查结果 |
|---|---|
| Arc / Rc 循环引用 | 无。`Context.parent` 仅子指向父（单向 DAG 无环）；`Session.log`/`SessionRegistry`/`SessionMailbox`/`EventBus` 均无回边。 |
| tokio::spawn 无回收 | 真泄漏风险→已最小修复。老 `drive_if_possible` 丢弃 JoinHandle，任务累积且无法 abort。 |
| 无界集合无限增长 | 部分真风险→最小修复（registry 无删除、mailbox 空 key 残留）；部分设计。 |
| Box::leak / mem::forget | 无（全仓 grep 无命中）。 |
| Notify 泄漏唤醒 | 无。延迟注册 + 取数竞态安全，无 waiter 累积。 |

总体：harness 内存模型干净（append-only 日志 + Arc 共享 + 轻量结构）。真泄漏仅两处：未追踪的后台 spawn 任务、无删除/清理路径的注册表与信箱空 key，均已极小修复。

## 二、泄漏点清单（含「有意为之」）

### 真泄漏（已最小修复，语义不变）
1. **drive_if_possible 的 tokio::spawn 丢弃 handle**（workers/src/lib.rs）：改为并入 `WorkerRegistry` 内 `tokio::task::JoinSet`（新增 `background` 字段）。新增 `prune_completed()` / `abort_all()` / `background_len()`。后台 run_turn 语义不变，只是可观测、可回收、可中止。
2. **SessionRegistry 无删除路径**（session/src/lib.rs）：新增 `remove(&self,id)->bool`。验证：create+remove 后 len() 归零、Weak 全灭。
3. **SessionMailbox 消费后空队列 key 残留**（session/src/lib.rs）：新增 `purge(&self,session_id)` 整体移除（含残量消息与空 key），配合会话删除释放信箱状态。

三个修复均为「新增能力 / 追踪句柄」，不改任何已有行为与数据布局。

### 设计上有意为之（只记录，不修）
- **WatchdogPlugin.mount 常驻巡检循环**（workers/lib.rs）— 看门狗本为常驻巡检；注释称「未启动才 spawn」，实为每次 mount 无守卫 spawn。实践中每插件实例 mount 一次、成本固定，记档不修。
- **InMemorySessionLog 事件 Vec 无上限** — append-only 单一事实源，无界是设计。
- **SessionMailbox 单会话队列无上限** — 契约「入队不保证被消费」，无 cap 是设计。
- **EventBus / ToolRegistryImpl / NamedRegistry 注册集合持续增长** — 随挂载增长，属设计。
- **registry.tsv 持久行** — 状态持久化，属设计。

## 三、压力测试结果

新增 8 个测试（压力 + 简单基准），全部通过；全套 131 测试全绿。

| 测试 | 断言 | 结果 |
|---|---|---|
| stress_registry_mass_create_remove_returns_to_zero | 20k 会话 create→len=20k，逐个 remove→len=0 | PASS |
| stress_registry_no_arc_cycle_left_behind | 5k 会话 remove 后所有 Weak::upgrade()==None → 无环残留 | PASS |
| stress_mailbox_send_recv_all_consumed_pending_zero | 20k 发送全部消费后 pending/pending_total 归零 | PASS |
| stress_mailbox_distinct_sessions_purge_clears_keys | 5k 会话 send+purge 后 pending_total=0，purge 后重发可再消费 | PASS |
| stress_spawn_seam_tasks_are_tracked_and_reaped（workers） | 驱动 40 后台 turn→background_len()>=1→prune 后==0 无 task 泄漏 | PASS |
| bench_derive_messages_throughput | 400 事件日志 2k 次 derive，耗时<30s | PASS |
| bench_registry_resolve_throughput | 500 会话 20k 次 resolve，<30s | PASS |
| bench_dispatch_throughput | 20k 次 dispatch（miss 路径），<30s | PASS |

### 简单基准（std::time::Instant，输出到测试日志）
- **registry.resolve(id)**：约 **205 万次/s**（500 会话，20k 次 9.74ms）。
- **derive_messages**：约 **7000 次/s**（400 事件日志，2k 次 283.7ms）。
- **dispatch（管线 miss 路径）**：约 **124 万次/s**（20k 次 16.1ms）。

基准用 std::time::Instant，未引入 criterion；阈值 <30s 保证不进 CI 卡顿。可 `cargo test -- --nocapture` 查看完整 [bench] 行。

## 四、遗留

- **WatchdogPlugin.mount 无自旋守卫**：多次重复 mount 重复 spawn 巡检循环；当前上下文只 mount 一次，记档为后续可选加固（AtomicBool once-guard）。
- **benchmark 以 debug 构建测得**：量级用于横向对比；如需权威数字可 cargo test --release。
- **会话删除的一端**：remove/purge 为独立 API；未来若加「整会话回收」编排，应同时调 registry.remove + mailbox.purge。
- **InMemorySessionLog 无长度上限**：单会话日志极长时 derive/内存随事件数线性；若真实会话可能超百万事件，建议滚动/裁剪（本轮不改，属设计）。

## 红线自查
- [x] 审计可读全仓；代码改动仅限「真泄漏」最小修复 + 新增测试。
- [x] cargo build --workspace ✅ · cargo test --workspace ✅（131 测试全绿，exit 0）。
- [x] 未引入新依赖（基准用 std::time；未 cargo add/remove）。
- [x] 未改功能语义；未动 root Cargo.toml / ARCHITECTURE.md。
- [x] 无 git 写操作（仅 3 个源码文件改动，可 `git checkout -- <文件>` 回滚）。
- [x] 构建前查负载（窗口期 1min 负载均 <2，远低于 20）。
- [x] 文件属主 celestea:celesdev。
