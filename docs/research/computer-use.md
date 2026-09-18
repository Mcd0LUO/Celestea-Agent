# Celestea Agent · 真机操控（Computer-Use）开源调研

> 范围：**只做调研**，不改产品代码。本文只覆盖 computer-use；持久记忆库由另一路 worker 负责（见同目录 `memory-store.md`）。
> 结论先行：**Web 侧走「零依赖 CDP + chrome-headless-shell」是值得的**；元素识别默认走**可访问性树/元素引用（ref）**，纯视觉只作降级；原生桌面走 **Xvfb + X11 注入**，Wayland 在无显示器服务器上不是目标。
> 调研时间：时间盒内完成，标注「未核实」处不臆断。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| 无显示器服务器能不能做 computer-use？ | 能。**Web 场景完全不需要显示器**（headless Chromium 原生截图/输入）；原生桌面用已装的 **Xvfb** 造虚拟显示即可。 |
| 零依赖 CDP 值不值得走？ | **值得，但只做「最小 CDP 客户端」，不要重造 Playwright**。Node 26 原生 `fetch` + 全局 `WebSocket` 已消除第三方依赖；`chrome-headless-shell` 已在 `~/.cache/ms-playwright`。 |
| 元素识别走视觉还是 a11y？ | **默认 a11y 树 + 元素 ref（廉价、确定、可复现）**；视觉作为 canvas/WebGL/图片站与原生桌面的降级通道。 |
| 许可证红线 | **AGPL：Skyvern、Lightpanda、ydotool** —— 只借鉴设计，绝不复制/链接代码。**LGPL：AT-SPI2、xdg-desktop-portal**。**CC-BY-4.0：OmniParser 权重**。 |
| 最大工程风险 | 不是「能不能跑」，而是**权限边界**：computer-use 等于把整台机器交给模型。必须做成默认关闭、按会话授权、可审计、可急停的独立能力。 |

---

## 1. 项目对比表

### 1.1 端到端 computer-use / GUI agent（高星）

| 项目 | Stars | 许可证 | 一句话定位 | 可借鉴点 |
|---|---:|---|---|---|
| [browser-use](https://github.com/browser-use/browser-use) | 115k | MIT | 让 LLM 操作浏览器的 agent 框架 | **索引化元素列表**：把可交互元素序列化成带 index 的文本给模型，模型选 index 而非坐标；vision 可选；多标签页；敏感数据占位符 |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 37k | Apache-2.0 | Playwright 的 MCP 封装 | **本调研最重要参考**：用 **accessibility tree + ref** 定位元素（`ref=eN`），"no pixel input / deterministic / LLM-friendly"；`--cdp-endpoint` 可接已运行 Chrome；`--snapshot-boxes` 输出 bounding box；capabilities 可选开 vision |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | 24k | MIT | Web 数据抽取 + 交互 SDK | **act / extract / observe / agent 四原语**；"hybrid accessibility-tree trimming" 只给模型需要的上下文；**动作缓存 + 自愈**（重复任务不重复问模型） |
| [anthropics/anthropic-quickstarts](https://github.com/anthropics/anthropic-quickstarts)（computer-use-demo） | 17.7k | MIT | 官方 computer-use 参考实现 | **容器化桌面**：Ubuntu + **Xvfb** + **xdotool** + scrot，模型返回坐标 → xdotool；工具集 = `computer` + `bash` + `str_replace_editor`；明确警告"必须跑在 VM/容器里"；分辨率缩放/坐标映射是已知坑 |
| [openai/openai-cua-sample-app](https://github.com/openai/openai-cua-sample-app) | 1.9k | MIT | OpenAI CUA 三种环境示例 | **同一 agent 循环可插三种后端**（本地 Docker 桌面 / Browserbase 云浏览器 / 本地 Playwright）；环境抽象很干净 |
| [bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | 39k | Apache-2.0 | 多模态 GUI Agent 全栈（Agent TARS） | **端到端 VLM 坐标输出**；桌面用 **nut.js** 注入、浏览器用 DOM/GUI 混合；`computer operator` 与 `browser operator` 分层 |
| [bytedance/UI-TARS](https://github.com/bytedance/UI-TARS) | 11.5k | Apache-2.0 | 面向 GUI 的原生 VLM | 模型侧 action space / 训练数据格式；**grounding 与 reasoning 分离**的实践来源 |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | 25.4k | MIT（**权重 CC-BY-4.0**） | 纯视觉屏幕解析 | **截屏 → 结构化元素**：图标检测(YOLO)+描述(BLIP/Florence)+可交互性打分，输出带 bbox 的元素列表；把"看得见"变成"点得到"，是视觉路线的核心组件 |
| [OthersideAI/self-operating-computer](https://github.com/OthersideAI/self-operating-computer) | 10.3k | MIT | 最小可用的多模态"操作电脑" | **最简循环**：截图 → 模型出坐标 → pyautogui 执行；**Set-of-Mark / OCR 模式**（在截图上画编号再让模型点编号）显著改善 grounding |
| [bytebot-ai/bytebot](https://github.com/bytebot-ai/bytebot) | 11.1k | Apache-2.0 | 自托管容器化桌面 agent（**已归档 2025-09**） | **HTTP 动作 API** 设计干净：`screenshot` / `click_mouse` / `type_text`，Docker Compose 一键起 Ubuntu+桌面；**归档状态 = 只借鉴，不要依赖** |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) | 12.3k | Apache-2.0 | 像人一样用电脑的 agent 框架 | **推理模型与 grounding 模型分离**（主模型 + UI-TARS-7B 只负责定位）；**经验记忆**（检索历史轨迹复用）；分辨率参数显式化 |
| [trycua/cua](https://github.com/trycua/cua) | 23k | MIT | computer-use 的 driver/沙箱/评测栈 | **driver 抽象**：同一 action API 跨 macOS VM / Linux 容器 / Windows；云 fleet + 评测 + 轨迹导出 |
| [OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | 1.7k | MIT | 录制 GUI 演示 → 编译为可重放程序 | **record/replay + 独立验证（VERIFIED）**；适配器覆盖 DOM/A11y/OCR/UIA/AT-SPI；截图本地留存、只上传元数据 |
| [microsoft/UFO](https://github.com/microsoft/UFO) | 9.8k | MIT | Windows 桌面 agent（UFO³ 多设备编排） | **用 OS 原生可访问性 API（UIA）而非视觉**；多 agent/多设备编排 |
| [All-Hands-AI/OpenHands](https://github.com/OpenHands/OpenHands) | 88k | MIT | AI 软件开发 agent（含浏览器） | 浏览器作为**容器内 runtime 的一个工具**，与 shell 同级；沙箱边界设计 |
| [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) | 23k | **AGPL-3.0** | 浏览器工作流自动化 | ⚠️ 仅借鉴"vision + DOM 混合、表单语义"思路；**代码不可进本仓** |
| [lightpanda-io/browser](https://github.com/lightpanda-io/browser) | 35.4k | **AGPL-3.0** | 为 AI 设计的极轻 headless 浏览器（Zig） | 内存/启动成本极低的思路；**AGPL + 部分 CDP 兼容，不可内嵌** |
| [browserless/browserless](https://github.com/browserless/browserless) | 13.7k | 非商业免费 | 容器化 headless 浏览器服务 | "浏览器即服务"的并发/隔离/回收模型；**非 OSI 许可，仅参考运维设计** |

### 1.2 小众但设计精巧的宝藏（<1k~16k，重点看思路）

| 项目 | Stars | 许可证 | 一句话定位 | 可借鉴点 |
|---|---:|---|---|---|
| [sidorares/node-x11](https://github.com/sidorares/node-x11) | 536 | MIT | **纯 JS 的 X11 协议客户端** | 🔥 不装 xdotool/scrot，直接用 X11 协议做 **XGetImage 截屏 + XTEST 输入**；与"零依赖"哲学完全同构 |
| [cyrus-and/chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface) | 4.5k | MIT | 极简 CDP Node 客户端 | CDP 消息 id/session 管理、事件订阅的**最小实现范本**（我们照它的形状写，但不引它） |
| [AgentDeskAI/browser-tools-mcp](https://github.com/AgentDeskAI/browser-tools-mcp) | 7.3k | MIT | 接上**用户真实 Chrome** 看 console/网络 | 🔥 "attach 到已有浏览器（CDP endpoint）"而非自起浏览器；调试信息直供模型 |
| [mediar-ai/screenpipe](https://github.com/mediar-ai/screenpipe) | 21.6k | 未核实（疑 MIT） | 本地持续录屏 + OCR + a11y，做"电脑历史" | 🔥 **本地优先**：录屏/索引全部落本地 SQLite，给 agent 提供"刚才屏幕上有什么"；隐私边界值得抄 |
| [mediar-ai/terminator](https://github.com/mediar-ai/terminator) | 1.6k | MIT | "Windows 版 computer-use 的 Playwright" | 用 **UIA 树**做元素定位、语言绑定友好；Windows 版 a11y 路线样板 |
| [web-infra-dev/midscene](https://github.com/web-infra-dev/midscene) | 14.9k | MIT | 视觉驱动的跨端 GUI Agent / E2E | **截图式动作避免向模型灌大 DOM**，报告里给出成本对比；web/Android/iOS/PC 同一套 Agent API；原生注入用 libnut |
| [Kaliiiiiiiiii-Vinyzu/patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) | 4.6k | Apache-2.0 | 反检测版 Playwright | 当"自动化浏览器"被反爬拦截时的加固手段；**我们不一定需要，但要预留 endpoint 级替换** |
| [berstend/puppeteer-extra](https://github.com/berstend/puppeteer-extra) | 7.4k | MIT | Puppeteer 插件化（stealth 等） | 插件式增强 CDP 会话的思路；对应我们"一切皆插件" |
| [xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) | 3.1k | Apache-2.0 | 真实 OS 任务 benchmark | **action space 与评测 harness** 可直接作为我们验收任务的参照（VM + pyautogui） |
| [RaiMan/SikuliX1](https://github.com/RaiMan/SikuliX1) | 3.2k | MIT | 图像模板匹配点击（OpenCV） | 老派但有效：**"点这张图"** 作为 a11y 之外的第二定位原语 |
| [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser) | 7.7k | Apache-2.0 | 面向 agent 的浏览器沙箱 | 会话隔离、cookie/存储管理、按需回收 |
| [e2b-dev/E2B](https://github.com/e2b-dev/E2B) | 13.9k | Apache-2.0 | 安全沙箱环境 | computer-use 的**隔离执行边界**参考（云端；本地可用容器替代） |
| [nut-tree/nut-js](https://github.com/nut-tree/nut-js) | n/a（仓库页异常/已迁移） | MIT | Node 桌面自动化（键鼠） | Node 侧最成熟的键鼠库，但**依赖 native prebuilt（libnut）**，与零依赖冲突；UI-TARS-desktop/midscene 都在用 |
| [jordansissel/xdotool](https://github.com/jordansissel/xdotool) | 3.8k | BSD-3-Clause | X11 键鼠注入 + 窗口管理 | X11 事实标准；本机**未安装**，需检测后降级 |
| [ReimuNotMoe/ydotool](https://github.com/ReimuNotMoe/ydotool) | 2.4k | **AGPL-3.0** | 基于 /dev/uinput 的通用注入（X11/Wayland） | ⚠️ AGPL + 需常驻 root daemon + 键位映射坑；**只借鉴"uinput 通用注入"思路** |
| [atx/wtype](https://github.com/atx/wtype) | 563 | MIT | Wayland 键盘输入（virtual-keyboard 协议） | Wayland 下**无需 root** 的文本注入；只打字、不含鼠标 |
| [emersion/grim](https://github.com/emersion/grim) / [slurp](https://github.com/emersion/slurp) | 1.0k / 1.3k | MIT | Wayland 截屏 / 选区 | wlroots 系截图标准；依赖合成器协议，无会话则不可用 |
| [asweigart/pyautogui](https://github.com/asweigart/pyautogui) | 12.7k | BSD-3-Clause | 跨平台键鼠自动化 | 最广为人知的注入层；**X11-only（Wayland 不支持）**，Python 依赖 |
| [BoboTiG/python-mss](https://github.com/BoboTiG/python-mss) | 1.3k | MIT | ctypes 极速截屏 | X11 XGetImage 的高效实现参考 |
| [GNOME/at-spi2-core](https://github.com/GNOME/at-spi2-core) | 31（镜像） | **LGPL-2.1** | Linux 可访问性总线（AT-SPI2） | 🔥 **原生桌面的 a11y 树**（D-Bus），等价于 Web 的 accessibility tree；GTK/Qt 应用可枚举元素并触发动作 |
| [flatpak/xdg-desktop-portal](https://github.com/flatpak/xdg-desktop-portal) | 828 | **LGPL-2.1** | 桌面集成门户 | Wayland 下**唯一被官方认可的**截屏(ScreenCast/PipeWire)+输入(RemoteDesktop)通道；需用户同意弹窗与活跃会话 |
| [tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract) | 76.6k | Apache-2.0 | OCR 引擎 | 无 a11y 树时的**文字回退**：截图 → 文字 + 词框 → 可点击 |
| [bencevans/screenshot-desktop](https://github.com/bencevans/screenshot-desktop) | 501 | 未核实（疑 MIT） | Node 截屏小库 | 反模式样本：shell 调 scrot/imagemagick，工具缺失即失败 |

### 1.3 CDP / 浏览器底层

| 项目 | Stars | 许可证 | 可借鉴点 |
|---|---:|---|---|
| [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol) | 1.5k | BSD-3-Clause | 协议 JSON 权威定义；`Accessibility.getFullAXTree`、`Page.captureScreenshot`、`Input.*`、`Target.*` |
| [puppeteer/puppeteer](https://github.com/puppeteer/puppeteer) | 95.6k | Apache-2.0 | 生命周期/等待/下载/iframe 处理的成熟实现，作为行为对照 |
| [microsoft/playwright](https://github.com/microsoft/playwright) | 96.3k | Apache-2.0 | a11y snapshot/ref 语义与 auto-wait 的事实标准；本机已缓存其 chromium_headless_shell |
| [Kaliiiiiiiiii-Vinyzu/patchright-python](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python) | 1.5k | Apache-2.0 | 反检测分支的维护形态 |

> `chrome-headless-shell` 本身属于 Chromium（BSD-3-Clause 系），本机 `~/.cache/ms-playwright/chromium_headless_shell-{1234,1243}` 已存在，无需下载。

---

## 2. 元素识别路线之争：可访问性树 vs 纯视觉

| 维度 | 可访问性树 / DOM（Playwright MCP、browser-use 文本模式、UFO/AT-SPI） | 纯视觉（UI-TARS、OmniParser、self-operating-computer） |
|---|---|---|
| 输入 | 结构化文本（role/name/状态/ref） | 截图（可能叠加 Set-of-Mark 编号） |
| 定位 | **元素 ref → bbox，稳定** | 坐标 → 受 DPI/滚动/动画/遮挡影响，易偏 |
| Token 成本 | 低（可裁剪，只给可交互元素） | 一张图 = 固定高成本；多步则持续烧图 |
| 需要模型能力 | 普通文本模型即可 | **必须有多模态 + 强 grounding**，否则点不准 |
| 覆盖范围 | 语义化 DOM/a11y 良好的页面与应用 | canvas/WebGL/游戏/自绘 UI/无 a11y 的原生应用 |
| 确定性与可复现 | 高（可断言、可重放） | 低（同任务两次可能不同） |
| 失败模式 | a11y 树为空/被隐藏/iframe 隔离 | 小图标、密集列表、文字模糊 |

**我们的判断（具体）**
1. **默认 a11y**：CDP 的 `Accessibility.getFullAXTree` 是零成本拿到的，直接产出 `[ref=e12] button "提交"` 形态的 snapshot，动作按 ref 寻址。这就是 Playwright MCP 的做法，也是最省 token、最可测的。
2. **视觉降级**：当 snapshot 为空、或页面是 canvas/图片、或用户显式要求"看着点"时，走截图 + 可选 Set-of-Mark 编号；此时若本机没有强 grounding 模型，**只做"只读观察"不自动点击**（见 §4 降级阶梯）。
3. **原生桌面同理**：Linux 优先 AT-SPI2 树（LGPL，进程外调用，不算链接），退化到 X11 截图 + OCR。
4. **不要二选一**：把「感知」做成可插拔 seam，a11y / 视觉 / OCR 是同一 `ScreenSnapshot` 契约的三种 provider —— 与产品"一切皆插件"一致。

---

## 3. 分层方案（截屏 → 识别 → 注入 → 权限）

```
L4 权限/沙箱   ToolGuard 能力位 · 会话授权 · 域名白名单 · 步数/超时预算 · 审计 · 急停
L3 动作注入    Web: CDP Input.*        Desktop: XTEST(node-x11/xdotool) | uinput | portal
L2 元素识别    a11y tree / DOM ref  →  bbox  |  视觉(Set-of-Mark/OmniParser)  |  OCR
L1 截屏        Web: Page.captureScreenshot (headless，无需显示器)
               Desktop: Xvfb 虚拟显示 + XGetImage / scrot / grim(Wayland)
L0 运行边界    独立 user-data-dir · 非 root · 容器/VM · 网络命名空间 · 不读用户隐私文件
```

**接入产品的方式（不写代码，只给接入点）**：computer-use 是**一组新工具**（`computer_screenshot` / `computer_click` / `computer_type` / `computer_key` / `computer_navigate` / `computer_snapshot`），在 `packages/tools` 注册，浏览器/CDP 进程由 `packages/runtime` compose 期装配，权限判定走既有 **ToolGuard** seam（新增 capability，默认 `Deny`，由 session grant 放行）。不要在 `core` 里写死任何浏览器分支。

### 3.1 无显示器服务器上怎么落地

| 场景 | 可行性 | 做法 |
|---|---|---|
| **Web 自动化（主场景）** | ✅ 完全可行，**不需要显示器** | 起 `chrome-headless-shell --headless --remote-debugging-port=0 --user-data-dir=<tmp> --disable-gpu --disable-dev-shm-usage`，从 `/json/version` 取 `webSocketDebuggerUrl`，直连 CDP |
| **原生桌面 GUI** | ✅ 可行但价值有限 | `Xvfb :99`（已装）+ X11 截屏/注入。但本机没有可操作的 GUI 应用，除非后续装桌面栈；先用于自测 |
| **Wayland** | ❌ 无显示器服务器上不可行 | 需要活跃用户会话 + portal 同意弹窗 + PipeWire。**不作为服务端目标**；仅当产品跑在用户桌面时可选支持 |
| **已有图形会话** | 视环境 | 若 `DISPLAY` 存在，可直接控制真实桌面（此时权限模型尤其重要） |

**降级阶梯（从强到弱，按能力探测自动降）**
1. 完整：CDP Web 操控 + Xvfb 桌面操控
2. Web-only：CDP headless（截图 + 输入 + a11y 全都有）
3. a11y-only：只给元素树、不截图（省 token/带宽，适合纯文本模型）
4. 只读观察：只截图给模型看，不允许点击/输入
5. 退出：回到既有 shell/HTTP/文件工具（**默认必须能干净降级，不能因缺工具而报错卡死**）

### 3.2 权限 / 沙箱（这一层决定能不能上线）

- **默认关闭**，按会话 grant 开启；能力位粒度到「截图 / 导航 / 点击输入 / 下载 / 访问文件」。
- **域名/应用白名单**：默认只允许用户显式给出的 origin；`file://`、`chrome://`、下载默认拒绝。
- **预算**：每任务最大步数、最大时长、最大截图数；超限即停并汇报（对齐 `step_limit` 语义）。
- **审计**：每个动作落 append-only 日志（url、ref、动作、结果），可回放。
- **隐私**：截图默认本地、短暂、不入库；密码框/敏感字段打码；不把截图上传第三方。
- **隔离**：独立 user-data-dir、非 root；理想是容器/VM。**注意权衡**：Anthropic 官方明确要求跑在 VM/容器里，因为模型能操作整台机器；本产品是本地优先，至少要提供"受限 profile"。
- **急停**：一个全局 kill switch，任意时刻终止浏览器与待执行动作。

### 3.3 零依赖 CDP 路线：值不值得走？

**结论：值得，但定位要窄。**

支持理由：
1. **依赖成本**：产品当前运行时依赖极少（见 `docs/DEPENDENCY-POLICY.md` §7），引入 Playwright/Puppeteer 会带来庞大依赖树与 native 二进制管理，违背既有策略。
2. **语言能力已就位**：Node 26 原生 `fetch` + 全局 `WebSocket`，CDP 只是「WebSocket 上发 JSON-RPC」。**零运行时依赖成立**。
3. **浏览器已在**：`chrome-headless-shell` 已被 Playwright 缓存，直接复用，不需要我们再下 Chromium。
4. **覆盖面足够**：截图、导航、a11y 树、鼠标/键盘/文本注入、evaluate、网络与 console 观测，全在协议内。

风险与边界（必须承认）：
- **不要重造 Playwright**：等待策略、iframe/shadow DOM、下载、多标签页、反检测、跨浏览器兼容——这些是 Playwright 多年积累。我们只实现**最小核心**，遇到复杂页面允许 `Runtime.evaluate` 兜底。
- **必须有 escape hatch**：支持 `--cdp-endpoint` 连接用户已开的 Chrome，协议层相同，既能用真实登录态，也避免自起浏览器。
- **chrome-headless-shell 是新 headless 之前的旧内核**（它本身就是 Playwright 的 headless shell），无扩展；需要扩展/真实 GPU 时改用完整 Chromium（可选，不进默认路径）。
- **沙箱硬约束（另一路 worker 实测）**：在受限沙箱里跑 Chromium 有两个硬阻塞——**RLIMIT_AS 必须豁免**（否则 Chromium 因虚拟地址预留失败 SIGTRAP/exit 133）、**netns 必须共享**（否则 CDP 回环端口连不上）。**产品自身进程树（systemd 服务）不受这两个限制**，所以 CDP 在生产路径可行；但若未来在 DSH 沙箱内自测，必须显式处理这两点。

**最小 CDP 客户端范围（约几百行）**：连接/重连、id→Promise 映射、事件订阅、`Target.attachToTarget` 扁平会话、命令白名单（`Page.navigate/captureScreenshot`、`Runtime.evaluate`、`Accessibility.getFullAXTree`、`DOM.getBoxModel`、`Input.dispatchMouseEvent/dispatchKeyEvent/insertText`、`Emulation.setDeviceMetricsOverride`）。

---

## 4. 第一个可交付切片（建议范围）

**切片名：`computer-use-web`（只做 Web，只读+基础动作，默认关闭）**

1. **CDP 客户端 + 启动器**：拉起/连接 `chrome-headless-shell`，取 ws endpoint，实现命令/事件最小闭环。
2. **三个工具**：`computer_screenshot`（返回 PNG + 尺寸）、`computer_snapshot`（a11y 树 → `ref` 列表）、`computer_act`（click/type/key/scroll/navigate，按 ref 或坐标）。
3. **ref 解析**：ref → backendNodeId → `DOM.getBoxModel` → 视口坐标 → `Input.dispatchMouseEvent`；这是把"识别"与"注入"解耦的关键。
4. **权限**：新 capability，默认 `Deny`，会话 grant 开启；域名白名单；步数/超时预算；动作审计。
5. **降级探测**：找不到浏览器二进制/无法启动 → 返回结构化不可用，不抛异常；`DISPLAY` 存在时可切 X11 路径（第二阶段）。

**明确不在第一切片**：原生桌面、Wayland、视觉 grounding 模型、OmniParser 集成、多标签页、下载、文件上传、录制回放。

---

## 5. 反模式清单（别人做砸的地方，我们不要学）

1. **只给坐标、不给元素引用**：截图+坐标是脆弱的，DPI/滚动/动画一变就点错。→ 默认 ref，坐标是降级。
2. **把整页 DOM 灌给模型**：token 爆炸且噪声大。→ a11y 裁剪 / 只给可交互元素（stagehand 的 trimming、Playwright MCP 的 snapshot）。
3. **shell 调外部工具且不检测**：`screenshot-desktop` 调 scrot/imagemagick，缺工具就崩。→ 能力探测 + 明确降级；本机 xdotool/scrot 都没装。
4. **依赖 AGPL 组件**：ydotool、Skyvern、Lightpanda 的代码一旦链接/复制，整个产品受 AGPL 约束。→ **只借鉴设计，代码不碰**。
5. **在没有隔离的宿主上让模型操作整机**：Anthropic 官方都要求容器/VM。→ 默认受限 profile + 会话授权 + 急停。
6. **静默把截图/页面内容外传**：隐私事故。→ 本地优先、短暂留存、敏感字段打码（对齐 screenpipe 的本地化思路）。
7. **没有步数/超时预算的 agent 循环**：会无限点、烧钱、卡死。→ 预算耗尽明确不等于完成（对齐现有 `step_limit` 语义）。
8. **没有验证的"成功"**：模型说完成就完成。→ 动作后校验（URL/元素/文本），对齐 OpenAdapt 的 VERIFIED 思路。
9. **依赖已归档项目当基础设施**：Bytebot 已 archived（2025-09），nut.js 仓库状态异常。→ 参考可以，别做依赖。
10. **在 Wayland 无会话环境硬做截屏**：grim/portal 都拿不到会话。→ 明确列为不支持，走降级。
11. **把 computer-use 做成"必须开"**：本地优先产品里这是高风险能力。→ 默认关，按需授权。
12. **为"好看"引入重型依赖**：为几个截图 API 拖进 Playwright 全家桶，破坏零依赖与供应链面。→ 最小 CDP 或纯 JS X11。

---

## 6. 不确定 / 未核实项

- 部分项目的许可证在页面抓取时未取到（screenpipe、suna、browserless、at-spi2-core 镜像、screenshot-desktop）：**采用前必须逐仓核对 LICENSE 原文**。browserless 是「非商业免费」而非 OSI 许可。
- OmniParser：仓库 MIT，但**模型权重标注 CC-BY-4.0**；权重是否可商用需再核。
- AT-SPI2 / xdg-desktop-portal 为 **LGPL-2.1**：通过 D-Bus/portal 进程外调用通常不构成链接，但法务口径需确认。
- `chrome-headless-shell` 对 `Accessibility.getFullAXTree` 的完整度未在本机验证（协议支持，行为需实测）。
- RLIMIT_AS / netns 的结论来自另一路 worker 的实测，本文只转述，不重复实验。
- 各项目 stars 为抓取时点数值，会变动。

---

## 7. 来源链接

- browser-use — https://github.com/browser-use/browser-use
- Playwright MCP — https://github.com/microsoft/playwright-mcp
- Stagehand — https://github.com/browserbase/stagehand
- Anthropic computer-use demo — https://github.com/anthropics/anthropic-quickstarts
- OpenAI CUA sample app — https://github.com/openai/openai-cua-sample-app
- UI-TARS desktop — https://github.com/bytedance/UI-TARS-desktop ／ UI-TARS — https://github.com/bytedance/UI-TARS
- OmniParser — https://github.com/microsoft/OmniParser
- self-operating-computer — https://github.com/OthersideAI/self-operating-computer
- Bytebot（已归档）— https://github.com/bytebot-ai/bytebot
- Agent-S — https://github.com/simular-ai/Agent-S
- trycua/cua — https://github.com/trycua/cua
- OpenAdapt — https://github.com/OpenAdaptAI/OpenAdapt
- Microsoft UFO — https://github.com/microsoft/UFO
- OpenHands — https://github.com/OpenHands/OpenHands
- Skyvern（AGPL）— https://github.com/Skyvern-AI/skyvern
- Lightpanda（AGPL）— https://github.com/lightpanda-io/browser
- Browserless — https://github.com/browserless/browserless
- node-x11 — https://github.com/sidorares/node-x11
- chrome-remote-interface — https://github.com/cyrus-and/chrome-remote-interface
- browser-tools-mcp — https://github.com/AgentDeskAI/browser-tools-mcp
- screenpipe — https://github.com/mediar-ai/screenpipe
- terminator — https://github.com/mediar-ai/terminator
- Midscene — https://github.com/web-infra-dev/midscene
- patchright — https://github.com/Kaliiiiiiiiii-Vinyzu/patchright ／ patchright-python — https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python
- puppeteer-extra — https://github.com/berstend/puppeteer-extra
- OSWorld — https://github.com/xlang-ai/OSWorld
- SikuliX — https://github.com/RaiMan/SikuliX1
- Steel Browser — https://github.com/steel-dev/steel-browser
- E2B — https://github.com/e2b-dev/E2B
- nut.js — https://github.com/nut-tree/nut-js
- xdotool — https://github.com/jordansissel/xdotool
- ydotool（AGPL）— https://github.com/ReimuNotMoe/ydotool
- wtype — https://github.com/atx/wtype
- grim — https://github.com/emersion/grim ／ slurp — https://github.com/emersion/slurp
- pyautogui — https://github.com/asweigart/pyautogui
- python-mss — https://github.com/BoboTiG/python-mss
- screenshot-desktop — https://github.com/bencevans/screenshot-desktop
- AT-SPI2 — https://gitlab.gnome.org/GNOME/at-spi2-core （镜像 https://github.com/GNOME/at-spi2-core）
- xdg-desktop-portal — https://github.com/flatpak/xdg-desktop-portal ／ wlr 后端 — https://github.com/emersion/xdg-desktop-portal-wlr
- Tesseract OCR — https://github.com/tesseract-ocr/tesseract
- DevTools Protocol — https://github.com/ChromeDevTools/devtools-protocol
- Puppeteer — https://github.com/puppeteer/puppeteer ／ Playwright — https://github.com/microsoft/playwright
- 仓内相关约束：docs/DEPENDENCY-POLICY.md、docs/ARCHITECTURE.md
