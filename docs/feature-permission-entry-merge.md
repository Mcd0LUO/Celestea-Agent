# 特性设计 · 权限入口合并（档位 + 精细授权 → 一个盾牌）

> 状态：**已实现**（W1517，2026-09-25）。落地：唯一入口 = `#slGrant`（沿用 W701 的盾牌路径），
> 面板 = `ui/grants/panel/body.ts` 的 §1 会话档位（`statusline/permission/tier.ts`）+ §2 精细授权；
> 档位徽标并入 `.sl-grant-tier`（与授权计数同处一格）。验收 B1–B6 的逐条证据（含真机 CDP 几何与截图、
> 变异负控制红绿对照）见 `results/W1517-权限入口合并.md`。
> 依赖：[ARCHITECTURE.md](./ARCHITECTURE.md) §6.5.2（`apps/web/src` 的测试一律放 `tests/`）、
> 归档决策 [feature-session-grants.md](./archive/decisions/feature-session-grants.md)（一次性授权语义）。

## 1. 一句话目标

状态栏右端**只留一个**权限入口（用**已有的盾牌图标**），点开后的面板同时给出
**会话档位**与**精细授权**两块内容；窄屏不再因为两个按钮并列而把停止键挤出屏幕。

## 2. 现状（实读，带 file:line）

| 事实 | 位置 |
|---|---|
| 状态栏右端有两个并列按钮：`#slPerm`（档位，**锁**图标）与 `#slGrant`（盾牌，三态） | `apps/web/index.html:94-97`、`:100-103` |
| 盾牌 SVG（`M8 1.6 13.2 3.4v4.2c0 3.1-2.1 5.6-5.2 6.8-3.1-1.2-5.2-3.7-5.2-6.8V3.4z`） | `apps/web/index.html:101` |
| 档位入口的显隐/徽标/弹层自持，**注释明写「入口分列、互不合并（任务书明确要求）」** | `apps/web/src/statusline/permission.ts:9`、`:52,150-151,236` |
| 盾牌入口的三态渲染与徽标 | `apps/web/src/ui/grants.ts:188-189`、`apps/web/src/ui/grants/panel/shield.ts:2,29-32` |
| 已存在的历史压力：`.sl-end` 集群在窄屏溢出，停止键被裁 | `apps/web/index.html:88-95` 的 W847 注释；`docs/HANDOVER.md` §P2 的用户截图记录 |

## 3. 目标交互

```
[盾牌]  ← 唯一入口（沿用 #slGrant 的 SVG）
   ├─ 三态外观：默认 / 已放宽 N 项 / 即将失效（现有 shield.ts 的三态不变）
   └─ 点开 → 一个面板，两块内容：
        §1 会话档位：read-only / write-read / full-access（原 #slPerm 的列表与切换）
        §2 精细授权：原盾牌面板的授权行 + 快捷授权 + TTL
```

- **图标**：用**已有**的盾牌路径，不新画图标（`index.html:101` 的那一段）。
- **锚点**：面板落位仍以触发键为锚（现有 `anchorEl = #slPerm` 的机制改指合并后的入口）。
- **档位徽标**：原 `#slPermBadge` 的档位名并入盾牌徽标区（档位名与授权计数同处一格，避免两行）。

## 4. 必须守住的不变量

| # | 不变量 | 为什么 |
|---|---|---|
| I1 | 三态与计数语义不变（未授予 / 已授予 N / 即将失效） | 现有 `tests/w9-permission-ui.test.ts` 与 i18n key 依赖它 |
| I2 | 入口的**隐藏**语义不变：能力位未就绪时保持 `.hidden`，不置灰报错 | `ui/grants.ts` 与 `statusline/permission.ts` 各自的降级纪律 |
| I3 | 乐观更新与竞态快照不变（在飞的乐观项不被快照带走） | `ui/grants/state.ts:170` 的 W795 教训 |
| I4 | 提权仍是**一次性**语义（TTL、可撤销、审计），模型不可自触发 | `docs/deployment.md` §4 的安全模型 |
| I5 | 窄屏（≤640px）右端集群不溢出：停止键必须可见 | 本特性的**动机**；用真机几何断言 |
| I6 | 关闭面板不触发背景重渲染；开关只切 class | `apps/web/FRONTEND-RULES.md` 第 4/5 条 |

## 5. 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| B1 | 状态栏只剩一个权限入口，且图标是盾牌 | DOM 断言 + 真机截图 |
| B2 | 面板同时含档位列表与授权行，两块都可操作 | 真机 CDP：切换档位、执行一次授权，均落到后端 |
| B3 | ≤640px 视口下 `.sl-end` 不溢出、停止键几何非零且可见 | 真机几何断言（非零 width/height + 在视口内） |
| B4 | 三态外观与 i18n key 不变 | 现有测试全绿（不改断言） |
| B5 | 入口隐藏语义不变 | 变异：能力位缺失 → 入口仍 `.hidden` |
| B6 | 变异负控制 | 把两块内容拆回两个入口 → B1 红；把 `.hidden` 逻辑删掉 → B5 红 |

## 6. 风险

| ID | 项 | 处置 |
|---|---|---|
| R1 | 与任务书「入口分列、互不合并」的旧口径冲突 | **本条由用户本轮明确要求合并**，属显式改口径；落地时必须同步改掉 `statusline/permission.ts:9` 的注释（注释写的是旧口径，留着就是漂移） |
| R2 | 两块内容合并在窄屏更高，可能被视口裁 | 面板自身滚动 + 落位锚点现算（沿用 W871 的 `panelGeom`） |
| R3 | 测试夹具仍按两个 id 查找 | 合并会改 id 面：`tests/w795-optimistic-grants.test.ts`、`w871-shell-anchor-dom.test.ts`、`w847-inline-attach-sl-end-dom.test.ts` 等需要同步；**保留旧 id 作为别名**是禁止的（会留下两个入口的假象）。**已处置（W1517）**：`tests/lib/w795-dom.ts` 与四个同构骨架改为单入口 + 档位格；`w9`/`w871`/`w1297` 的入口与面板选择器同步（断言内容逐条未改）；新增 `tests/w1517-permission-entry-merge.test.ts` 机械禁止旧 id/旧类名回归 |

## 6.1 实现状态（W1517 回填）

| 项 | 落地位置 | 验收 |
|---|---|---|
| 唯一入口（盾牌图标逐字沿用） | `apps/web/index.html` 的 `#slGrant`；`#slPerm` 与 `.sl-perm*` 全删 | B1（DOM + 真机截图） |
| 档位徽标并入 | `#slGrantTier`（`statusline/permission.ts` 写、`ui/grants/panel/shield.ts` 统一拼 title） | B1/B4 |
| 一个面板两块内容 | `ui/grants/panel/body.ts`（§1 `tierSection` + §2 原有顺序逐字未改） | B2 |
| 两块都落到后端 | §1 → `PUT /api/sessions/{id}/permission`；§2 → `POST /api/sessions/{id}/grants` | B2（真机从后端读回请求） |
| ≤640px 停止/发送键几何非零 | `.sl-end` 实测 44×44 且 `scrollWidth === clientWidth` | B3（真机几何） |
| 入口隐藏语义 | 显隐真源只剩 `ui/grants.ts` 的能力位；档位缺失只撤档位段 | B5（变异负控制） |

## 7. 刻意没做什么

- 不改授权本身的后端语义（TTL / 审计 / 上限）—— 只合并**入口**。
- 不新增端点、不改 `contracts/endpoints.json`。
- 不做「权限档位影响工具面」这类语义变更（那是 `docs/modes-standard-vs-execution.md` 的范围）。
