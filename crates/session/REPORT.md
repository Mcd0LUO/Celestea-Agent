# celestea-session — Implementation Report (W102 baseline + W184 extension)

## 变更（Changes）

### W102 baseline（保留未动）
- crates/session/src/lib.rs 中 InMemorySessionLog（单会话 append-only + derive_messages）及其全部 8 个既有测试原样保留，语义与实现未改动。
- 原实现要点：RwLock<Vec<SessionEvent>> 内部可变性；append/clear 写锁、events/derive_messages 读锁；连续 ToolCall 合并为单条 assistant 消息；锁中毒时优雅降级（写入忽略/读取返回空）。

### W184 扩展（本次变更）
- 新增 SessionRegistry（多会话注册表，B1 seam）：
  - create(SessionSpec) -> 唯一 session id（session-<n>，原子计数器）；每个子会话内部使用现有 InMemorySessionLog（Arc 共享）。
  - register(Arc<Session>)：外部构建会话登记，重复 id 报 RegistryError::DuplicateId。
  - get(id) / list() / len() / is_empty()。
  - resolve(target)：session id 直取；否则按 title/workspace 精确匹配——唯一命中取该会话、多命中返回 ResolveError::Ambiguous{target, candidates}（候选清单）、未命中返回 ResolveError::NotFound。
- 新增 SessionMailbox（按会话定向 FIFO 队列 + 唤醒通知，B2 seam）：
  - send(session_id, content, from_label) -> MailboxMessage：入队（懒建队列，未知会话也允许入队=入队不保证被消费）+ tokio::sync::Notify::notify_waiters 唤醒等待者。
  - recv(session_id)（async，阻塞等到下一条，FIFO；先建 notify future 再查队列的免丢失唤醒模式）。
  - try_recv / poll（非阻塞弹出/排空）、pending / pending_total。
  - 队列按 session id 分桶；notify_waiters 唤醒全部已注册等待者、各自复查自己的队列，避免跨会话吞信号。
- 新增类型：SessionId（类型别名）、SessionMeta、Session、SessionSpec、RegistryError、ResolveError、MailboxMessage。
- 线程安全：全部状态在 RwLock + 原子计数器 + Arc 之后；Send + Sync 有编译期断言测试。
- crates/session/Cargo.toml：新增 tokio.workspace = true（工作区已含 tokio 1.53 full，无新外部 crate；未使用 cargo add/remove，手写依赖行）。
- 新增 16 个单测（multi_session_tests）：create/get 往返、50 个 id 唯一性、register 重复拒绝、resolve 四态（id 直取/标题唯一/workspace/多命中候选/未命中）、mailbox FIFO send/recv、recv 唤醒、try_recv/poll 非阻塞、未知会话入队保留、8 线程并发 send 800 条、Send+Sync 断言、注册会话内嵌 log 可用（与 InMemorySessionLog 共存）。

## 验证（Verification）
- 构建前查负载：load average 1.08（远低于 20 阈值）。
- cargo build -p celestea-session：通过（exit 0，无警告）。
- cargo test -p celestea-session：24 passed, 0 failed, 0 ignored：
  - tests::（W102 既有 8 个，全部保留通过）：new_is_empty / append_events_preserves_order / derive_messages_roundtrip / consecutive_tool_calls_merge_into_single_message / tool_calls_flush_before_following_non_tool_event / tool_result_with_empty_error_falls_back_to_value / clear_empties_log / log_is_send_sync。
  - multi_session_tests::（W184 新增 16 个）：registry_create_get_roundtrip / registry_create_generates_unique_ids / registry_register_and_reject_duplicate / registry_resolve_by_id_direct / registry_resolve_by_title_unique / registry_resolve_by_workspace / registry_resolve_ambiguous_returns_candidates / registry_resolve_miss_is_not_found / registry_list_returns_all_metas / mailbox_send_recv_fifo / mailbox_recv_wakes_on_send / mailbox_try_recv_and_poll_non_blocking / mailbox_unknown_session_send_stays_queued / mailbox_concurrent_sends_from_threads / multi_session_types_are_send_sync / registered_session_log_works_within_registry。
- 只构建 celestea-session（红线要求）。

## 回滚（Rollback）
- 变更全部集中在 crates/session/：git -C /src/celestea_harness checkout -- crates/session/ 即完全恢复（Cargo.toml、src/lib.rs、REPORT.md 一并还原）。
- 无其它 crate / root Cargo.toml / ARCHITECTURE.md 改动，无需额外回滚动作。

## 遗留（Open items）
- SessionMailbox 未实现「发送时是否有等待消费者」的 delivered 标记（B2 工具层返回 {ok, delivered} 时可选增强：在 recv 进入等待/退出处维护 waiter 计数即可）。
- 会话持久化：当前全部内存态（沿用 W102 语义）；B 块设计保留持久化 seam，未实现。
- 跨 registry 实例的 id 唯一性仅保证单实例内唯一（进程内单 registry 场景足够）；如需全局唯一可换 uuid/时间戳方案（不新增依赖的前提下可用 hash）。
- 上层接线（crates/workers 或 tools 的 spawn_worker / session_send_message 工具 + 看门狗 Plugin）属于后续任务，本任务只交付注册表与信箱两个基础 seam。

## What was NOT changed
- Root Cargo.toml、ARCHITECTURE.md、crates/core/、crates/llm/、crates/cli/、crates/tools/、crates/agent-loop/ 均未改动（仅 crates/session/ 内变更）。


## W210 扩展（本次变更：session v1 持久化）

### 变更（Changes）
- 新增 crates/session/src/persistent.rs：[PersistentSessionLog]（v1 持久化变体，celestea-session 无新外部依赖）：
  - 落盘：append-only JSONL 事件日志，每 session 一个文件 <dir>/<sanitized-id>.jsonl（如 ~/.celestea/sessions/session-0.jsonl）；open(dir, session_id) / open_with(dir, session_id, PersistentOptions) 创建/打开；一条记录 = 一行 serde_json，追加写。
  - flush：默认每条 append 后 flush（进程崩溃不丢记录）；flush_each_append=false 走批量 + 显式 flush()/sync()（定期 flush）；Drop 时 best-effort flush（关闭时 flush）；sync_each_append=true 每条 sync_data（防断电）。
  - 恢复：open 时逐行重放记录重建内存视图；derive_messages 语义与 InMemorySessionLog 完全一致（共用 log.rs 的 derive_messages_from 投影）。
  - 崩溃安全：追加写 + 校验——重放保留最长有效前缀，从第一条不可解析记录（典型：崩溃半条尾记录）起截断文件；打开时若文件末字节非 \n 先补一个换行分隔符，防止下一条记录与未终止的尾记录合并成一行。
  - 不变量：磁盘顺序 == 内存顺序（同一把写锁保护镜像与写盘）；写失败优雅降级（事件保留在内存视图、write_error_count() 计数、stderr 告警）。
- log.rs：抽出 pub(crate) derive_messages_from(&[SessionEvent]) 共享投影，InMemorySessionLog::derive_messages 改为委托（行为不变，8 个 W102 既有测试原样通过）。
- lib.rs：注册 persistent 模块并 re-export。
- CLI 最小切换点（crates/cli/src/config.rs compose）：读环境变量 CELESTEA_SESSION_DIR；设置时宿主会话改用 PersistentSessionLog::open(dir, "cli-main")（启动重放 + 追加），未设置或打开失败一律回退 InMemorySessionLog（默认行为不变）。

### 开启方式（How to enable）
- CLI：export CELESTEA_SESSION_DIR=~/.celestea/sessions 后运行 celestea —— 宿主会话持久化到 ~/.celestea/sessions/cli-main.jsonl，重启自动重放续接；不设该变量行为与之前完全一致（InMemory）。
- 代码：celestea_session::PersistentSessionLog::open(dir, session_id) 得到 Arc<dyn SessionLog> 直接使用；PersistentOptions { flush_each_append, sync_each_append } 可选调优。关联便利函数 file_path/file_name_for。

### 验证（Verification）
- cargo test -p celestea-session：41 passed, 0 failed —— 既有 30 个全保留 + 新增 11 个持久化/恢复测试（open 建文件即空；append→落盘→重启重放同历史，事件 JSON 与 derive 投影逐一相等；崩溃半条尾记录截断恢复；中部损坏保留最长有效前缀；clear 截断文件后继续可用；批量模式 flush 后可见；与 InMemorySessionLog 投影一致性含 tool-call 合并；空行/末记录无换行容忍 + 追加分隔符修复；session id 消毒为安全文件名防路径穿越；8 线程 400 并发 append 全量落盘且重放顺序 == 追加顺序；Send+Sync 编译期断言）。
- cargo test --workspace：全绿 —— agent-loop 12 / cli 90 / core 18 / llm 17 / session 41 / tools 11 / workers 24，0 failed。
- cargo build -p celestea-cli：无警告。

### 回滚（Rollback）
- git -C /src/celestea_harness checkout -- crates/session crates/cli 即恢复全部改动；新增的 crates/session/src/persistent.rs 是 untracked 文件，需单独删除（rm crates/session/src/persistent.rs）。

### 遗留（Open items）
- 单进程模型：未做多进程 append 同一文件的文件锁（v1 文档已注明 each session = one file, single writer）。
- 磁盘写失败仅降级计数（write_error_count + stderr），未做重试/告警通道。
- Worker 会话（SessionRegistry::create 的 InMemorySessionLog）本轮未接持久化；CLI 宿主会话已可通过 CELESTEA_SESSION_DIR 开关。
