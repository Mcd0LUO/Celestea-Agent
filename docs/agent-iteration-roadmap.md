# Celestea Agent 核心评估与 6–12 个月迭代路线图

> 评估：W246；日期：2026-09-07（UTC+8）。范围：引擎 `/src/celestea_harness`、Studio `/src/celestea_studio`。
> 方法：先读代码与既有评估，再核对依赖图、测试、现有服务只读探针；只产出文档，不修改代码、配置、服务，不 commit、不 push。
> **总判断：保留 Rust 七 crate 与 axum 内嵌模式；先补齐真实终态、资源生命周期、执行权限、会话隔离、事件恢复，再发展可恢复多 agent 和扩展生态。目前是能力完整度较高的单机原型，不宜直接定义为可靠的多租户 Agent 平台。**

## 1. 证据范围、版本与验证结果

### 1.1 版本与现场变化

| 对象 | 基线 | 说明 |
|---|---|---|
| 引擎 | `8004efbb80bf740197423441e756b463fbf91479` | 开始工作树干净；7 个 library crate，无 CLI binary target。 |
| Studio 起始 | `61839f73d7af8398462b89fafc34da7d1ee35a95` | 当时 `src/{api,main,workspaces}.rs` 已修改、`src/prompts.rs` 未跟踪，均非本任务改动。 |
| Studio 收口 | `ef0d698a6798fd871ac42bcc79f4027af4505567` | 评估期间其他任务于22:13提交提示词后端；收口工作树干净。本文提示词结论以此版本为准。 |
| 运行面 | `celestea-studio.service` active/running、Restart=always | 本次只读查看；现有 `127.0.0.1:3777` 的 `/`、`/api/health`、`/api/prompts?workspace=` 均HTTP 200。**不据此认定UI/模型链路端到端验收完成。** |

证据分级：**源码事实**＝沿实际调用链核对；**本次验证**＝命令实际成功；**静态风险**＝能指出缺失机制与触发路径，但未进行线上故障复现；**待核验**＝缺运行证据。旧报告推测的毫秒数不当本次实测。

### 1.2 读取范围

- 引擎：Cargo.toml与七crate依赖元数据、README.md、ARCHITECTURE.md、docs/backend-optimization-eval.md；core全部契约；session日志/回放/registry/mailbox；llm请求/SSE/消息映射；agent-loop主循环/trim/Usage；runtime装配/配置/run/summary；tools文件工具/guard/HTTP/process/沙箱provider与执行路径；workers工具/registry/驱动/回执/watchdog/plugin及相关测试。
- Studio：Cargo.toml、src/{main,api,providers,workspaces,prompts}.rs核心生产路径；前端main/chat/sse/api/types与ui/{restore,messages,prompts}，会话/设置接线；frontend/package.json、FRONTEND-RULES.md、启动脚本；docs/{backend-language-eval,frontend-session-persistence-eval,prompt-injection-eval}.md。
- Studio专项另经一名只读审阅者交叉确认，scope、编辑回填、SSE、事务判断一致；引擎工具/worker由主评估直接核验。
- 未读取生产凭据或会话正文；未调用付费模型、修改网关渠道、做攻击演示/压测；未做浏览器交互、跨平台发布验证。

### 1.3 本次验证

1. cargo metadata（offline/locked/no-deps）：7个library target，内部依赖无环。
2. 引擎使用共享缓存、低并发、串行测试：`CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup CARGO_BUILD_JOBS=2 nice -n 10 cargo test --workspace --offline --locked -j 2 -- --test-threads=1`；PATH显式使用`/opt/rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin`，清除CELESTEA_SESSION_DIR。
   **退出0：agent-loop 25、core 22、llm 34、runtime 62、session 41、tools 46、workers 42，合计272 passed/0 failed；各crate doc-test为0。** 一个测试辅助函数dead_code warning。部分沙箱capability测试条件不足直接return（sandbox.rs:1936–2045）仍计passed，因此不能推定所有OS隔离路径实际执行。
3. 首次cargo不在PATH；绝对路径解决。首次引擎测试默认Cargo home找不到aws-lc-rs 1.18.0而退出101，定位共享CARGO_HOME后成功，不是代码失败。
4. Studio Rust测试**退出101、未执行测试**：离线索引无法解析锁定toml 1.1.5+spec-1.1.0；包归档存在，索引候选缺版本。本任务不改lockfile、不联网更新索引。源码39个测试属性只作计数。
5. `pnpm --dir frontend typecheck` **退出0**；不重建使用中的frontend/dist，不把typecheck等同UI/Vite验收。
6. 其他任务构建窗口结束才执行本次测试，未启动替代服务器。Rust 1.98.0、pnpm 11.22.0。

## 2. 独立校验架构师汇报

路径默认引擎仓根；S:表示Studio仓根。同一证据格内后续省略目录的文件继承前一个目录；正文中crate模块简写（如llm/client.rs）对应crates/llm/src/client.rs。

| 汇报项 | 校验与修正 | 证据 |
|---|---|---|
| 七crate与Context/Plugin/Llm/SessionLog/Tool/AgentLoop/runtime | 成立；Profile精确**12键**。runtime默认窗口1,000,000、core默认65,536，默认值分歧。 | crates/core/src/{context,llm,tool,agent,session_log}.rs；crates/runtime/src/config.rs:15–79 |
| OpenAI兼容流式、reasoning_content、Usage | 成立，但仅Chat Completions协议真正实现；stream无错误/finish_reason通道；Usage内存累计非账本。 | crates/core/src/message.rs:116–145；crates/llm/src/client.rs:130–318,435–489 |
| JSONL逐事件落盘/回放 | 成立但默认flush非fsync；append无Result，失败内存降级，open失败亦回退内存。回放已逐行读但全量物化Vec。 | crates/session/src/persistent.rs:40–54,105–146,181–234,311–351；runtime/src/compose.rs:97–119 |
| 80% trim、max_steps=0无限 | 引擎成立；Studio启动floor=4096，接口拒绝0和低于4096。trim不压缩语义/回收日志，不计schema和输出预留，大最新turn仍可能超窗。 | crates/agent-loop/src/loop.rs:214–254、context.rs:90–159；S:src/main.rs:1087–1091、api.rs:309–318 |
| 9工具、shell三层、后台进程、HTTP guard | 数量/机制成立但安全口径应缩窄：只有shell经OS layer，文件工具直达宿主；bwrap共享网络、默认宿主/tmp可写、seccomp默认关；v1降级不保持同等rlimit。HTTP约束不是SSRF授权。 | crates/tools/src/builtin.rs:29–61、sandbox.rs:450–515,561–665,1299–1318、http.rs:39–47,79–182 |
| worker闭环、报告+回执、宿主drain | 正常路径成立；仅report_to非空且brief首轮后机械回执，答复约200字摘要。loop Ok不等于任务成功，报告写失败仍可DONE+warn。 | crates/workers/src/registry.rs:269–438,570–575；crates/runtime/src/run.rs:63–82 |
| worker model/provider/workspace | 元数据已存，执行配置未落实：仍复用宿主Llm/AgentLoop/ToolRegistry，未按参数换模型/cwd/policy。 | crates/workers/src/tools.rs:180–247、registry.rs:274–291 |
| registry proc/in-turn/idle/watchdog | 字段成立，但同PID多Runtime无隔离、全表读改写无事务；Runtime/Studio未见生产WatchdogPlugin::mount/tick，不能认定自动重派已启用。 | crates/workers/src/registry.rs:56–94,160–205,465–485；runtime/src/compose.rs:121–183；S:src/main.rs:1129–1211 |
| Studio文件夹工作区、独立会话可切换 | 持久化目录与切换成立；仍是单活跃Gen+busy，并非每会话常驻执行器；cli-main是Runtime内固定地址，不等于产品层全局主会话。 | S:src/main.rs:301–405、workspaces.rs:1323–1373 |
| provider管理/默认模型热切 | Chat Completions热切成立，responses/anthropic_messages仅存储展示；activate只换model，不重解析provider/key；无model会话继承当前Gen而非明确默认层级。 | S:src/providers.rs:238–248,546–619、workspaces.rs:1338–1359 |
| mailbox自动唤醒/SSE/历史恢复 | 已接线，但busy检查占位两次锁、重入队改变FIFO；旧回执可能入新会话或留旧队列；SSE前端丢seq/turn，无重连重放。启动恢复已实现。 | S:src/main.rs:892–1005；frontend/src/main.ts:63–68、sse.ts:69–74、ui/restore.ts:173–224 |
| 提示词后端待部署、前端完成 | 已过时：收口后端提交且路由200；四层段覆盖/严格非递归插值成立，但scope/编辑回填/热应用事务有缺口，不能认定验收完成。 | S:src/prompts.rs:293–319,392–524,665–836；frontend/src/api.ts:143–152、ui/prompts.ts:122–261 |
| systemd自愈/网关渠道 | active与Restart=always确认；仅重启进程，不恢复在途任务。网关渠道未调用验证，catalog/GET models不等于可推理。 | 本次只读systemctl/HTTP；S:src/providers.rs |

### 2.1 既有评估取舍

- 保留backend-optimization-eval的深拷贝、锁内落盘、无界日志/mailbox、隐式装配、EventBus休眠、双工具注册问题。
- 更新“worker无消费者”：当前有recv循环。“replay改流式”应改检查点/分段/懒加载，已经逐行读取。旧每turn 2–3次clone低估：**每模型step**都有，Studio每2秒统计也会clone。
- 纠正“无Arc环”：实际runtime组合有`WorkerRegistry → ToolRegistryService → WorkerTool → WorkerRegistry`强环，不能只看Context反向引用。
- 按文件行数拆分降至P1随行为修复实施；2000行本身不应排在伪成功、权限或数据丢失之前。
- prompt-injection-eval实际是**装配机制**评估，不是恶意提示注入防御审计；严格插值不解决网页/文件/worker消息的信任混淆。
- frontend-session-persistence-eval的启动恢复已实现；改进分页与history/live衔接，勿重做。
- 同意backend-language-eval“不换语言”，不接受sidecar无条件先行。先清显式配置/生命周期契约；有第二消费者、独立发布或隔离收益再P2做sidecar，不预占端口。

## 3. 架构强度、seam与弱点

### 3.1 保留结构

```text
core（契约，无内部依赖）
 ├─ llm
 ├─ session
 ├─ tools
 └─ agent-loop
workers → core + session + tools + agent-loop
runtime → 上述六crate（组合根）
Studio → runtime + core（axum/产品策略/TS UI）
```

- 七crate分层适中，无倒向依赖；Fake可替换，272测试是可用资产，不支持语言重写/微服务化。
- 日志→模型历史单源，内存/磁盘共用投影，连续ToolCall聚合、结果顺序确定；缓存必须是可重建派生物。
- EventSink、取消接点、ToolOutput.value/render/decision分离利于消费方；补语义，不重做loop。
- 内部worker机械报告降低模型格式遵从依赖，Notify优于空轮询；继续内部完善，不建DSH桥。
- Gen原子交换、前端离屏/防闪烁有基础，局部修竞态与事务比换框架合理。

| seam | 强度 | 边界/缺口 |
|---|---|---|
| Context/Plugin | 极小、可patch/scoped | 缺依赖/冲突/装配校验/unmount；先装配清单和shutdown，勿上通用动态插件框架。 |
| Llm/Message | 单入口/fixture | 错误/终态/capability/结构化内容不足；协议归core/llm，Studio不解析供应商流。 |
| SessionLog | 单源/回放 | 无append/clear确认，缺seq/schema/watermark；失败、取消、预算耗尽无法完整重建。 |
| Tool/Guard | 统一dispatch/Ask/Deny | 生产未接guard，Ask只是error非审批暂停；ToolInput缺session/turn/权限身份。 |
| WorkerRegistry | 寻址/驱动/视图 | 存储/路由/报告/监督混居；收口Supervisor生命周期，存储/投递保窄接口。 |
| EventBus/NamedRegistry | 可扩展原语 | EventBus无退订无生产接线，先experimental/frozen；NamedRegistry O(n)不是当前热点。 |
| Runtime/Studio | facade/产品层 | env/cwd/固定路径和具体workers类型泄漏，改RuntimeOptions/SessionHandle。 |

### 3.2 P0风险：先于新增能力

#### R1 伪成功与生命周期不完整

源码事实（未线上故障注入）：llm/client.rs:201–318中流错误后仍Done，core/message.rs:135的stream item无Result，finish_reason未建模；残缺参数仍尝试成为ToolCall。agent-loop/loop.rs:264,273–276生成失败直接return缺TurnEnd；219–221步数耗尽仍Ok，runtime/run.rs:75–82标Completed。make_loop每次重建计数，宿主turn id重复turn-0。工具步assistant正文只emit（loop.rs:310–338），取消批次会留缺ToolResult的调用。

后果：worker机械DONE、watchdog的starts>ends活性和Studio completed互相矛盾。先统一Completed/Failed/Cancelled/BudgetExhausted与中断结果，再加重试。

#### R2 强引用环、资源不释放、换代失联

runtime/tools.rs:16–26把持Arc<WorkerRegistry>的WorkerTool注册进tools；runtime/compose.rs:176–180又将tools强引用存workers（workers/registry.rs:27–29,133–147），**不spawn也成环**。JoinSet任务再捕获Arc<WorkerRegistry>（295–305）。abort_all停任务不解除tools环，生产无shutdown/abort_all接线。

Studio每次改模型/提示词/activate重新compose，旧workers/tools/ProcessRegistry可能存活，新Gen只消费新mailbox。不能靠ProcessRegistry::drop宣称Runtime drop必杀净。需同时Weak/服务拆分与cancel→join→释放；不是只补Drop。

#### R3 全工具权限边界缺失

文件工具直达宿主，read/list无大小/条目帽；生产只register无guard。只读根不等于敏感文件不可读。bwrap默认share-net、可写宿主/tmp、seccomp可选；存在bwrap但探测失败时直退userspace，不是所有故障都经raw。OnceLock探测可能把EAGAIN长期缓存。

rlimit失败忽略，userspace/重建v1不保持同等限额；RLIMIT_NPROC属UID维度非任务精确配额。HTTP scheme/5跳/1MiB不是目标授权，缺私网/DNS/重定向外发策略，错误分类再次lookup无独立deadline（http.rs:189–205）。

Studio ui/messages.ts:24–29,85–87将marked输出直交innerHTML，未見净化，模型/历史不可信HTML是潜在XSS面。提示词不能代替工具policy/浏览器净化。

#### R4 Studio配置、会话与事件事务缺口

- main.rs:951–961 autowake两次锁检查/占位，可与POST竞争；重入队尾把A/B变B/A，drain全部不保持原FIFO。
- main.rs:936–969旧代回执送当前Gen，A→B切会话可能串消息；model/provider/key/cwd不应靠全局env维系。
- workspaces.rs:1353–1365失败不回滚env；post_clear:1506–1510无busy门禁，branch缺一致性快照；启动未共用activate的session model覆盖。
- providers.rs:592–603不支持协议仍切model/传新key却可沿用旧URL，应拒绝，避免错发凭据；无key的provider可能继承旧env key。本次未读取密钥/发请求。
- prompt后端None=活跃workspace、空串=global，前端api.ts:143–152吞空串；编辑未回填overrides、保存可清空；load无seq。upsert不hot_apply，delete/default先写盘后busy检查，可409但磁盘已变（prompts.rs:712–836）。
- SSE envelope含turn/seq，前端仅传payload（sse.ts:69–74），chat过滤无效；无cursor/replay，恢复只文本前缀猜测，工具/终态不能可靠对账。

#### R5 多worker非可恢复系统

model/provider/effort/workspace是元数据而非执行配置；主agent与worker共享tools/ProcessRegistry，proc-0无owner，不是worker隔离。TSV rename非事务，read-modify-write可丢更新；同PID多实例seq从0起可碰tmp。proc部分过滤视图，不隔离wid事务。

types.rs:74–79按空白拆extra，brief/path含空格不能无损还原；brief截300字，重派不是原任务。watchdog未生产接线，不能直接补mount：默认results目录与报告不同；活性忽略pending；成果只前缀+.md（W1可能匹配W10）、不查attempt；tick未proc过滤。先区分task attempt与常驻session生命周期。

#### R6 发布契约与源码漂移

`.github/workflows/release.yml:62–79`仍构建`celestea-cli`并打包`celestea`，而metadata确认当前七crate全是library，没有该package/target；按现文件无法完成所述发布。`README.md:24–34`、`ARCHITECTURE.md:120–159`仍推荐已删除CLI。CI只在Linux执行workspace test（`.github/workflows/ci.yml:18–40`），release没有依赖测试job的显式gate。

Studio `Cargo.toml:8–12`依赖绝对`/src/celestea_harness`路径；仓库未见`.github/workflows`，前端package只定义build/typecheck。旧“已有三平台发布矩阵”只能认作脚本存在，不等于当前产物能发布。P0先修真实交付target、相对/固定revision依赖与文档；P1建立双仓兼容和迁移门禁。本次未运行release，也未修改这些文件。

### 3.3 性能与内存

| 优先级 | 热点 | 判断 |
|---|---|---|
| P0止血/P1深化 | 全历史clone/投影/估算 | persistent.rs:228–234、log.rs:61–82每step深拷贝；Studio main.rs:435–483每status亦全量。需versioned投影/tail/range/增量计数。 |
| P0契约/P1 writer | 写锁跨I/O | 同一日志读写阻塞、async线程内同步I/O；不是所有会话共用一锁。单写者+序号+水位+错误通道后批写，不能简单解锁后写破顺序。 |
| P1 | trim潜在O(n²) | context.rs:136–143对多safe cut重复估后缀；改前后缀累计。str.len()是O(1)，不是逐字节扫描。 |
| P1 | 无界日志/冷启动全物化/HTTP全文历史 | trim不回收；Studio workspaces.rs:1487–1495全文件+事件+JSON。前端只显示200条不减后端成本；用checkpoint/分段/分页/artifact。 |
| P0/P1 | task/queue/process容量 | worker/mailbox无界，进程每路512KiB无数量帽；reaper删除终态handle使最终poll不可靠（process.rs:124–141,327–336），需TTL/游标。 |
| P0/P1 | pipe/子进程回收 | timeout仅child.wait，join仍等pipe EOF；后代持pipe可拖住调用；kill_on_drop非整树回收，需总deadline/组或cgroup监督。 |
| P2按测量 | bwrap、SSE小分配、dyn、NamedRegistry | 本次无2–20ms基准证据；不牺牲隔离去池化，先修线性放大与所有权。 |

## 4. 路线原则、资源假设、总排期

保留Rust/axum/七crate/日志单源/trait seam/内部worker，**不建DSH桥**。配置revision（model/prompt/policy）与会话资源（log/mailbox/worker/process）分离。安全靠policy与OS，失败可见、重试有预算/幂等。先单机可靠，不提前引分布式调度、向量库、插件市场或语言重写。

资源假设：**1名Rust＋0.5名TS/集成，另0.25名QA/运维**；1人周=5有效人日，含设计/实现/测试/迁移/评审，另留20%缓冲。

| 阶段 | 时间 | 目标 | 估算 |
|---|---|---|---|
| P0可靠基线 | 第1–2月，首两周止血 | 不伪成功/静默降级/串会话，资源可停，发布可信 | 10–13人周＋缓冲 |
| P1单机平台 | 第3–6月 | 长会话可扩展、worker可恢复、Studio可对账、版本可交付 | 17–22人周＋缓冲 |
| P2条件扩展 | 第7–12月 | 预算内扩协议/工具/多agent，选择独立引擎服务 | 13–19人周＋缓冲、按需裁剪 |

六个月交P0+P1；全年全选40–54人周，加缓冲48–65人周。后端前端并行；**若只有1人兼运维，9–12个月先完成P0+P1，P2至多一主题，不能以更多worker替代维护预算。** 每阶段有退出门，不到月自动升级。

## 5. P0：第1–2月，可靠性/安全基线

目标：可解释、可停止、可验证。首两周优先R1–R4止血，不以机械拆文件阻塞。

| 包 | 关键改动 | 验收（拟定） | 工作量 | 依赖/风险 |
|---|---|---|---|---|
| P0-A 终态/错误 | stream错误/finish reason，唯一session/turn/step，所有退出终态，预算耗尽≠Completed，中断工具闭合，保留工具步正文，compose校验 | error/截流/坏JSON/EOF/取消/预算fixture；每start一终态；残缺调用不执行；回放tool配对 | 2–2.5人周 | 跨core/llm/loop/runtime/Studio契约；兼容读器与过渡映射，勿无版本破坏消费者 |
| P0-B 生命周期/身份 | 断workers/tools及任务强环；shutdown(cancel/join/flush)；instance/session/attempt身份；busy原子占位；旧回执留原会话，过渡期拒绝危险换代 | 100次compose/swap/shutdown Weak失效、task/process回基线；running/idle可停；A回执不入B；并发仅一槽、FIFO | 2–2.5人周 | P0-A；先裁定拒绝/等待/取消，迁移不能悄悄中止在途任务 |
| P0-C 授权/渲染 | 9工具production policy；获准workspace、symlink/文件/目录帽、HTTP目标/外发策略；strict不退v1、限额失败可见；Markdown净化 | 本地mock/临时目录allow/deny/越界/敏感/私网/跳转；拒绝零副作用；无能力strict失败；HTML不执行 | 2–2.5人周 | 需威胁模型；旧运维可能受阻，显式profile例外不全局放权 |
| P0-D Studio/prompt | scope显式、overrides回填/空段/seq；prepare→persist→swap失败无副作用；启动/activate共用model/provider/prompt；拒绝unsupported；step语义；保留SSE信封与resync提示 | scope不互写，改名不丢覆盖；409磁盘/Gen/override不变；A模型→B默认/重启一致；key/URL配对；E2E | 2–3人周 | 协调提示词在途；bypass会话级或显式global；8KB不静默删必需段 |
| P0-E 指标/止血/发布 | Usage/trim/持久化/queue/process指标；status增量计数/tail；10k/100k基准；修失效CLI target/README/ARCHITECTURE；双仓兼容、工具链缓存 | 10k status不clone全payload且计数等价；落盘失败不报durable；非/src干净构建；真实target发布；pass/skip/fail区分 | 2–2.5人周 | P0-A/B；不承诺本期完整异步writer，先固定机器/workload再定SLO |

退出门：R1–R4回归闭合；引擎/Studio单测、前端build/关键E2E过；生产policy与可关停资源真实接线，候选可回滚。未达不扩worker，不宣传强沙箱/可靠重派。

## 6. P1：第3–6月，性能/可恢复多agent/Studio

目标：单机预算内长会话、多会话、多worker运行一周可诊断可恢复。

| 包 | 关键改动 | 验收（拟定） | 工作量 | 依赖/风险 |
|---|---|---|---|---|
| P1-A Session平面 | schema/seq、不可变分段/共享payload、增量投影/token、tail/range；有界单写者批写、accepted/flushed/synced；checkpoint/归档/懒恢复、大结果artifact | 投影等价/并发保序；ENOSPC可见；随机终止合水位；100k不全clone；归档可校验源seq | 4–5人周 | P0-A/E；writer不能无界/简单移flush；备份/兼容读器，中段损坏隔离 |
| P1-B 上下文/能力 | capability表窗口/输出/tools/reasoning/schema；trim前后缀计schema/输出预留；约束/可追溯摘要；超大turn拒绝/降采样；usage真实/估算/未知按主体持久化 | 总预算≤窗口或显式超限；1k/10k/100k非平方级；中英文/大结果fixture；摘要源seq，主/worker成本独立 | 2.5–3人周 | P1-A/P0-A；bytes/4不计费，无usage不伪0；摘要保原文 |
| P1-C Supervisor/投递 | task attempt/session分开；完整brief/配置/manifest持久化、TSV导出/单写者；durable outbox/inbox、ack/去重/重投；深度/并发/时长/token/费用帽；真正worker配置、取消恢复/死信 | duplicate wid不重复；跨实例不覆盖；50逻辑任务≤8并发；重启恢复/明确interrupted；报告失败不DONE；不可逆副作用不重复 | 4–5人周 | P0-A/B/C、P1-A；至少一次+幂等非外部exactly-once；watchdog先对齐再接 |
| P1-D 工具工程 | execution context身份/cancel/policy；edit/patch前置匹配、glob/grep、分页read；统一error/decision/exit/side-effect；process owner/帽/游标/TTL、总deadline覆盖pipe/树 | contract suite；跨worker handle拒绝；终态TTL可读；cancel/后代持pipe/超输出有界；冲突edit不覆盖 | 2.5–3.5人周 | P0-C/B；不追数量；OS/cgroup矩阵，默认获准workspace |
| P1-E Studio数据流 | RuntimeOptions显式路径/凭据引用/policy、去env热改；SessionHandle持资源、config revision分离；DTO单源；分页+checkpoint/seq重同步；防闪烁/焦点/展开态；worker树 | 同会话≤1轮、跨会话全局预算；4视图不串；重连/lagged正确水位，终态不重不丢；200条真实分页；八条铁律 | 2.5–3.5人周 | P0-D、P1-A/C；后端不靠UI seq；cursor含epoch防重启复用 |
| P1-F 测试/发布 | 双仓兼容、migration golden、property/fault tests、专用Linux sandbox runner；性能CI；产物双仓/frontend/schema版本、灰度/恢复 | release gates全绿、关键能力无静默skip；7天soak无任务泄漏；备份恢复/回滚；平台限制明确 | 1.5–2人周 | 全期贯穿；跨平台需用户承诺，同名binary非同安全 |

退出门：达到第8节，联合演练截流＋取消＋进程重启＋浏览器重连＋日志恢复；终态与产物一致。第六月交稳定基线，不强塞P2。

## 7. P2：第7–12月，条件化扩展

目标：在P1基础上扩用途；可选投资组合，不是全部默认开工。

| 包 | 关键改动 | 验收（拟定） | 工作量 | 依赖/风险 |
|---|---|---|---|---|
| P2-A 协议/内容 | 按需Responses/Anthropic、结构化/schema/多模态artifact；capability UI；限流退避/熔断 | 两协议同text/tools/reasoning/usage/cancel/error矩阵；unsupported前拒；重试无重复副作用；仅支持者收多模态 | 3–4人周 | P1-B/D/F；网关授权smoke，catalog非可用；隐私/存储/费用扩大 |
| P2-B 多agent产品 | task graph、暂停/恢复/人工复核；角色权限preset、worktree隔离/冲突检测；成果/费用看板；内部Supervisor | 3类真实任务对照单agent；质量不降且耗时/成功率/返工一项改善；写冲突可处理、成本有帽 | 3–4人周 | P1-C/D/E；先证收益，worker数非质量，不默认自动合并/扩权 |
| P2-C 受控扩展 | 单工具注册入口、plugin manifest/版本/能力/依赖；真实hook才EventBus退订/错误隔离；按需MCP试点 | 一个真实外部工具/宿主不改loop接入；100次mount/unmount归零；不越policy、断连超时有界 | 2–3人周 | P0-B/C、P1-D/F；进程内插件非不可信沙箱，无消费者继续冻结EventBus |
| P2-D 拓扑选择 | 内嵌默认，仅第二客户端/独立发布/隔离需求成立做sidecar；versioned RPC/SSE、鉴权/幂等/shutdown/reconnect | 两形态同conformance；兼容窗口明确；断开不误完成、不自动取消后台任务；可回滚 | 3–5人周 | P1全部+用户决策；端口审批另办，不用旧方案SSE断开=取消turn，cancel显式 |
| P2-E 质量运营 | 任务集/prompt revision A/B、模型/费用回归；LTS候选、SBOM/漏洞/签名/校验和、例程/脱敏trace | 发布可比成功率/成本/p95；两次候选全门禁；资产兼容表一致；不采凭据/默认不留敏感推理正文 | 2–3人周 | P1-F贯穿；真实标注/维护预算，保留期先定 |

退出门：真实用户/量化收益且不损P0/P1。资源紧先P2-A/E；sidecar/MCP/task graph可不做，不为全勾选牺牲可靠性。

## 8. 统一验收基准、依赖与发布门禁

以下**拟定目标，非本次实测**。P0两周内固定参考环境（如隔离4vCPU/8GiB Linux runner/固定Rust参数），记录冷/热缓存、payload、provider模式。FakeLlm分离引擎成本，再经授权模型smoke，不混供应商等待。

| 维度 | 场景/目标 |
|---|---|
| 正确性 | 旧/新投影一致、tool组完整、所有终态/revision可追踪；中段损坏隔离告警、尾撕裂按声明恢复。 |
| 生命周期 | 100次换代+1000次受控取消后task/process回基线；冻结workload30分钟RSS不持续长；7天按存活会话/保留日志归一，不用MB/h掩盖环。 |
| 长会话 | 10k/100k事件约1KiB/条+大结果；status p95≤50ms、最新200条API≤200ms；warm投影预算≤100ms，或相对P0≥3倍改善并记绝对未达原因。 |
| 背压 | 建议每session mailbox≤1000条/8MiB、全局≤64MiB、≤8并发worker/≤16后台process，可配置；超额明确拒绝/排队，不能静默丢或靠OOM。 |
| 取消/工具 | 可见终态p95≤1s（另声明进程grace）；清理建议总≤5s，超时告警/残留标识，不假定killed:true。 |
| 持久化 | accepted/flushed分开；durable终态flush后确认，断电模式sync后确认；背压/ENOSPC/clear错误可见；恢复核seq/hash。 |
| 多agent | 至少一次+ack/去重/重启；attempt验收独立模型自述；spawn参数真出现在请求/cwd/policy快照。 |
| Studio | A/B快切/双标签/重连/lagged/刷新中流/autowake竞争；seq不串终态不重；scope/编辑回填；防闪烁八条过。 |
| 安全 | 临时资源path/symlink/私网/跳转/HTML测试；例外审计；无OS能力不伪装强隔离；远程暴露前鉴权、Origin/CSRF、probe目标策略。 |
| 发布 | 干净checkout、锁工具链依赖、fmt/clippy/test、TS/Vite、迁移/集成/OS矩阵；artifact双仓revision/schema；备份→候选→smoke→灰度→可回滚；restart非任务恢复。 |

```text
终态/身份 P0-A ─┬─ 生命周期 P0-B ─ Supervisor P1-C ─ 多agent P2-B
                ├─ 日志水位 P1-A ─ 游标/重放 P1-E ─ sidecar(可选) P2-D
统一授权 P0-C ──┴─ 工具上下文 P1-D ─ 受控扩展 P2-C
配置/prompt P0-D ─ 模型能力 P1-B ─ 新协议 P2-A
基线/测试 P0-E ─ P1-F ─ 质量/发布 P2-E
```

- trait变更兼容读器/新schema/双仓候选；不以API frozen阻止必要确认/错误通道，也不无版本破坏消费方。
- JSONL先保留；SQLite是否管task/inbox/index由事务需求决定，明确领域单一事实源，不无协调双写。
- 同workload验证，先修线性放大/所有权；不未经测量池化bwrap/复杂化NamedRegistry。
- 迁移先备份/干跑/保旧数据；README/ARCHITECTURE/release target漂移一起修。
- prompt记录hash/revision/段来源/预算/回滚，policy不被prompt覆盖；8KB尾裁剪改注册期总预算或可见确定性裁剪；文件加载也有大小/段数帽，不能只验API。

## 9. 决策清单（给用户的判断题）

逐项回答“是/否”；括号为建议/影响。未裁定按最小安全范围，本表不是实施授权。

1. **六个月内是否先定位可信单用户/小团队单机，而非不可信多租户？**（建议是；否则鉴权/租户目录网络进程隔离扩大P0。）
2. **strict模式是否接受bwrap/必要限额不可用即拒绝，不静默退v1？**（建议是；宽松profile显式开启并标示。）
3. **生产工具是否限获准workspace，私网/外部目录/外发需显式例外？**（建议是；运维命名profile不全局放权。）
4. **是否同意loop Ok/生成.md不等于完成，须结构化终态与产物证据？**（建议是；失败更可见、伪成功更少。）
5. **唯一session/turn/attempt、断Arc环、显式shutdown是否第一批阻断项？**（建议是；先于拆文件/新工具。）
6. **切会话后原worker是否继续、回执留原会话？**（建议是，P1完成；P0可拒危险换代，不搬回执到新会话。）
7. **是否接受至少一次+幂等，不承诺不可逆工具副作用exactly-once？**（建议是；部署/支付/写入另确认/幂等键。）
8. **max_steps=0时是否仍设全局worker/process、时长/token/费用预算？**（建议是；无限step非无限资源。）
9. **是否durable回执先落盘确认，断电保障另选sync？**（建议是；窗口/延迟经P0基准定。）
10. **是否保留Rust+axum内嵌，sidecar仅第二消费者/独立发布/隔离需求成立做？**（建议是；继续不建DSH桥。）
11. **六个月硬目标是否P0+P1，多协议/多模态/MCP/task graph可裁为P2？**（建议是；单维护者稳定基线9–12个月。）
12. **是否投入1.5开发+0.25QA/运维及20%缓冲，并明确macOS/Windows是否承诺发布？**（建议先确认人力；跨平台需额外OS测试，不照搬Linux沙箱保证。）
