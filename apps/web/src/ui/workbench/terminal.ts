// ============================================================================
// ui/workbench/terminal.ts — W1528：工作台终端面板（**真 PTY**）。
// ----------------------------------------------------------------------------
// 与上一版的区别（这是本波的核心）：旧版打 POST /api/exec，跑完才返回，界面上
// 明写「一次性执行（不是交互式终端）」。现在打的是 POST /api/terminal —— 沙箱内
// 一个**真 pty**（util-linux script(1) 垫片），有提示符、有 stdin、有持续输出，
// 能跑 python3 REPL / top。输出经 SSE \`terminal\` 事件持续下行。
//
// 生命周期（面板关闭 / 会话切换 / 页面卸载都要杀，进程泄漏 = 真 bug）：
//   · panel.ts 的 renderTerminalPanel 每次重建都先关掉旧 pty；
//   · 本模块登记 pagehide 监听（一次性），卸载时同步尽力关闭；
//   · 服务端另有空闲回收兜底（客户端整个崩掉也不会留孤儿）。
// 竞态沿用 state.ts 的 seq：晚到的打开结果不再被采纳（面板已换会话/已关闭）。
// ============================================================================
import { el } from '../../utils/dom';
import { nextSeq, type PanelState } from './state';
import type { PtySession } from './terminal-pty';
import { t } from '../../i18n';

/**
 * W1528：传输层也**懒加载**。
 *
 * 理由与 xterm 那条一样，只是量级小些：终端传输层（订阅接线 / 关闭 / 卸载兜底）
 * 对**从不打开终端**的用户是纯粹的负担，而 \`import('./terminal-pty')\` 让它整体
 * 落到一个按需 chunk 里。本模块只留面板渲染（几百字节），主包因此不因本特性变大。
 *
 * 动态 import 在 Vite/vitest 里按**解析后的模块 id** 去重，所以测试对
 * \`terminal-pty.ts\` 注入的假 xterm / 假帧源，和这里拿到的是同一个实例。
 */
let ptyModule: typeof import('./terminal-pty') | null = null;

async function pty(): Promise<typeof import('./terminal-pty')> {
  if (ptyModule === null) ptyModule = await import('./terminal-pty');
  return ptyModule;
}

interface TerminalData {
  /** 已建立的 pty（null = 尚未打开 / 已关闭）。 */
  session: PtySession | null;
  /** 非空 = 结构化拒绝的可读文案（画拒绝，绝不假装成终端）。 */
  refusal: string;
}

function dataOf(panel: PanelState): TerminalData {
  const d = panel.data as unknown as Partial<TerminalData> | undefined;
  if (d && typeof d.refusal === 'string') return d as TerminalData;
  const init: TerminalData = { session: null, refusal: '' };
  panel.data = init as unknown as Record<string, unknown>;
  return init;
}

/**
 * 关掉该面板持有的 pty（幂等）。
 *
 * panel.ts 在「面板已消失」时调用。刻意只依赖 \`panel.data\`（不依赖 kind /
 * title / dock）：调用方可能是已经从列表里摘掉的那个对象，能安全读到的只有它
 * 自己挂的载荷。
 */
export async function disposeTerminalPanel(panel: PanelState): Promise<void> {
  const data = dataOf(panel);
  const session = data.session;
  data.session = null;
  if (session === null) return;
  untrackSession(session);
  const mod = await pty();
  await mod.closePty(session);
}

/**
 * 活着的 pty 会话登记表 —— 页面卸载兜底的**唯一**真源。
 *
 * 为什么不能像第一版那样在 pagehide 闭包里捕获「当前那个面板」：面板会被关闭、
 * 会新开，闭包捕获的那个早就不是活的了（真机 CDP 实测：关面板正常回收 8→7，
 * 但直接导航走 8→8 —— 进程留在服务器上）。登记表让「谁还活着」与面板生命周期
 * 解耦：卸载时把表里**每一个**都关掉。
 */
const liveSessions = new Set<PtySession>();

/** 登记（openPty 成功后由 startPty 调用）。 */
function trackSession(session: PtySession): void {
  liveSessions.add(session);
  hookUnload();
}

/** 注销（任何一条关闭路径都要调，否则表会漏成泄漏源）。 */
function untrackSession(session: PtySession): void {
  liveSessions.delete(session);
}

let unloadHooked = false;
/** 页面卸载兜底：注册一次，关闭**所有**还活着的 pty。 */
function hookUnload(): void {
  if (unloadHooked) return;
  unloadHooked = true;
  window.addEventListener('pagehide', () => {
    const sessions = [...liveSessions];
    liveSessions.clear();
    if (sessions.length === 0) return;
    // ★ 必须**同步**发出关闭请求。第一版写成 \`void pty().then(...)\`（异步动态
    // import），真机 CDP 实测卸载后进程仍在 —— 卸载窗口里那个 promise 根本没机会
    // resolve。模块在 openPty 成功时就已经加载过（见 pty() 的缓存），所以这里同步
    // 拿得到；缓存为空说明从没开过终端，本就没有要关的东西。
    const mod = ptyModule;
    if (mod === null) return;
    for (const s of sessions) mod.closePtyOnUnload(s);
  });
}

/**
 * 渲染终端面板内容。
 *
 * 三条分支，互斥且都可读：
 *   ① 拒绝   —— 服务端结构化拒绝（档位不允许 / 本机无 pty / 终端数到顶）；
 *   ② 已连上 —— xterm 挂载点（pty 已经开好，输出持续流入）；
 *   ③ 未连上 —— 「打开终端」按钮（**用户点击才开**：开 pty 是起进程，
 *              不该在渲染时静默发生，尤其面板可能在离屏重建）。
 */
export function renderTerminalPanel(body: HTMLElement, panel: PanelState): void {
  const data = dataOf(panel);
  const off = el('div', 'wb-term');
  const note = el('div', 'wb-term-note', t('chat.wb.term.note'));
  off.appendChild(note);

  if (data.refusal !== '') {
    off.appendChild(el('div', 'wb-term-refusal', data.refusal));
  } else if (data.session !== null) {
    // ★ 复用会话**自己的**宿主元素，绝不新建。
    // xterm 的 open() 只认第一次：第二次调用既不抛错也不搬 DOM，新宿主永远是空的
    // （真机 CDP 实测：第二次 open 后新宿主 innerHTML.length === 0）。appendChild
    // 会把该节点从旧父节点移走，所以「重新挂载」= 把同一个元素放进新容器，
    // xterm 的内部引用始终有效，终端内容一字不丢。
    off.appendChild(data.session.host);
  } else {
    const open = el('button', 'wb-btn wb-term-open', t('chat.wb.term.open')) as HTMLButtonElement;
    open.type = 'button';
    off.appendChild(el('div', 'wb-term-hint', t('chat.wb.term.hint')));
    off.appendChild(open);
    open.addEventListener('click', () => {
      open.disabled = true;
      open.textContent = t('chat.wb.term.opening');
      void startPty(panel, body, nextSeq(panel.id));
    });
  }
  // ★ 必须把 \`off\`（.wb-term）本身放进去，而不是它的 childNodes。
  // .wb-term 是 \`display:flex; flex-direction:column; height:100%\` 的容器 —— xterm
  // 需要一条**有确定高度**的链路（.wb-body 有高度 → .wb-term 撑满 → .wb-term-xterm
  // flex:1 拿到剩余高度）。丢掉这一层，.wb-term-xterm 就是 .wb-body 里的普通块，
  // 高度塌成 0，xterm 一行都画不出来（真机 CDP 实测：hostH=0、xterm-rows=0）。
  // 第一版正是这么写的 —— 这也是「UI 改动必须真机验证」这条铁律的存在理由。
  body.replaceChildren(off);
  if (data.session !== null) requestAnimationFrame(() => { try { data.session?.fit.fit(); } catch { /* 未布局 */ } });
}

/**
 * 开一个 pty 并把面板换成 xterm。
 *
 * seq 竞态：开 pty 要一次网络往返，期间用户可能已关面板 / 切会话。晚到的结果
 * 直接**杀掉**（而不是渲染进一个不再属于它的面板）—— 不杀就是进程泄漏。
 */
async function startPty(panel: PanelState, body: HTMLElement, seq: number): Promise<void> {
  const data = dataOf(panel);
  // 与 renderTerminalPanel 同一条高度链路（.wb-term → .wb-term-xterm），否则
  // 打开期间宿主高度为 0，fit() 算出的行列是垃圾值。宿主本身由 openPty 创建
  // 并交给会话持有（见 PtySession.host）。
  const wrapper = el('div', 'wb-term');
  wrapper.appendChild(el('div', 'wb-term-note', t('chat.wb.term.note')));
  const placeholder = el('div', 'wb-term-xterm');
  wrapper.appendChild(placeholder);
  body.replaceChildren(wrapper);
  // 先量尺寸再开：pty 的几何在打开时固定（script(1) 持有 master，宿主无法
  // TIOCSWINSZ），所以初值要尽量贴近真实面板，否则首屏会折行错位。
  const cols = Math.max(20, Math.floor((body.clientWidth || 640) / 7.2));
  const rows = Math.max(8, Math.floor((body.clientHeight || 320) / 16));
  let result: { session: PtySession | null; refusal: string };
  try {
    const mod = await pty();
    result = await mod.openPty(activeSessionOf(panel), cols, rows);
  } catch (err) {
    // openPty 自己已经尽力回收了；这里只是不让异常冒成未处理拒绝。
    console.warn('[terminal] 打开失败：' + (err instanceof Error ? err.message : String(err)));
    result = { session: null, refusal: t('chat.wb.term.notStarted') };
  }
  // 竞态：面板已被关闭/换会话 ⇒ 结果作废，且必须杀掉刚开的 pty。
  if (panel.seq !== seq) {
    if (result.session !== null) {
      const mod = await pty();
      await mod.closePty(result.session);
    }
    return;
  }
  data.refusal = result.refusal;
  data.session = result.session;
  if (result.session !== null) trackSession(result.session);
  renderTerminalPanel(body, panel);
}

/**
 * 该终端面板该连哪个会话。
 *
 * 面板本身不持会话（state.ts 是纯数据），所以每次打开时读**当前聚焦会话**。
 * 这正是「会话切换要杀 pty」的另一半：切走后再回来，开的是新会话的终端。
 */
function activeSessionOf(panel: PanelState): string {
  void panel;
  // 动态 import 避免 workbench ← viewctx 的静态环（viewctx 不认识 workbench）。
  return currentSessionId();
}

let sessionIdReader: () => string = () => '';
/** 装配缝：main.ts 注入 activeSessionId（避免静态环）。 */
export function setSessionIdReader(reader: () => string): void {
  sessionIdReader = reader;
}
function currentSessionId(): string {
  return sessionIdReader();
}
