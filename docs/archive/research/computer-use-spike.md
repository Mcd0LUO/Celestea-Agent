# 零依赖 CDP 驱动无头浏览器：本机 spike 报告

> 状态：**历史参考**。本文件是调研/迁移阶段的记录，W890 起归档到 `docs/archive/`；现行口径见 [`docs/README.md`](../../README.md)。
> 📦 **历史文档**。

| 项 | 值 |
| --- | --- |
| 仓库 | /src/celestea_studio-ts（main @ 45cd013） |
| 任务 | 用 Node 原生 fetch + 全局 WebSocket 直连 CDP，驱动 ~/.cache/ms-playwright 里的 chrome-headless-shell，判断「零依赖 computer-use」可行性 |
| 性质 | **只读 spike**：未改产品源码/配置，未跑 pnpm build/test/check，未重启服务，未 apt/联网装包；唯一新建文件 = 本报告 |
| 机器 | Linux，无 DISPLAY/Wayland/X socket；Xvfb 已装但**本 spike 未用到**（headless 模式不需要） |
| Node | v26.8.2（原生 fetch + 全局 WebSocket） |

---

## 0. 结论先行

**可行——零 npm 依赖的 CDP 路线在本机完整跑通**（导航/取标题/截图/真实点击/真实输入/AX 元素树/自定义视口/并发 2 实例，5/5 稳定）。
**但「直接塞进产品现有沙箱」不可行**，有两个相互独立的硬阻塞：

1. **RLIMIT_AS 杀死 Chromium**：产品默认 memMb=2048（packages/tools/src/sandbox/rlimit.ts:57 的 --as=2048MB）下，浏览器在打印任何日志之前就 **SIGTRAP，退出码 133**；实测需要 **>32GiB** 的 AS 才活得下来（32GiB 仍 133，64GiB ALIVE）。
2. **bwrap 默认网络隔离**：--unshare-all 让浏览器起得来但**联网与 127.0.0.1 全部 fetch failed**；而且 DevTools 的 ws:// 端点落在隔离 netns 里，**宿主侧的 CDP 驱动够不到它**。需要 --share-net（产品旋钮 CELESTEA_SANDBOX_NET=1）或把驱动放进同一 netns。

关键正面证据（1243 = Chrome for Testing 153.0.8010.12）：
- 冷启动到 DevTools 端点：**0.084–0.168s（均值 0.115s）**；
- 连 CDP→建 target→导航→取标题→截图→输入→点击→AX 树整条链路：**199–295ms**；
- 截图：**23–51ms（均值 33.4ms）**，800x600 PNG 默认，视口可改（实测 1280x800）；
- AX 树：example.com 15 节点/5.8KB；**本机 Studio 首页 3687 节点/1.23MB**（元素识别的素材量级要正视）。

---

## 1. 定位 headless shell + --version

~~~bash
find ~/.cache/ms-playwright -maxdepth 3 -type f -name 'chrome-headless-shell'
/usr/bin/time -f 'elapsed=%e exit=%x' <BIN1243> --version
~~~

原始输出：

~~~
~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell

=== 1243 --version ===
Google Chrome for Testing 153.0.8010.12
rc=0
elapsed=0.03 exit=0
=== 1234 --version ===
Google Chrome for Testing 151.0.7922.34
rc=0
elapsed=0.31 exit=0
~~~

二进制 ~197MB，ELF pie，可执行位正常。ffmpeg-1011 也在缓存里（本 spike 未用）。

## 2. 启动 + 抓 ws:// DevTools 端点

~~~bash
UDD=$(mktemp -d /tmp/w885-cdp-XXXX)
<BIN> --headless --no-sandbox --remote-debugging-port=0 --user-data-dir="$UDD" about:blank 2>stderr &
# 轮询 stderr 直到出现 "DevTools listening"
~~~

原始 stderr（耗时 0.118s 到端点）：

~~~
[ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: ...
DevTools listening on ws://127.0.0.1:35817/devtools/browser/ab726189-b076-4f94-861e-9b077bb403a0
[ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: ...
~~~

- dbus 报错是噪声（容器无 dbus），不影响。
- --remote-debugging-port=0 选临时端口，端口号只能从 stderr 或 user-data-dir/DevToolsActivePort 拿。

## 3. 纯 Node 零依赖 CDP 脚本（/tmp/w885-cdp/cdp.mjs，131 行）

零 npm：只用 node:fs + 全局 WebSocket + JSON。协议封装：send(method, params, sessionId) + id 匹配 + 超时（timer.unref()，否则进程多活 20s）。流程与原始 RESULT：

命令：

~~~bash
node /tmp/w885-cdp/cdp.mjs "$WS" '<data-url>' /tmp/w885-cdp/shot-data.png
~~~

原始输出（data: URL）：

~~~
RESULT {"target_url":"data:text/html,<title>Hello CDP</title>...","connect_ms":107,"ready_state":"complete","ready_ms":28,
"title":"Hello CDP","href":"data:...",
"screenshot":{"path":"/tmp/w885-cdp/shot-data.png","bytes":2950,"ms":49},
"input":{"value":"w885-typed","error":null},
"click":{"__clicked":1,"error":null},
"ax":{"nodes":10,"json_bytes":4695,"ms":6},
"total_ms":295}
wall=0.36 exit=0
~~~

真实页面：

~~~
=== https://example.com/ ===
RESULT {... "title":"Example Domain","ready_ms":922,
"screenshot":{"bytes":17585,"ms":53},"ax":{"nodes":15,"json_bytes":5807,"ms":3},"total_ms":1168}

=== http://127.0.0.1:3777/ ===
RESULT {... "title":"Celestea Studio","ready_ms":313,
"screenshot":{"bytes":41919,"ms":90},"ax":{"nodes":3687,"json_bytes":1232824,"ms":261},"total_ms":1252}
~~~

截图确认为真实渲染（已用 read_image 目视核对）：example.com 页面、以及本机 Studio 首页（顶栏/输入框/发送按钮齐全）。
- Target.createTarget / Target.attachToTarget(flatten) / Page.navigate / Runtime.evaluate / Page.captureScreenshot / Input.insertText / Input.dispatchMouseEvent / Accessibility.getFullAXTree 全部工作。
- 输入：Input.insertText 后 #i.value = "w885-typed"。
- 点击：mousePressed+mouseReleased 后 window.__clicked = 1。
- 自定义视口：Emulation.setDeviceMetricsOverride 1280x800 → window.innerWidth=1280，PNG 1280x800 / 4714B，Page.getLayoutMetrics.cssContentSize=1280x800。

## 4. 沙箱兼容：RLIMIT_AS 对照（prlimit）

~~~bash
prlimit --as=<BYTES> <BIN> --headless --no-sandbox --remote-debugging-port=0 ...
~~~

原始结论：

| AS 限制 | 结果 |
| --- | --- |
| 无限制（plain） | **ALIVE**（端点出现；kill 后 143） |
| 2 GiB (2147483648) | **DIED rc=133（SIGTRAP）**，stderr 空 |
| 3 GiB | DIED rc=133 |
| 4 GiB | DIED rc=133 |
| 8 GiB | DIED rc=133 |
| 16 GiB | DIED rc=133 |
| 32 GiB | DIED rc=133 |
| 64 GiB | **ALIVE** |

产品默认正是 2 GiB：packages/tools/src/sandbox/limits.ts:46 DEFAULT_LIMITS.memMb = 2048，rlimit.ts:57 转成 --as=2048MB。
结论：**Chromium/V8 需要 >32GiB 虚拟地址空间**；这不是「调大一点点」能解决的，产品沙箱必须对浏览器进程**豁免 RLIMIT_AS**（或改走独立 provider）。
附注：产品默认 core=true 时 rlimit.ts:61 是 --core=0（禁 core），比裸 prlimit 更干净；裸测时 shell 报了 "core dumped"，但仓库内未落 core 文件（已检查）。

## 5. 从产品沙箱路径启动浏览器（UserspaceSandbox / BwrapSandbox）

用 tsx 从 /tmp 导入产品源码（未改任何文件）：

~~~ts
import { buildSandboxConfig, UserspaceSandbox, BwrapSandbox, probeHost } from "@celestea/tools";
~~~

每条场景在沙箱内执行同一条自包含命令：启动浏览器→轮询端点→写 /tmp→node fetch example.com→node fetch 127.0.0.1:3777→杀进程。

原始输出：

~~~
=== A userspace rlimits=false exit=0 ms=1962 meta={"provider":"userspace","net_isolated":false,"tmp_private":false}
BROWSER_ALIVE endpoint=ws://127.0.0.1:43817/...
WRITE_TMP_OK
NET_OK=200
LOCAL_OK=200

=== B userspace rlimits=true (RLIMIT_AS=2048MB) exit=0 ms=1162
BROWSER_DIED rc=133
WRITE_TMP_OK
NET_OK=200
LOCAL_OK=200

=== C bwrap rlimits=true (isolated net+tmp, ro root) exit=0 ms=483
BROWSER_DIED rc=133
WRITE_TMP_OK
NET_ERR=fetch failed
LOCAL_ERR=fetch failed

=== D bwrap rlimits=false shareNet=true exit=0 ms=1210
BROWSER_ALIVE endpoint=ws://127.0.0.1:34885/...
NET_OK=200
LOCAL_OK=200

=== E bwrap rlimits=false shareNet=false (默认) exit=0 ms=593
BROWSER_ALIVE endpoint=ws://127.0.0.1:36947/...
NET_ERR=fetch failed
LOCAL_ERR=fetch failed
~~~

如实报告被拒/受限的地方：
- **写 /tmp：允许**（bwrap 下是私有 tmpfs，沙箱外看不到）。
- **监听本地端口：允许**（浏览器能 bind）。
- **访问网络 / 127.0.0.1：默认 bwrap 下被拒**（--unshare-all）；userspace 下允许。
- **RLIMIT_AS：2GiB 直接 SIGTRAP**（userspace 与 bwrap 都一样）。
- 注意：B 场景浏览器死了但整条 shell 命令 exit=0（后续命令继续），所以「命令成功」不能作为浏览器可用的判据——必须显式解析 BROWSER_ALIVE/端点。

## 6. 稳定性 / 泄漏 / 并发

连续 5 次启动→CDP 全链路→关闭：

~~~
RUN 1..5 rc=0  startup_s = .114/.084/.101/.106/.168
RESULT ... screenshot.ms = 37/33/23/23/51 ... ax.nodes=10 ... total_ms = 237/215/206/199/272
summary {"runs":5,"success":5,"rate":1,"avg_startup_s":0.1146,"avg_screenshot_ms":33.4,"avg_total_ms":225.8}
~~~

进程树（headless shell 会 fork）：launcher + 2x zygote + gpu-process + network utility + renderer = 约 6–7 个子进程。
- 只对 launcher 发 SIGTERM，+1.5s 后全部回收（进程数回到基线 2，含测试自身的 bash）；未发现残留。
- 并发 2 个实例：各自独立端口/ profile，双双成功（total 301/317ms）。

---

## 7. 最小可用工具面建议

推荐 **2 个工具 + 1 个可选**，默认返回「文本 AX 快照 + PNG 图像」：

1. browser_open
   - 入参：url（必填）、viewport {width,height}（可选，默认 1280x800）
   - 行为：复用/新建一个 per-session 浏览器与 page，Page.navigate，等 load
   - 返回：{url, title, ax_snapshot(过滤后), screenshot(image/png), console_errors?}
2. browser_act
   - 入参：action: click|type|key|scroll|hover|wait_for；target（来自快照的 ref，或 {role,name} / selector）；text（type 用）；key；timeout_ms
   - 行为：Input.dispatchMouseEvent / Input.insertText / Input.dispatchKeyEvent / Input.dispatchMouseEvent(wheel) / 轮询
   - 返回：动作后的新快照（文本+图像）
3. （可选）browser_read
   - 入参：selector 或全页
   - 返回：innerText / 结构化元素列表（不截图）

设计要点：
- **元素识别用 AX 树**（Accessibility.getFullAXTree），节点里用 backendDOMNodeId 作稳定 ref；但必须先**过滤/截断**：Studio 首页 3687 节点/1.23MB 不能整棵塞给模型。建议只留有 name 的 role ∈ {button, link, textbox, checkbox, radio, combobox, menuitem, tab, heading}，上限（如 200 节点 / 32KB），并附节点数。
- **截图返回为图像**（image content），AX/文本走文本；两者同一轮返回便于模型对齐。
- 浏览器**每会话常驻**（启动 0.1s，但没必要每次重建），快照按需。
- 明确的失败语义：端点抓不到、浏览器 rc=133、导航超时都要结构化返回，不要静默。

## 8. 风险与坑清单

1. **RLIMIT_AS（最高优先级）**：产品默认 2GiB → SIGTRAP 133。可行修法：给浏览器进程单独 provider/命令，**不套 --as**；或 memMb 提到 >=64GiB（不现实）。豁免 AS 后必须另找资源上限手段（cgroup v2 memory.max / 独立 rlimit 不含 AS / 只对 node 驱动设 AS）。
2. **bwrap 网络隔离**：--unshare-all 默认断网 + 断 localhost，且 CDP 端点不可达。可行修法：浏览器容器 --share-net（CELESTEA_SANDBOX_NET=1）或把 CDP 驱动与浏览器放同一 netns（run_code 在沙箱内跑 TS 程序正好是这个形状）。但 share-net 会放大攻击面。
3. **CDP 端点无鉴权**：ws://127.0.0.1:PORT 一旦 share-net，宿主任何本地进程都能连；缓解：临时端口 + 短生命周期 + 用完即杀 + user-data-dir 隔离。
4. **--no-sandbox 必需**（容器内无 userns/root），意味着**网页内容不被 Chromium 自身沙箱隔离**，只能靠外层沙箱兜底——与外层「无网络隔离」叠加时要特别小心。
5. **进程树与泄漏**：每个浏览器 6–7 进程；必须对**整个进程组**发信号并删 user-data-dir；RLIMIT_NPROC 是 UID 全局线程数（nproc 派生已含 headroom，但并发浏览器会吃额度）。
6. **端口与并发**：端口只能从 stderr / DevToolsActivePort 拿；并发实例要独立 profile 目录；建议上限（如每宿主 2–4 个）。
7. **/tmp 语义**：bwrap 下 /tmp 是私有 tmpfs——截图/下载要么走 stdout（base64），要么把 programDir 之类 bind 出来；不能假设宿主能直接读沙箱内 /tmp。
8. **AX 树体积**：真实应用可达 MB 级，必须过滤+封顶，否则一次快照就吃掉上下文。
9. **core dump**：产品默认 --core=0（好）；自建启动路径要记得关 core，避免 SIGTRAP 时落大 core。
10. **dbus 噪声**：stderr 有 dbus 报错，解析端点时不要把它当失败。
11. **seccomp 未测**：若开 CELESTEA_SANDBOX_SECCOMP=1，Chromium 的 syscall 面很可能被白名单拒绝（本 spike 未测）。
12. **容器 /dev/shm**：未测 --disable-dev-shm-usage；小 /dev/shm 可能导致渲染不稳。

## 9. 我**没能验证**的部分（明确列出）

- 没有走**真正的 run_code broker / run_shell 工具调用**（只直接构造了 UserspaceSandbox/BwrapSandbox 跑同一命令）；也没接 LLM 工具回路。
- 没有开 **CELESTEA_SANDBOX_SECCOMP=1**、没有测 bwrap seccomp 过滤器下 Chromium 是否被拒。
- 没有测 **--disable-dev-shm-usage** / 小 /dev/shm 场景；没有测 ffmpeg 录屏。
- 没有测 file://、下载、上传、证书错误、代理、cookie 持久化、多 tab 切换。
- 没有测长时稳定性（只 5 次）与浏览器 RSS/CPU 占用；没有测 >2 并发。
- 没有在 Windows/macOS 上验证（本机 Linux）。
- 没有验证产品里 CELESTEA_SANDBOX_NET=1 的端到端链路（只测了 BwrapSandbox 的 shareNet 选项）。
- 没有测 RLIMIT_AS 豁免后如何补回资源限额（cgroup 等）。
- 没有验证「沙箱内驱动 vs 沙箱外驱动」的最终架构选择（只是给出可行修法）。

## 10. 复现脚本清单（都在 /tmp，不在仓库）

- /tmp/w885-cdp/cdp.mjs —— 零依赖 CDP 驱动（131 行）
- /tmp/w885-cdp/cdp-viewport.mjs —— 视口控制
- /tmp/w885-cdp/sandbox-probe.ts / sandbox-probe2.ts —— 产品沙箱场景 A–E
- /tmp/w885-cdp/shot-*.png —— 截图产物（data/example/local/viewport/conc/st-*）
