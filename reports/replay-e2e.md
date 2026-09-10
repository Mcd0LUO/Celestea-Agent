# P5 双跑对拍报告（replay:e2e）

- 生成时间：2026-09-10T14:56:06.128Z
- fixtures：`/src/celestea_studio-ts/fixtures`（导出时间 2026-09-09T17:28:54.740Z）
- 探针输入：`P5 重放探针`（真实 agent-loop + 离线 mock LLM，禁真网）

## 结论

| 指标 | 值 |
|---|---|
| 回放会话数 | 5 |
| 比对项（findings） | 77 |
| 一致 | 75（其中逐字节 52 / Rust 黄金 15） |
| **差异** | **0** |
| 跳过（结构性说明） | 2 |
| harness 错误 | 0 |
| 结论 | match |

## 会话总览

| 会话 | roles | events | turns | 比对项 | 差异 | 结论 |
|---|---|---|---|---|---|---|
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 | session-log, cancelled-outcome | 6 | 1 | 15 | 0 | match |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 | session-log, error-outcome | 3 | 1 | 15 | 0 | match |
| CelesteaTeamAPI/test-1788787479.196315272 | session-log, run_code-parent-id, normal-multi-turn | 53 | 6 | 15 | 0 | match |
| celestea_harness/harness架构哥-1788933931.279221103 | session-log, dangling-tool-call, run_code-parent-id, cancelled-outcome, error-outcome | 606 | 17 | 17 | 0 | match |
| server-center/center-架构师-1788940601.93642104 | session-log, normal-multi-turn, error-outcome | 967 | 7 | 15 | 0 | match |

### 已逐字节一致项（52）

| scope | 证据类别 | 说明 |
|---|---|---|
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: session-log-jsonl | 逐字节 | replay -> re-serialize: 768 bytes identical (sha256 05ea06870091) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: session-log-file | 逐字节 | replay kept the file untouched: 768 bytes identical (sha256 05ea06870091) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: session-log-replay | 逐字节 | 6 event(s), no torn tail, next turn id turn-1 |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: sse-transport | 逐字节 | GET /api/events replayed stored golden transcript frames: 6 wire block(s) byte-identical (envelope order turn,seq,payload) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-append-bytes | 逐字节 | appended turn is exactly its serialized events: 969 bytes identical (sha256 88891d790f28) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-append-shape | 逐字节 | appended turn shape: 4 item(s) identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-answer | 逐字节 | offline answer: value identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-outcome | 逐字节 | terminal outcome: value identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-sse | 逐字节 | turn frames status>text>done>turn_end>status |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: compact-log | 逐字节 | log untouched (history below threshold): 969 bytes identical (sha256 88891d790f28) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: session-log-jsonl | 逐字节 | replay -> re-serialize: 270 bytes identical (sha256 b7832af1e3f2) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: session-log-file | 逐字节 | replay kept the file untouched: 270 bytes identical (sha256 b7832af1e3f2) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: session-log-replay | 逐字节 | 3 event(s), no torn tail, next turn id turn-1 |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: sse-transport | 逐字节 | GET /api/events replayed stored golden transcript frames: 3 wire block(s) byte-identical (envelope order turn,seq,payload) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-append-bytes | 逐字节 | appended turn is exactly its serialized events: 471 bytes identical (sha256 270b767f3170) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-append-shape | 逐字节 | appended turn shape: 4 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-answer | 逐字节 | offline answer: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-outcome | 逐字节 | terminal outcome: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-sse | 逐字节 | turn frames status>text>done>turn_end>status |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: compact-log | 逐字节 | log untouched (history below threshold): 471 bytes identical (sha256 270b767f3170) |
| CelesteaTeamAPI/test-1788787479.196315272 :: session-log-jsonl | 逐字节 | replay -> re-serialize: 20591 bytes identical (sha256 f49df2d4560d) |
| CelesteaTeamAPI/test-1788787479.196315272 :: session-log-file | 逐字节 | replay kept the file untouched: 20591 bytes identical (sha256 f49df2d4560d) |
| CelesteaTeamAPI/test-1788787479.196315272 :: session-log-replay | 逐字节 | 53 event(s), no torn tail, next turn id turn-7 |
| CelesteaTeamAPI/test-1788787479.196315272 :: sse-transport | 逐字节 | GET /api/events replayed stored golden transcript frames: 53 wire block(s) byte-identical (envelope order turn,seq,payload) |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-append-bytes | 逐字节 | appended turn is exactly its serialized events: 20792 bytes identical (sha256 787868b3a0cb) |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-append-shape | 逐字节 | appended turn shape: 4 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-answer | 逐字节 | offline answer: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-outcome | 逐字节 | terminal outcome: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-sse | 逐字节 | turn frames status>text>done>turn_end>status |
| CelesteaTeamAPI/test-1788787479.196315272 :: compact-log | 逐字节 | log untouched (history below threshold): 20792 bytes identical (sha256 787868b3a0cb) |
| celestea_harness/harness架构哥-1788933931.279221103 :: session-log-jsonl | 逐字节 | replay -> re-serialize: 1041745 bytes identical (sha256 eff6eab2ea58) |
| celestea_harness/harness架构哥-1788933931.279221103 :: session-log-file | 逐字节 | replay kept the file untouched: 1041745 bytes identical (sha256 eff6eab2ea58) |
| celestea_harness/harness架构哥-1788933931.279221103 :: session-log-replay | 逐字节 | 606 event(s), no torn tail, next turn id turn-17 |
| celestea_harness/harness架构哥-1788933931.279221103 :: sse-transport | 逐字节 | GET /api/events replayed TS-derived frames: 603 wire block(s) byte-identical (envelope order turn,seq,payload) |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-append-bytes | 逐字节 | appended turn is exactly its serialized events: 1041948 bytes identical (sha256 af4fe83c55ba) |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-append-shape | 逐字节 | appended turn shape: 4 item(s) identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-answer | 逐字节 | offline answer: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-outcome | 逐字节 | terminal outcome: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-sse | 逐字节 | turn frames status>text>done>turn_end>status |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-log | 逐字节 | independent re-derivation of the W259 plan: 45855 bytes identical (sha256 cb043e253f75) |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-backup | 逐字节 | .precompact backup of the pre-compaction log: 1041948 bytes identical (sha256 af4fe83c55ba) |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-kept-turn-bodies | 逐字节 | kept turns are byte-identical apart from renumbering: 4 item(s) identical |
| server-center/center-架构师-1788940601.93642104 :: session-log-jsonl | 逐字节 | replay -> re-serialize: 1748650 bytes identical (sha256 84ab09aa53c2) |
| server-center/center-架构师-1788940601.93642104 :: session-log-file | 逐字节 | replay kept the file untouched: 1748650 bytes identical (sha256 84ab09aa53c2) |
| server-center/center-架构师-1788940601.93642104 :: session-log-replay | 逐字节 | 967 event(s), no torn tail, next turn id turn-7 |
| server-center/center-架构师-1788940601.93642104 :: sse-transport | 逐字节 | GET /api/events replayed TS-derived frames: 967 wire block(s) byte-identical (envelope order turn,seq,payload) |
| server-center/center-架构师-1788940601.93642104 :: turn-append-bytes | 逐字节 | appended turn is exactly its serialized events: 1748851 bytes identical (sha256 d28ed510068c) |
| server-center/center-架构师-1788940601.93642104 :: turn-append-shape | 逐字节 | appended turn shape: 4 item(s) identical |
| server-center/center-架构师-1788940601.93642104 :: turn-answer | 逐字节 | offline answer: value identical |
| server-center/center-架构师-1788940601.93642104 :: turn-outcome | 逐字节 | terminal outcome: value identical |
| server-center/center-架构师-1788940601.93642104 :: turn-sse | 逐字节 | turn frames status>text>done>turn_end>status |
| server-center/center-架构师-1788940601.93642104 :: compact-log | 逐字节 | log untouched (history below threshold): 1748851 bytes identical (sha256 d28ed510068c) |

### Rust 黄金一致项（15）

| scope | 证据类别 | 说明 |
|---|---|---|
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: messages-projection | Rust 黄金 | GET /api/sessions/{id}/messages (200): 4 item(s) identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: compact-response | Rust 黄金 | skip branch: value identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: compact-sse | Rust 黄金 | compact frame: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: messages-projection | Rust 黄金 | GET /api/sessions/{id}/messages (200): 1 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: compact-response | Rust 黄金 | skip branch: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: compact-sse | Rust 黄金 | compact frame: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: messages-projection | Rust 黄金 | GET /api/sessions/{id}/messages (200): 41 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: compact-response | Rust 黄金 | skip branch: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: compact-sse | Rust 黄金 | compact frame: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: messages-projection | Rust 黄金 | GET /api/sessions/{id}/messages (200): 575 item(s) identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-response | Rust 黄金 | compacted branch: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-sse | Rust 黄金 | compact frame: value identical |
| server-center/center-架构师-1788940601.93642104 :: messages-projection | Rust 黄金 | GET /api/sessions/{id}/messages (200): 953 item(s) identical |
| server-center/center-架构师-1788940601.93642104 :: compact-response | Rust 黄金 | skip branch: value identical |
| server-center/center-架构师-1788940601.93642104 :: compact-sse | Rust 黄金 | compact frame: value identical |

### 独立重推导 / 自洽校验一致项（8）

| scope | 证据类别 | 说明 |
|---|---|---|
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: engine-derive-messages | 自洽校验 | engine model-visible history: 3 item(s) identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: sse-transcript | 自洽校验 | TS-derived transcript (Rust capture is a P6 gap): 6 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: engine-derive-messages | 自洽校验 | engine model-visible history: 1 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: sse-transcript | 自洽校验 | TS-derived transcript (Rust capture is a P6 gap): 3 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: engine-derive-messages | 自洽校验 | engine model-visible history: 18 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: sse-transcript | 自洽校验 | TS-derived transcript (Rust capture is a P6 gap): 53 item(s) identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: engine-derive-messages | 自洽校验 | engine model-visible history: 373 item(s) identical |
| server-center/center-架构师-1788940601.93642104 :: engine-derive-messages | 自洽校验 | engine model-visible history: 628 item(s) identical |

## 差异清单与原因

**无差异**：所有比对项一致。

## P6 前还差什么

- compact 后日志：TS 侧与「独立重推导（spec-derived）」逐字节一致，但 Rust 实机 compact 产物尚未捕获 —— P6 需在 Rust 侧用打桩上游（非流式摘要）跑一次 compact，导出 compact-expected.jsonl 作为真黄金。
- SSE 序列：逐帧对比的黄金是 TS 自推导 transcript（P0 导出器生成），fixtures/sse/live-capture.raw.txt 为 0 字节（P0 禁止 POST /api/turn）—— P6 需驱动一次 Rust 真实 turn 抓取 live SSE（8 事件 + lagged 降级），并把 JSONL transcript 换成 Rust 原生产物。
- LLM 是离线确定性 mock：usage / cache_hit_ratio / context_usage 的数值来自 mock 的 usage 帧，未经真实 provider 的 SSE/usage 解析链路 —— P6 需接 packages/llm 的 mock-upstream（本地假上游，仍禁真网）验证解析与状态线口径。
- live/*.json（Rust 实机只读快照）尚未纳入 e2e 逐字段对拍（本阶段只验形状与口径）—— P6 把 status/config/tools/health 快照纳入逐字段对比。
- worker 编排：spawn/send/status 走真实 registry 且 driven=true，但表是内存实现（tsvPath=null，不写共享 registry.tsv），receipt/report 文件协议未对拍 —— P6 与 Rust 的 registry.tsv / WORKER_<wid>_DONE 回执对拍。
- compact 摘要正文由 mock 生成，只做结构性校验（头部轮、保留轮、重编号、备份）—— P6 接入真实/打桩摘要后再逐字节对拍摘要正文。
- 大 fixture 的 SSE 采用分批推送（每批 < 总线容量 512），未覆盖容量溢出后的 lagged 降级 —— 该路径由 apps/studio/src/sse.test.ts 覆盖，P6 需在 e2e 中补一条真机溢出用例。

## 全部比对项

| scope | 证据类别 | 结论 | 说明 |
|---|---|---|---|
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: session-log-jsonl | 逐字节 | 一致 | replay -> re-serialize: 768 bytes identical (sha256 05ea06870091) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: session-log-file | 逐字节 | 一致 | replay kept the file untouched: 768 bytes identical (sha256 05ea06870091) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: session-log-replay | 逐字节 | 一致 | 6 event(s), no torn tail, next turn id turn-1 |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: messages-projection | Rust 黄金 | 一致 | GET /api/sessions/{id}/messages (200): 4 item(s) identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: engine-derive-messages | 自洽校验 | 一致 | engine model-visible history: 3 item(s) identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: sse-transcript | 自洽校验 | 一致 | TS-derived transcript (Rust capture is a P6 gap): 6 item(s) identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: sse-transport | 逐字节 | 一致 | GET /api/events replayed stored golden transcript frames: 6 wire block(s) byte-identical (envelope order turn,seq,payload) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-append-bytes | 逐字节 | 一致 | appended turn is exactly its serialized events: 969 bytes identical (sha256 88891d790f28) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-append-shape | 逐字节 | 一致 | appended turn shape: 4 item(s) identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-answer | 逐字节 | 一致 | offline answer: value identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-outcome | 逐字节 | 一致 | terminal outcome: value identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: turn-sse | 逐字节 | 一致 | turn frames status>text>done>turn_end>status |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: compact-log | 逐字节 | 一致 | log untouched (history below threshold): 969 bytes identical (sha256 88891d790f28) |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: compact-response | Rust 黄金 | 一致 | skip branch: value identical |
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 :: compact-sse | Rust 黄金 | 一致 | compact frame: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: session-log-jsonl | 逐字节 | 一致 | replay -> re-serialize: 270 bytes identical (sha256 b7832af1e3f2) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: session-log-file | 逐字节 | 一致 | replay kept the file untouched: 270 bytes identical (sha256 b7832af1e3f2) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: session-log-replay | 逐字节 | 一致 | 3 event(s), no torn tail, next turn id turn-1 |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: messages-projection | Rust 黄金 | 一致 | GET /api/sessions/{id}/messages (200): 1 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: engine-derive-messages | 自洽校验 | 一致 | engine model-visible history: 1 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: sse-transcript | 自洽校验 | 一致 | TS-derived transcript (Rust capture is a P6 gap): 3 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: sse-transport | 逐字节 | 一致 | GET /api/events replayed stored golden transcript frames: 3 wire block(s) byte-identical (envelope order turn,seq,payload) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-append-bytes | 逐字节 | 一致 | appended turn is exactly its serialized events: 471 bytes identical (sha256 270b767f3170) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-append-shape | 逐字节 | 一致 | appended turn shape: 4 item(s) identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-answer | 逐字节 | 一致 | offline answer: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-outcome | 逐字节 | 一致 | terminal outcome: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: turn-sse | 逐字节 | 一致 | turn frames status>text>done>turn_end>status |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: compact-log | 逐字节 | 一致 | log untouched (history below threshold): 471 bytes identical (sha256 270b767f3170) |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: compact-response | Rust 黄金 | 一致 | skip branch: value identical |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 :: compact-sse | Rust 黄金 | 一致 | compact frame: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: session-log-jsonl | 逐字节 | 一致 | replay -> re-serialize: 20591 bytes identical (sha256 f49df2d4560d) |
| CelesteaTeamAPI/test-1788787479.196315272 :: session-log-file | 逐字节 | 一致 | replay kept the file untouched: 20591 bytes identical (sha256 f49df2d4560d) |
| CelesteaTeamAPI/test-1788787479.196315272 :: session-log-replay | 逐字节 | 一致 | 53 event(s), no torn tail, next turn id turn-7 |
| CelesteaTeamAPI/test-1788787479.196315272 :: messages-projection | Rust 黄金 | 一致 | GET /api/sessions/{id}/messages (200): 41 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: engine-derive-messages | 自洽校验 | 一致 | engine model-visible history: 18 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: sse-transcript | 自洽校验 | 一致 | TS-derived transcript (Rust capture is a P6 gap): 53 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: sse-transport | 逐字节 | 一致 | GET /api/events replayed stored golden transcript frames: 53 wire block(s) byte-identical (envelope order turn,seq,payload) |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-append-bytes | 逐字节 | 一致 | appended turn is exactly its serialized events: 20792 bytes identical (sha256 787868b3a0cb) |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-append-shape | 逐字节 | 一致 | appended turn shape: 4 item(s) identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-answer | 逐字节 | 一致 | offline answer: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-outcome | 逐字节 | 一致 | terminal outcome: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: turn-sse | 逐字节 | 一致 | turn frames status>text>done>turn_end>status |
| CelesteaTeamAPI/test-1788787479.196315272 :: compact-log | 逐字节 | 一致 | log untouched (history below threshold): 20792 bytes identical (sha256 787868b3a0cb) |
| CelesteaTeamAPI/test-1788787479.196315272 :: compact-response | Rust 黄金 | 一致 | skip branch: value identical |
| CelesteaTeamAPI/test-1788787479.196315272 :: compact-sse | Rust 黄金 | 一致 | compact frame: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: session-log-jsonl | 逐字节 | 一致 | replay -> re-serialize: 1041745 bytes identical (sha256 eff6eab2ea58) |
| celestea_harness/harness架构哥-1788933931.279221103 :: session-log-file | 逐字节 | 一致 | replay kept the file untouched: 1041745 bytes identical (sha256 eff6eab2ea58) |
| celestea_harness/harness架构哥-1788933931.279221103 :: session-log-replay | 逐字节 | 一致 | 606 event(s), no torn tail, next turn id turn-17 |
| celestea_harness/harness架构哥-1788933931.279221103 :: messages-projection | Rust 黄金 | 一致 | GET /api/sessions/{id}/messages (200): 575 item(s) identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: engine-derive-messages | 自洽校验 | 一致 | engine model-visible history: 373 item(s) identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: sse-transcript | 自洽校验 | 跳过 | golden transcript not stored for this session; 603 frame(s) regenerated in-memory |
| celestea_harness/harness架构哥-1788933931.279221103 :: sse-transport | 逐字节 | 一致 | GET /api/events replayed TS-derived frames: 603 wire block(s) byte-identical (envelope order turn,seq,payload) |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-append-bytes | 逐字节 | 一致 | appended turn is exactly its serialized events: 1041948 bytes identical (sha256 af4fe83c55ba) |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-append-shape | 逐字节 | 一致 | appended turn shape: 4 item(s) identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-answer | 逐字节 | 一致 | offline answer: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-outcome | 逐字节 | 一致 | terminal outcome: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: turn-sse | 逐字节 | 一致 | turn frames status>text>done>turn_end>status |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-log | 逐字节 | 一致 | independent re-derivation of the W259 plan: 45855 bytes identical (sha256 cb043e253f75) |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-backup | 逐字节 | 一致 | .precompact backup of the pre-compaction log: 1041948 bytes identical (sha256 af4fe83c55ba) |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-kept-turn-bodies | 逐字节 | 一致 | kept turns are byte-identical apart from renumbering: 4 item(s) identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-response | Rust 黄金 | 一致 | compacted branch: value identical |
| celestea_harness/harness架构哥-1788933931.279221103 :: compact-sse | Rust 黄金 | 一致 | compact frame: value identical |
| server-center/center-架构师-1788940601.93642104 :: session-log-jsonl | 逐字节 | 一致 | replay -> re-serialize: 1748650 bytes identical (sha256 84ab09aa53c2) |
| server-center/center-架构师-1788940601.93642104 :: session-log-file | 逐字节 | 一致 | replay kept the file untouched: 1748650 bytes identical (sha256 84ab09aa53c2) |
| server-center/center-架构师-1788940601.93642104 :: session-log-replay | 逐字节 | 一致 | 967 event(s), no torn tail, next turn id turn-7 |
| server-center/center-架构师-1788940601.93642104 :: messages-projection | Rust 黄金 | 一致 | GET /api/sessions/{id}/messages (200): 953 item(s) identical |
| server-center/center-架构师-1788940601.93642104 :: engine-derive-messages | 自洽校验 | 一致 | engine model-visible history: 628 item(s) identical |
| server-center/center-架构师-1788940601.93642104 :: sse-transcript | 自洽校验 | 跳过 | golden transcript not stored for this session; 967 frame(s) regenerated in-memory |
| server-center/center-架构师-1788940601.93642104 :: sse-transport | 逐字节 | 一致 | GET /api/events replayed TS-derived frames: 967 wire block(s) byte-identical (envelope order turn,seq,payload) |
| server-center/center-架构师-1788940601.93642104 :: turn-append-bytes | 逐字节 | 一致 | appended turn is exactly its serialized events: 1748851 bytes identical (sha256 d28ed510068c) |
| server-center/center-架构师-1788940601.93642104 :: turn-append-shape | 逐字节 | 一致 | appended turn shape: 4 item(s) identical |
| server-center/center-架构师-1788940601.93642104 :: turn-answer | 逐字节 | 一致 | offline answer: value identical |
| server-center/center-架构师-1788940601.93642104 :: turn-outcome | 逐字节 | 一致 | terminal outcome: value identical |
| server-center/center-架构师-1788940601.93642104 :: turn-sse | 逐字节 | 一致 | turn frames status>text>done>turn_end>status |
| server-center/center-架构师-1788940601.93642104 :: compact-log | 逐字节 | 一致 | log untouched (history below threshold): 1748851 bytes identical (sha256 d28ed510068c) |
| server-center/center-架构师-1788940601.93642104 :: compact-response | Rust 黄金 | 一致 | skip branch: value identical |
| server-center/center-架构师-1788940601.93642104 :: compact-sse | Rust 黄金 | 一致 | compact frame: value identical |
