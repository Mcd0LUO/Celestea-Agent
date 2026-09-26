# 特性设计 · 使用统计页与设置入口下移（W9103）

> 状态：**已实现**。落点 `apps/web/src/ui/usage/`（7 个模块）、`apps/web/src/styles/usage.css`、
> `apps/web/index.html` 的 `#btnSettingsEntry`；后端补的 `day_model` 维度与 `first_ts`/`last_ts`
> 在 `packages/runtime/src/ledger-query.ts`。验收证据见 `results/W-usage-stats.md`（仓外/已 gitignore）。
> 依赖：[ARCHITECTURE.md](./ARCHITECTURE.md) §6.5.2（`apps/web/src` 的测试一律放 `tests/`）、
> [data-files.md](./data-files.md)（账本口径）、[iteration-e/03-cost-ledger.md](./iteration-e/03-cost-ledger.md)（账本的设计依据）。

## 1. 一句话目标

设置页新增**使用统计**：把 append-only 用量账本聚合成一眼能读的形态（摘要条 + 52 周 Token 活动热力图
+ 按模型的每日趋势图）；同时把顶栏右端那个「配置」按钮挪到**左侧栏左下角**，做成「图标 + 设置 + 用户名」。

## 2. 数据源：只用已有的 `GET /api/usage/ledger`

零新端点（`API_ENDPOINT_COUNT` 仍 69）、零新依赖、零新 chunk。三次请求拿到全部内容：

| 请求 | 用途 |
|---|---|
| `group_by=day` | 热力图 + 摘要条（key 就是 UTC 日期） |
| `group_by=day_model` | 趋势图（**一次**拿全区间；key = `<YYYY-MM-DD>|<model>`） |
| `group_by=session` | 「最长聊天时长」（每行的 `last_ts - first_ts`） |

### 2.1 后端补的两个纯增能力（本特性暴露的缺口）

设计时实测发现聚合行只有 `{key,tokens,cost,records,unpriced_records}`，两处核心内容没有来源：

- **没有时间戳** ⇒ 「最长聊天时长」算不出来；
- **没有 day×model 交叉维度** ⇒ 趋势图（按模型分天的多条折线）画不出来。

因此在 `packages/runtime/src/ledger-query.ts` 补了：`LedgerQueryRow` 增 `first_ts`/`last_ts`
（该组最早/最晚 `ts`，epoch 秒；单步组跨度为 0，不是未知），`LedgerGroupBy` 增 `day_model`。
两者都是**纯增**：忽略它们的客户端不受影响；`contracts/endpoints.json` 同步，端点数不变。

### 2.2 兼容：老服务没有 `day_model`

趋势图有两条路径：主路径 `day_model`；服务端返回 **422**（不认这个维度）时回退成
「对区间内每一天各发一次 `group_by=model&since&until`」。回退是必要的兼容而非冗余 ——
端点契约冻结，而旧版本服务仍在跑（本机 3777 实测 422）。两条路径都有测试钉住。

## 3. 诚实纪律（三条，都可机械检验）

1. **未知价格不是 0**：`cost: null` 显示「未定价」，绝不 `?? 0`；
2. **没有账本就说没有**：`ok:false` 分 `disabled` / `unavailable` / `unreadable` 三句不同的话，
   且**不画任何图**（不伪造空图）；
3. **答不了就留空**：`/auth/check` 401 或无 `user` 字段时**不显示**用户名；`first_ts`/`last_ts`
   缺失时「最长聊天时长」显示「—」——都不编占位值。

## 4. 入口改造与已知代价

- 删掉顶栏 `#btnConfig`（连同它的两个字典键，避免死键）；
- `.side-sec-foot` 新增 `#btnSettingsEntry`（内联 SVG 齿轮 + 「设置」+ 用户名），
  `margin-top:auto` 把它推到侧栏底部（真机实测原先浮在中段、距底 403px，修后 8px）；
- **已知代价**：`#app.sidebar-collapsed #sidebar { display: none }` ⇒ 侧栏收起时入口随之隐藏。
  这是「拿到左下角」的可接受代价；移动端抽屉态下入口可见（真机 390×844 实测）。

## 5. 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| A1 | 摘要条 5 格、热力图 52 列、趋势图有序列与图例 | 真机 CDP 几何（非零）+ 截图 |
| A2 | 「最长聊天时长」是**真值**（来自 `first_ts`/`last_ts`），不是 `—` | 真机断言 `"7 小时 52 分钟"` |
| A3 | `cost:null` 显示「未定价」而非 ¥0 | DOM 测试 + 真机 |
| A4 | `ok:false` 如实降级、不画空图 | DOM 测试两条（`disabled` / `unavailable`） |
| A5 | 顶栏不再有 `#btnConfig`（机械防回归） | 测试**直接读 index.html 源文件**断言 + 真机顶栏按钮集合 |
| A6 | 左下角入口几何非零、贴底、含图标与「设置」 | 真机 CDP 几何（291×36.625、距底 8px、图标 14×14） |
| A7 | 未登录不编用户名 | 真机断言 `hidden=true text=""` |
| A8 | 趋势图走 `day_model` 主路径（不是回退） | CDP **Network 域**抓实际请求 |
| A9 | 变异负控制 | 18/18 条「改坏→红、还原→绿」 |

## 6. 刻意没做什么

- 不做模型占比饼图（本次范围只点名 5 格摘要 + 热力图 + 趋势图）；
- 不给 `day_model` 加缓存（一次请求已经很便宜，加缓存会引入失效问题）；
- 不引图表库：热力图用 CSS Grid（364 个可独立悬停的方块，Grid 天然随容器等分），
  趋势图手写 SVG（折线/网格/刻度是真正的矢量图形）；
- 不改 `apps/web/bench/e2e-multisession.mjs`（它引用已删除的 `#btnConfig`，但属 W781 遗留的
  不可运行陈旧脚本、不被任何门禁覆盖）—— 登记为已知残留。
