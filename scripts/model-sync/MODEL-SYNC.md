# 模型清单同步（Studio ↔ 网关 ↔ 基元律动上游）

上游改模型 id 时（如 `deepseek-v4-pro-0813` 渠道消失、`deepseek-v4.1-flash-expires-on-0910`
于 0910 关闭、新统一 id `deepseek-flash`），三层的模型清单会各自脱节。这里两个脚本各管一段。

## 1. `sync-models.py` — Studio providers 清单 ↔ 网关实际可用模型

- **不直接改 `providers.json`**：后端启动时把文件读进内存，直接改盘会与活体 store 不一致。
  脚本全程走 HTTP：`GET /api/providers` 读活体 → 探针 → `POST /api/providers` 写回。
- 探针：每个候选模型发一次 `max_tokens=1` 的 chat 请求。
  - `200` → ALIVE
  - `模型已关闭` / `No available channel` / `model_not_found` / 404 → DEAD（删除）
  - 429 / 5xx / 超时 / 其它 4xx → UNKNOWN（**保持原状，不乱删**）
- 新模型：上游目录里 ALIVE 且匹配 `--include`（默认 `^deepseek`）的 id 才自动采纳，
  不擅自把 mimo/glm/ox 之类塞进 Studio 清单；`--include ''` = 全采纳。
- `default_model` 落在 DEAD 上时，按 `--prefer` 顺序切到第一个存活模型（busy 时后端 409，下轮再试）。
- 回写时**不带 `api_key` 字段** = 后端保留原 key（key 只在写回 payload 里缺席，脚本自己
  从 `providers.json` 0600 读，不打印、不回传）。
- 退出码：`0` 无变化/已应用 · `1` 失败 · `2` dry-run 发现漂移。

## 2. `sync-upstream-models.py` — 基元律动渠道 model 清单 ↔ 上游 `/v1/models`

- 不自造探针：直接用 **NewAPI 定制版自带**的「上游模型更新」能力
  （`POST /api/channel/upstream_updates/detect|apply`，服务端拿渠道自己的 key 拉上游）。
- **默认只做 detect+apply，不碰渠道配置**（setting / key / status 都不写）。
- 范围：`base_url` 含 `tokenrhythm.studio` 的渠道（自发现 **+ 分页**，排除 `is_multi_key` 聚合池）。
- **默认只加不删**，`--remove` 才同步删除；删除只会作用于服务端 detect 出来的
  `last_removed`（`apply` 内部与 pending 列表求交集，脚本无法删掉上游仍在提供的模型）。
- detect 失败/上游超时 → 跳过并告警，绝不误删。
- 退出码：`0` 已同步 · `1` 有渠道失败 · `2` dry-run 发现待同步项。

### 可选 `--enable-flags`：开启 NewAPI 自带的渠道级自动同步

置真渠道 setting 的 `upstream_model_update_check_enabled` /
`upstream_model_update_auto_sync_enabled`，让 NewAPI 自带 30min system task
（`CHANNEL_UPSTREAM_MODEL_UPDATE_TASK_*`）也持续兜底。**默认关闭**（改 58 条渠道的行为应显式决定）。

写入用 `PUT /api/channel/`，必须遵守本版定制规则（V1 全量失败的教训）：

| 规则 | 原因 |
|---|---|
| payload **不能含 `status`** | `UpdateChannel` 一见 `requestData["status"]` 直接判「非法参数」→ V1 的 58 条渠道全 FAIL |
| 剔除只读字段 | `created_time`/`test_time`/`response_time`/`balance`/`balance_updated_time`/`used_quota`/`status_code_mapping`/`channel_info` 回带会被清零 |
| 必须回带 `key` | 本版 PUT 会用 payload 覆盖 key |
| 用单条 `GET /api/channel/{id}` 取对象 | 列表接口不保证带 key；**拿不到 key 就放弃写入并告警**（不冒险清 key） |
| `other_info` 原样回带 | 保留既有字段（同 `tokenrhythm-usage.py` 的做法） |

参考实现：`/src/CelesteaTeamAPI/newapi-ops/tokenrhythm-usage.py` 的 `append_other_info()`。

## 3. `add-model-to-channels.py` — 批量给某系列渠道「加入一个模型」

场景：要新纳入一个模型 id（例：`deepseek-v4.1-flash`）到基元律动渠道。

```bash
# 干看（并打印各渠道上游 /v1/models，核对上游是否真有这个 id）
sudo python3 /src/celestea_studio-ts/scripts/model-sync/add-model-to-channels.py --model deepseek-v4.1-flash --probe-upstream
# 先只改一条，验证真的能用，再全量
sudo python3 ... --model deepseek-v4.1-flash --limit 1 --probe-upstream --apply
sudo python3 ... --model deepseek-v4.1-flash --apply
# 需要别名（本地名 -> 上游名）时：
sudo python3 ... --model deepseek-v4.1-flash --map-to <上游名> --apply
```

- 只碰 `--base-url-substr`（默认 `tokenrhythm.studio`）命中的渠道，排除 `is_multi_key` 聚合池；
  分页抓全量；幂等（已在 models/mapping 里的渠道跳过）；写完**回读复核**。
- 遵守 PUT 五条规则（见下表）；key 优先取单条 GET 的 `key`，拿不到回退
  `sudo -u postgres psql`（与 `tokenrhythm-usage.py` 同法），两者都没有 → **WARN 跳过**，不冒险写。
- 退出码：`0` 已同步/无变化 · `1` 有渠道失败 · `2` dry-run 发现待改动。

## 部署（需 root；agent 沙箱内 `no_new_privs=1`+`CapEff=0`+`/` 只读，做不了）

```bash
sudo bash /src/celestea_studio-ts/scripts/model-sync/install-model-sync-cron.sh          # 装 + 先跑 dry-run
sudo bash /src/celestea_studio-ts/scripts/model-sync/install-model-sync-cron.sh --dry-run # 只看计划
```

装完：`/etc/cron.d/celes-studio-models`、`/etc/cron.d/celes-sync-upstream-models`（各 `*/30`），
脚本经 `/server-center/runtime/bin/` symlink 指回本目录（沿用 newapi-ops 的部署约定）。
日志：`/server-center/runtime/log/studio-model-sync.log`、`…/sync-upstream-models.log`。

> ⚠️ cron.d 文件**末行必须带换行**，否则 cron 静默忽略整个文件（`celes-price-sync` 踩过：
> 定价任务静默失效 16h）。installer 有该检查。

## 离线验收（无需网络/不碰生产）

```bash
python3 tools/test_sync_models.py            # 假网关+假 Studio（回环）
python3 tools/test_sync_upstream_models.py   # 假 NewAPI（回环）
```

覆盖：dry-run 不写 / 死模型删除 / 新 id 采纳 / UNKNOWN 不误删 / name·note·base_url 保留 /
不回传 api_key / default 自动切换 / 只加不删 / `--remove` / detect 失败 rc1 / key 不泄漏 / 幂等。

## 已知边界

1. **模型可用性会抖动**：实测 `deepseek-v4-pro` 06:20 存活、06:54 变 `No available channel`
   （渠道被临时禁用/额度耗尽都会让模型从 `/v1/models` 消失）。脚本按当时事实同步，
   删掉后若恢复，下轮会自动加回 —— 波动成本是下拉里短暂增删，不影响可用性判断。
2. **Studio 静态 catalog 管不到**：`src/main.rs` 的 `AVAILABLE_MODELS` 是编译进二进制的兜底清单
   （`provider:""`），如 `deepseek-v4-flash-vision-exp` 仍会出现在下拉里；要清必须改源码 + 重新构建 + 重启后端。
3. **计价不在本脚本范围**：网关 `/api/pricing` 里 `deepseek-flash` 的 `model_ratio=37.5`，
   而 `deepseek-v4-flash` 是 `0.225`（差约 160 倍），价目走 `price-manage.py` 那套，建议单独核。
