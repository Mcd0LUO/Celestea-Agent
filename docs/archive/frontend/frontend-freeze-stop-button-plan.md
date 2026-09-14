# 前端卡死修复 + statusline 停止按钮 · 架构方案（2026-09-09）

> 📦 历史文档（2026-09-11 归档）：描述的是前端卡死修复 + statusline 停止按钮的架构方案（W301/W302），方案已上线，文首「待执行」状态已过时。当前权威入口见 [../DEVELOPMENT.md](../DEVELOPMENT.md) 与 [../pitfalls.md](../pitfalls.md)。

- 作者：主架构师会话（harness 架构哥）
- 范围：`frontend/`（TypeScript + Vite）；**后端零改动**
- 交付方式：主架构师规划/统筹/集成/上线，子 worker 分两条互不冲突的工作流落地
- 状态：待执行

---

## 0. 一句话结论

卡死的根因是**流式正文每个节拍都对整段文本做全量 markdown 重解析 + 全量代码高亮 + 整块 innerHTML 重建**，
成本随文本长度超线性增长，长回答后期单次渲染可达数百毫秒、持续占用主线程 → UI 假死。
修法：**只重渲染"未完成的尾块"，已完成块缓存 HTML；代码高亮按内容做有界缓存 + 超大块降级**。
停止按钮：statusline 第 1 行右端加一个方形按钮，复用既有 `POST /api/cancel` 取消链路。

---

## 1. 复现与证据（本机实测，非推测）

### 1.1 代码路径

`frontend/src/ui/messages.ts`

```ts
const RENDER_INTERVAL = 60;                 // 每 60ms 一次节拍
function renderTextView(view: AssistantView): void {
  view.content.innerHTML = md(view.text);   // ← 整段文本全量 marked.parse
  highlightCode(view.content);              // ← 整块重建后 dataset.hlDone 全失效 → 全量重高亮
  autoscroll();
  railSync();
}
```

- `md()` = `marked.parse(全文)`；`view.text` 是**累积全文**，每 tick 都重新解析一次。
- `highlightCode()` 的去重靠 `block.dataset.hlDone`，但 `innerHTML` 重建后节点是新的 → 去重**永远失效**，
  每个节拍把该段里所有代码块重新高亮一遍。
- `flushTextView` 在 `done` / 工具事件 / 文本段收尾时同步执行 —— 这几处是**同步长任务**，直接阻塞输入。

### 1.2 实测数据（Node 24，本仓库实际依赖 marked@4 / highlight.js@11）

复刻 `renderTextView` 的完整管线（`marked.parse` + 逐块 `hljs.highlight`），文本按"每 ~1500 字符一个 rust 代码块"构造：

| 累积文本 | 代码块数 | marked.parse | hljs 高亮 | 合计 | 产出 HTML |
|---|---|---|---|---|---|
| 8K 字符 | 3 | 0.6ms | 8.1ms | **8.6ms** | 8KB |
| 16K | 6 | 1.2ms | 14.5ms | **15.7ms** | 17KB |
| 32K | 11 | 1.2ms | 18.2ms | **19.4ms** | 34KB |
| 64K | 22 | 2.1ms | 41.0ms | **43.1ms** | 67KB |
| 128K | 43 | 4.2ms | 70.7ms | **74.9ms** | 135KB |

- **单次渲染成本随长度超线性上升**（8K→128K 涨 8.7 倍）；其中 **hljs 占 80%~94%**。
- 一次 128K 字符的流式回答（60ms 节拍）累计渲染 CPU **1042ms**，单次最大 **70ms** —— 而节拍是 60ms，
  **单次渲染已经超过节拍本身**，排队必然持续堆积。
- 上表**只算 marked + hljs**，不含 `innerHTML` 解析、样式重算、布局、绘制与 `scrollHeight` 强制回流
  （浏览器里通常再乘 2~4 倍）。即长回答后期真实单帧 150~300ms 是合理估计 → 输入卡顿、计时器冻结、按钮无响应。

### 1.3 结论

- 后端不受影响（纯前端主线程饱和），与用户观测一致（"后端良好"）。
- 与回答长度、代码块密度正相关 —— 正是"模型运行一会后卡死"的形态。

---

## 2. 修复设计

### 2.1 核心：增量 markdown（新增 `frontend/src/utils/markdown.ts`）

把"整段重解析"换成"**稳定前缀缓存 + 只重渲染尾块**"。

```ts
export class MarkdownStream {
  /** 已确定不再变化的 HTML（前缀缓存）。 */
  private stableHtml = '';
  private stableLen = 0;   // stableHtml 对应的原文长度
  private tail = '';       // 尚未固化的尾部原文
  /** 每 tick 调用：只对 tail 做 marked.parse。 */
  update(fullText: string): { html: string; tailStart: number };
  reset(): void;
}
```

切分规则（**必须保守，宁可少固化，不可固化错**）：

1. 以「空行」为块边界；只有**完整块**（其后出现空行）才允许固化。
2. 固化边界必须避开的未闭合结构：
   - 未闭合围栏 ` ``` `（含语言行）；已闭合围栏可固化；
   - 未闭合的列表 / 引用 / 表格块（其后续行可能继续该块）→ 整个尾块都不固化；
   - 未闭合的行内标记（`**`、`` ` ``、`[`）出现在**最后一个块**里 → 该块不固化。
3. 兜底：如果无法确定安全边界，`stableLen` 不前进（最多退化为"整段重渲染"，即当前行为，不会更差）。

渲染：`html = stableHtml + md(tail)`。已固化块的高亮由 §2.2 的缓存兜住，不重复付出成本。

**向后兼容**：`md()` 继续从 `messages.ts` 导出（`restore.ts` 走 `finalizeAssistant` → 一次性全量渲染路径），
实现改为转调 `markdown.ts`，行为不变。

### 2.2 核心：高亮成本收敛（改 `frontend/src/utils/hljs.ts`）

1. **内容键缓存（有界 LRU）**：`highlightCode(container)` 对每个 `pre code` 先算键
   `lang + '\u0000' + code.textContent`，命中则直接写回缓存的 HTML，未命中才调 `hljs.highlight`。
   容量上限（建议 128 项 / 总字节上限 2MB），超出按 LRU 淘汰 —— **有界，不会泄漏内存**。
2. **超大块降级**：单块源码 > 32KB → 直接跳过高亮（`language-plaintext`），避免单块拖垮主线程。
3. **保留 `dataset.hlDone` 快速路径**（同节点重复调用仍 O(1) 跳过）。

### 2.3 渲染节拍与冲刷

- 节拍保持 60ms（不引入 rAF 重写，风险最小）；**增量后单次成本应降到 <10ms**。
- `flushTextView` 仍同步执行，但成本已随增量下降；`done` 事件触发的最后一次全量渲染命中缓存。
- 保留 `autoscroll()` / `railSync()` 调用点不变（选择条与滚动行为零回归）。

### 2.4 停止按钮（statusline 第 1 行右端）

- `frontend/index.html`：`#statusline` 第 1 行 `.sl-spacer` 之后、`.sl-hint` 之前插入
  `<button id="slStop" class="sl-stop hidden" type="button" title="停止本轮生成" aria-label="停止本轮生成">`
  + 内联 SVG 正方形（10px 实心方块，`currentColor`）。
- 样式 `frontend/src/styles/statusline.css`：方形按钮，尺寸 18×18，圆角 4px，边框用
  `--c-border-subtle`，hover 用 `--c-accent-soft`，**只用 token，不写死颜色**；`.hidden` 沿用全局隐藏类。
- 行为（单一取消入口，**不新增后端契约**）：
  - `frontend/src/chat.ts` 新增 `export function requestCancel(): void`，内容 = 现有 `initInputBar({cancel})`
    的取消逻辑（`S.streaming` 守卫 + `setStatus('取消中…','busy')` + `api.cancel()` 错误提示）；
  - `initInputBar` 的 cancel 回调与 `#slStop` 的 click 都调 `requestCancel()`；
  - 显隐由 `ui/inputbar.ts` 的 `setBusy(busy)` 统一驱动（`#slStop` 与 `#btnCancel` 同步 toggle `.hidden`），
    **不再有第二个 busy 真源**；
  - 空闲态隐藏、运行中显示；点击后立刻置为禁用态防连点，直到 `finalizeTurn` 触发 `setBusy(false)`。
- 复用后端既有 `POST /api/cancel`（`src/main.rs:1031`，无轮次时返回 `{"cancelled":false}`，幂等）。

---

## 3. 工作流拆分（子 worker 契约）

**互斥文件集**，可并行；两条流都**禁止**跑 `pnpm build`（产物 `frontend/dist` 由架构师统一构建），
只跑 `pnpm typecheck`。

| 流 | worker | 文件集 | 交付 |
|---|---|---|---|
| A · 卡死修复 | W301 | 新增 `frontend/src/utils/markdown.ts`；改 `frontend/src/utils/hljs.ts`、`frontend/src/ui/messages.ts`；新增 `frontend/bench/markdown-render-bench.mjs` | 增量渲染 + 高亮缓存 + 前后对比基准脚本 |
| B · 停止按钮 | W302 | 改 `frontend/index.html`、`frontend/src/styles/statusline.css`、`frontend/src/ui/inputbar.ts`、`frontend/src/chat.ts` | 方形停止按钮 + 单一取消入口 |
| C · 验收 | W303（A/B 落地后） | 只读 + 临时实例 e2e（端口 3799，数据文件指向临时目录） | 验收报告：typecheck / build / 铁律逐条 / 取消链路 e2e |

**硬约束（写入每份简报）**

- 工作目录 `/src/celestea_studio`；**不得** `git add` / `commit` / `push`（架构师统一提交）。
- **不得**重启 `celestea-studio.service`（本次改动是纯前端，`pnpm build` 即生效）。
- 遵守 `frontend/FRONTEND-RULES.md` 八条铁律；`pnpm typecheck` 必须零错误（strict + `noUncheckedIndexedAccess`）。
- 不改后端（`src/**`）、不改 `docs/**`。
- 禁止引入新依赖（`marked` / `highlight.js` 已在依赖里）。

---

## 4. 上线步骤（架构师执行）

1. 合并 A/B 改动 → `cd frontend && pnpm typecheck && pnpm build`（单次，写 `frontend/dist`）。
2. 跑 `node frontend/bench/markdown-render-bench.mjs`，记录**修复后**单次渲染成本（目标：128K 文本 < 10ms）。
3. 起临时实例（`STUDIO_BIND=127.0.0.1:3799` + 临时数据文件，见 `docs/DEVELOPMENT.md` §7.1）验证：
   - `GET /` 200；`POST /api/turn` 202 → `POST /api/cancel` → SSE `status:cancelled`；
   - 前端 `#slStop` 在 turn 期间可见、点击后消失、状态栏显示「已取消」。
4. 版本号：`frontend/src/version.ts` 的 `APP_VERSION` / `BUILD_TIME` 与 `frontend/package.json` 同步。
5. 提交（前端源码 + 文档；**不提交** `frontend/dist`）；线上为 `pnpm build` 后即生效，**无需重启服务**。
6. 文档：`docs/pitfalls.md` 追加条目（根因 + 代码位置 + 修法），`docs/DEVELOPMENT.md` §2.8 补停止按钮说明。

## 5. 回滚

`frontend/dist` 为纯静态产物：保留上一版 `assets/index-*.js` 备份即可秒级回滚；源码侧 `git revert` 单个提交。
