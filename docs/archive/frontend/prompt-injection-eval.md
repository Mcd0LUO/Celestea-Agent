# 提示词注入机制评估（模型不知自身模型 / 多提示词注册）

> 📦 历史文档（2026-09-11 归档）：描述的是提示词变量注入 / 多提示词注册的早期评估（Rust 期 prompts.rs），变量注入与分段覆盖机制均已在 TS 后端落地。当前权威入口见 [../DEVELOPMENT.md](../DEVELOPMENT.md)。

- 评估人：架构师会话（实测 + DSH 源码对照）
- 日期：2026-09-07
- 结论先行：当前提示词是**静态文本、零变量拼接**（模型连自身 model id 都不知道，实测其回答"无法确认底层模型"）。需要两步：① 变量注入（立即解决模型自识问题）；② 提示词注册表（多提示词注册/切换/按会话绑定）。DSH 的 `@deepseek-ai/dsh-system-prompt` 就是可借鉴的参考实现（有序 section + 严格 {{变量}} 插值 + preset 同名段替换）。

## 1. 现状与根因

- `src/main.rs` `DEFAULT_SYSTEM_PROMPT` 是固定字符串；`build_gen` 仅在空/引擎占位时整体替换。**没有任何运行时变量注入**。
- 结果：模型不知道 provider/model id/base_url/会话/工具面变化（工具面由引擎自行注入 schema，其余全无）。
- 用户观测：问模型"你是什么模型"→ 得套话"由 Celestea Engine 驱动，无法确认"。

## 2. DSH 参考机制（真源）

- `@deepseek-ai/dsh-system-prompt/lib/index.js`：`SECTION_ORDERS`（身份/来源/Web面/部署人格/计划策略/团队策略/文件引用/各工具段…）、`CONTEXT_ORDERS`（沙箱/审批/委派）、**严格 `{{variable}}` 插值**（未定义变量在注册期报错、substitution 不递归扫描）、空段丢弃、同名段可被 preset 替换（`deployment:persona`）。
- 动态面：工具 schema 由各插件注册进 section；上下文快照按序拼接。
- 借鉴点：模板=有序段+变量表；变量校验前置；注册式提示词（可替换/叠加）。

## 3. Studio 方案设计（分两阶段）

### 阶段一：变量注入（小改，立即收益）
- 模板仍为 DEFAULT_SYSTEM_PROMPT，但支持 `{{变量}}`：`{{model}}`（当前模型 id，随热切换换代自动重渲染）、`{{provider}}`（当前提供商名，chat_completions 时可知）、`{{base_url}}`、`{{workspace}}`（活跃工作区名）、`{{session}}`（活跃会话 id）、`{{tools}}`（9 工具名列表）、`{{context_window}}`、`{{max_output_tokens}}`、`{{date}}`。
- 渲染时机：`build_gen`/`prepare_gen` 换代时渲染（post_config 热切模型 → 新 Gen 提示词自动含新 model id；激活会话 → 含新会话名）。变量快照随 Gen 一起原子替换，绝无半新半旧。
- 实现：渲染函数 `render_prompt(template, vars)`（纯字符串替换；未闭合 `{{` 按字面处理；未定义变量→渲染期报错并回退默认模板，绝不 panic）。
- 默认模板头部加一段（示例）：“You are running on model {{model}} via {{base_url}}; the active workspace is {{workspace}}, session {{session}}.”——模型自识问题即解。

### 阶段二：提示词注册表（多提示词）
- 存储 `prompts.json`（0600）：`{"prompts":[{"id","name","template","is_default":bool}],"default_prompt":"<id>"}`。
- 端点：GET/POST /api/prompts、POST /api/prompts/{id}/delete、POST /api/prompts/{id}/default（热应用=换代）。
- 绑定：会话级 `session.json` 增可选 `"prompt":"<id>"`（activate 时生效，同 model 逻辑）；config 面板可临时选 prompt（等同 system_prompt 覆盖）。
- 内置注册：默认注册 `builtin-default`（现模板）；用户可注册"编码""文档""MC运维"等不同风格提示词。
- UI：设置页新增"提示词"页（列表/编辑 textarea+变量文档/设默认/删除）；新建会话弹窗可选 prompt（非必须）。
- 约束：模板长度上限（如 8KB）、变量白名单（只有上表变量可插值）、纯字符串替换无执行能力；空模板拒绝。

## 4. 工作量与风险

| 项 | 量级 |
|---|---|
| 阶段一（渲染+变量+模板头） | 0.5 人日（后端一个 worker） |
| 阶段二（注册表+端点+UI 页+会话绑定） | 1-1.5 人日（后端+前端） |
| 风险 | ①变量过期：换代即重渲染，可控；②模板坏变量导致空提示：注册/保存时校验+回退；③token 成本：模板控制在 ~1.5K token 内；④与热切换/唤醒循环交互：渲染只在 build_gen/prepare_gen 单点进行，不散落 |

## 5. 建议与决策清单

- 建议：**阶段一立即做**（解决"模型不知道自己是谁"）；阶段二紧随（多提示词注册是迭代实验的刚需）。
- 决策清单：①变量集是否够用（要加 provider 上游模型别名吗）②提示词注册默认放 prompts.json（工作区级还是全局）③会话级 prompt 选择是否进新建会话弹窗 ④是否需要"提示词继承/合并"（如 DSH 的段替换，还是整段覆盖）⑤工具 schema 描述是否也要模板化（当前引擎自动注入，保持不动即可）。
