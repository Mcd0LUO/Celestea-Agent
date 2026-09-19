# 迭代 H · 国际化（只支持中文 / 英文）

> 状态：**设计（等 G 批落地后执行）**。用户要求：「这一版做完后完善 i18n，只支持中文，英文。」
> 前置：`docs/iteration-g-workbench.md`、`apps/web/FRONTEND-RULES.md`。

---

## 0. 实读规模（AST 精算，2026-09-19）

**范围裁决（用户明确）：i18n 只做前端用户可见文案；注释不算（英文注释即可）。**

所以用 grep 数中文字符是**错的**——它把海量注释也数进去了。必须走 AST。

| 口径 | 数量 | 说明 |
|---|---|---|
| grep 全部中文字符 | 76,678 | **误导**：绝大部分是注释 |
| **AST：前端用户可见中文串** | **1,108** | 分布在 **95 / 170** 个 `.ts` 文件里 |
| 单文件最多 | 55 串 | `ui/prompts.ts` |

**结论：真实工作量是「约 1100 条文案、95 个文件」，不是「7 万字」。** 这是一个中等工程，可分期做完。

最大的 10 个文件（占约 1/3）：

| 串数 | 文件 |
|---|---|
| 55 | `ui/prompts.ts` |
| 43 | `ui/contextview.ts` |
| 40 | `ui/sessiontree/actions.ts` |
| 39 | `ui/providers/form.ts` |
| 37 | `ui/sessiontree/newsession.ts` |
| 36 | `ui/grants/flow.ts` |
| 34 | `ui/config.ts` |
| 32 | `ui/permissions/editor.ts` |
| 32 | `ui/sessiontree/render.ts` |
| 31 | `ui/send.ts` |

（另有 `api.ts` 一组集中的错误文案，天然适合先抽——它是纯映射，无 DOM 依赖。）

---

---

## 1. 已有的硬约束（决定方案形状）

| 约束 | 位置 | 影响 |
|---|---|---|
| **UI 文案门禁扫中文** | `apps/web/tools/check-ui-copy.mjs` | 它按 AST 扫 `StringLiteral`/`NoSubstitutionTemplateLiteral`，**已忽略 import/export**。i18n 后文案会变成**英文 key** ⇒ 该门禁的中文规则会**全部失效**（扫不到中文了）。必须同步改造，否则门禁形同虚设。 |
| 模块体积棘轮 | `check-module-size.mjs` + 全仓 `max-lines` | 字典文件会很大，**必须按语言/域拆分**，不能一个 `messages.ts` 塞完 |
| 前端零框架 | 无 React/Vue | 不能引 i18next 这类重库；**自己写一个极小的 t() + 字典**是正解 |
| 后端也面向用户 | `apps/studio/src/handlers/*.ts` | 错误文案会显示在界面上（如 exec 的权限拒绝），**也要能翻译**——这是容易漏的一半 |

---

## 2. 方案（待评审）

### 2.1 文案 key 与字典
- key 用**语义化点分**：`composer.placeholder.idle`、`exec.denied`；
- 字典按语言 + 域拆分，例如 `apps/web/src/i18n/locales/{zh,en}/{common,composer,workbench,...}.ts`；
- **类型安全**：`zh` 为基准，导出其 key 的联合类型；`en` 必须 `Record<Key, string>` ⇒ **漏译编译期就报错**（比运行时回落强）。

### 2.2 运行时
- `t(key, params?)`：插值只支持 `{name}` 形式，**不做复数/日期**（中英都不需要，YAGNI）；
- 语言来源优先级：`localStorage` → `navigator.language`（zh* ⇒ 中文，否则英文）→ 默认中文；
- 切换入口：加进「配置」面板（`#btnConfig`），切换后**不重建会话**，只重画文案承载节点。

### 2.3 门禁改造（关键，别漏）
- `check-ui-copy.mjs` 改为：**扫英文 key 的字典值**——即对 `locales/*/*.ts` 的**值**跑同一套禁用词规则；
- 新增一条：**断言 zh 与 en 的 key 集合完全一致**（防漏译）；
- 新增一条：**断言用户可见位置不再出现裸中文字面量**（白名单允许的除外）——防止新代码绕过 i18n。

### 2.4 后端
- 后端只翻译**会显示给用户的**文案（如 `shell_denied` 原因）。做法：返回**错误码**（已有 `code`），
  前端按码查字典 ⇒ **后端不必知道语言**（比传 Accept-Language 简单得多，且与现有 `code` 机制天然合流）。

---

## 3. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P0 | i18n 内核（`t()` + 字典骨架 + 语言检测/切换）+ **一个域**（如 statusline / composer） | 切换语言后该域变英文；zh/en key 一致 |
| P1 | 前端全量抽取（命令面板 / workbench / 会话树 / 权限 / 提问卡 …） | 无裸中文（白名单外）；现有测试全绿 |
| P2 | 后端错误码 → 前端字典映射 | 英文界面下 exec 权限拒绝是英文 |
| P3 | `check-ui-copy` 改造 + 两条新机械断言 | 门禁仍能抓到禁用词（在 en 字典上） |

---

## 4. 未决 / 风险

1. ~~76,678 里注释占多少~~ **已精算**：真实用户可见中文串 = **1108**（AST 口径）。
2. **英文默认还是中文默认？** 建议默认**中文**（现有用户是中文），英文按系统语言。
3. **品牌名与命令名不译**（`Celestea Studio`、`/run`、`/goal`）。
4. **测试里的大量中文断言**（`apps/studio/src` 前 3 名都是测试）——它们**不翻译**，但改文案会让它们红，需同步更新。
5. 分期策略已定（见 §3）：先核心 + 一个域，再全量。**1108 条可分 4~5 批落地**。
