// ============================================================================
// ui/workbench/terminal-pty.ts — W1528：真 PTY 的**传输层 + 生命周期**。
// ----------------------------------------------------------------------------
// 数据面（三条 HTTP + 一条 SSE）：
//   · POST /api/terminal               开 pty（沙箱内，util-linux script(1) 垫片）
//   · POST /api/terminal/{id}/input    按键**逐字节**上行（不追加换行）
//   · POST /api/terminal/{id}/close    幂等关闭（连同整个进程组）
//   · SSE \`terminal\` 事件             输出下行（{id, session, data}）
//
// **懒加载**：@xterm/xterm 只在**第一次真正开终端**时 \`await import()\`，
// 主包不含它（xterm 本体 gzip ≈118KB）。本模块自身很薄，静态 import 它不会把
// xterm 拖进主包 —— 动态 import 才是那条边界。
//
// **生命周期**（进程泄漏 = 真 bug）：面板关闭 / 会话切换 / 页面卸载三处都杀，
// 另加服务端空闲回收兜底（客户端整个崩掉也不会留孤儿）。
// ============================================================================
import { ApiError } from '../../api';
// W1528：终端的线协议自带在 ./terminal-api.ts（api.ts 已在 400 行上限上）。
import { terminalClose, terminalInput, terminalOpen, userErrorText } from './terminal-api';
import { t } from '../../i18n';
import type { TerminalFrame } from '../../types/terminal';

/** xterm 的最小结构面（只声明我们用到的部分，避免把它的类型拖进主包图）。 */
export interface XtermLike {
  open(parent: HTMLElement): void;
  dispose(): void;
  write(data: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  loadAddon(addon: unknown): void;
  readonly cols: number;
  readonly rows: number;
  readonly element?: HTMLElement | undefined;
}
interface FitLike { fit(): void }
interface XtermModule { Terminal: new (options?: Record<string, unknown>) => XtermLike }
interface FitModule { FitAddon: new () => FitLike }

/** 一个面板持有的活动 pty。 */
export interface PtySession {
  readonly id: string;
  readonly sessionId: string;
  readonly term: XtermLike;
  readonly fit: FitLike;
  /**
   * ★ xterm 的**宿主元素，由本会话独占并长期持有**。
   *
   * 为什么不能让渲染层每次新建一个 div 再 \`term.open(新div)\`：\`open()\` 只认
   * 第一次调用 —— 第二次既不抛错、也不搬 DOM，新宿主永远是空的（真机 CDP 实测：
   * 第二次 open 后 h2.innerHTML.length === 0，而原宿主保留全部内容）。表现就是
   * 「终端打开了、尺寸也对、但一行都不显示」。
   *
   * 正确做法是宿主只建一次，渲染时把它 **appendChild 进新容器**（appendChild 会
   * 把节点从旧父节点移走），DOM 与 xterm 的内部引用因此始终指向同一个元素。
   */
  readonly host: HTMLElement;
  /** 上行失败过一次（界面据此提示；不静默）。 */
  failed: boolean;
  disposed: boolean;
  /** 取消 SSE 订阅（关闭后帧不得再写进已销毁的 term）。 */
  off(): void;
  /** 输入订阅的注销句柄。 */
  offData(): void;
}

/**
 * 结构化拒绝 → 面向用户的可读说明。
 *
 * 三种 code 各自成句：它们对用户意味着**不同的事**（档位不允许 / 本机没有
 * pty / 终端数到顶），合并成一句会让人不知道该改什么。
 */
export function refusalText(err: unknown): string {
  const code = err instanceof ApiError ? (err.data as { code?: string } | null)?.code : undefined;
  if (code === 'shell_denied') return t('chat.wb.term.denied');
  if (code === 'terminal_unavailable') return t('chat.wb.term.unavailable');
  if (code === 'terminal_limit') return t('chat.wb.term.limit');
  return userErrorText(err, t('chat.wb.term.notStarted'));
}

/** SSE \`terminal\` 帧的订阅缝（默认自建 EventSource；测试注入假源）。 */
export type FrameSource = (handler: (frame: TerminalFrame) => void) => () => void;
let frameSource: FrameSource | null = null;

/**
 * 覆盖帧源（测试注入假源；生产不调用）。
 *
 * 生产**默认**自建一条 EventSource，而不是复用 chat.ts 的 SseClient —— 原因
 * 是边界：chat.ts / main.ts 是架构师独占文件，本波不得修改。自建连接的代价
 * 明确且很小：**按需建立**（第一个终端打开时才连，最后一个关闭时断开），
 * 空闲页面零开销；总线本来就支持多订阅者（各自独立的容量桶）。
 */
export function setFrameSource(source: FrameSource | null): void {
  frameSource = source;
}

/** 按需的共享终端 EventSource（引用计数；最后一个终端关闭时断开）。 */
let shared: EventSource | null = null;
let sharedRefs = 0;
const sharedHandlers = new Set<(frame: TerminalFrame) => void>();

function sharedSource(handler: (frame: TerminalFrame) => void): () => void {
  sharedRefs += 1;
  sharedHandlers.add(handler);
  if (shared === null) {
    const es = new EventSource('/api/events');
    shared = es;
    // 与 chat.ts 的 SseClient 同款解析：信封 {turn,seq,payload}，载荷在 payload。
    es.addEventListener('terminal', (e: MessageEvent<string>) => {
      let frame: TerminalFrame;
      try {
        const env = JSON.parse(e.data) as { payload?: unknown };
        const payload = env.payload;
        if (payload === null || typeof payload !== 'object') return;
        frame = payload as TerminalFrame;
      } catch (err) {
        console.warn('[terminal] 帧解析失败：' + (err instanceof Error ? err.message : String(err)));
        return;
      }
      if (typeof frame.id !== 'string' || typeof frame.data !== 'string') return;
      for (const h of [...sharedHandlers]) {
        try { h(frame); } catch (err) { console.warn('[terminal] 帧处理失败：' + String(err)); }
      }
    });
  }
  return () => {
    sharedHandlers.delete(handler);
    sharedRefs -= 1;
    if (sharedRefs <= 0 && shared !== null) {
      shared.close();
      shared = null;
      sharedRefs = 0;
    }
  };
}

/** xterm 模块的加载缝（测试注入假 Terminal，避免在 jsdom 里跑 canvas）。 */
export type XtermLoader = () => Promise<{ term: XtermModule; fit: FitModule } | null>;
let xtermLoader: XtermLoader | null = null;

export function setXtermLoader(loader: XtermLoader): void {
  xtermLoader = loader;
}

/**
 * 懒加载 xterm + fit + **它的 CSS**。
 *
 * CSS 也走动态 import：xterm.css 约 2.5KB gzip，静态 import 会让**所有**用户
 * 的样式表都变大（含从不打开终端的人）。动态 import 让 Vite 把它切成按需资产。
 * 加载失败返回 null，调用方画可读拒绝 —— 绝不白屏。
 */
async function defaultLoader(): Promise<{ term: XtermModule; fit: FitModule } | null> {
  try {
    const [x, f] = await Promise.all([
      import('@xterm/xterm') as Promise<unknown>,
      import('@xterm/addon-fit') as Promise<unknown>,
      import('@xterm/xterm/css/xterm.css') as Promise<unknown>,
    ]);
    return { term: x as XtermModule, fit: f as FitModule };
  } catch (err) {
    console.warn('[terminal] xterm 加载失败：' + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}

/** 打开一个 pty 并接到 xterm 上；任何一步失败都返回可读原因而不是抛。 */
export interface OpenResult {
  session: PtySession | null;
  refusal: string;
}

export async function openPty(sessionId: string, cols: number, rows: number): Promise<OpenResult> {
  const mods = await (xtermLoader ?? defaultLoader)();
  if (mods === null) return { session: null, refusal: t('chat.wb.term.unavailable') };

  let opened;
  try {
    opened = await terminalOpen({ ...(sessionId === '' ? {} : { session: sessionId }), cols, rows });
  } catch (err) {
    return { session: null, refusal: refusalText(err) };
  }

  /**
   * ★ 从这里开始，服务端**已经有一个真进程在跑**了。客户端侧任何一步失败
   * （xterm 构造 / open / addon 装配）都必须把那个进程收掉，否则就是一次
   * 无人认领的 pty —— 面板上什么都没画，进程却在后台活着。
   * 这条路径不是理论：jsdom 里 xterm 构造就会抛（无 canvas），实测踩到过。
   */
  const host = document.createElement('div');
  host.className = 'wb-term-xterm';
  let term: XtermLike;
  let fit: FitLike;
  try {
    term = new mods.term.Terminal({
      cols, rows, cursorBlink: true, convertEol: false, scrollback: 5000,
      fontFamily: 'var(--mono)', fontSize: 12,
      // ★ 必须显式给出前景色，且**不能用** \`background: transparent\`。
      // xterm 的默认前景是白色（给深色终端用的）；本仓是浅色主题，白色正文落在
      // 透明底上 = 白底白字，**普通文本完全看不见**（真机 CDP 截图实测：只有
      // 语法高亮的彩色 token 可见，命令与提示符一片空白）。transparent 还会让
      // xterm 的选区/光标反色算错，所以底色也用主题的代码底色显式给死。
      theme: {
        background: '#f4f4f4',
        foreground: '#111111',
        cursor: '#1a1a1a',
        selectionBackground: 'rgba(0, 0, 0, 0.18)',
      },
    });
    fit = new mods.fit.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // fit 之后真实行列可能与请求不同（面板尺寸决定）；先按实际值告诉服务端。
    try { fit.fit(); } catch { /* 面板尚未布局：保留请求值 */ }
  } catch (err) {
    console.warn('[terminal] xterm 装配失败，回收已开的 pty：' + (err instanceof Error ? err.message : String(err)));
    try { await terminalClose(opened.id); } catch { /* 尽力回收；服务端空闲回收兜底 */ }
    return { session: null, refusal: t('chat.wb.term.unavailable') };
  }

  const session: PtySession = {
    id: opened.id,
    sessionId,
    term,
    fit,
    host,
    failed: false,
    disposed: false,
    off: () => undefined,
    offData: () => undefined,
  };

  /**
   * 下行：只认本终端的帧（同一进程可能有多个面板各自开终端）。
   *
   * ★ 这一步失败**必须回收 pty**。订阅要用 EventSource；在一个没有它的环境里
   * （jsdom、或极老的浏览器）构造会抛，而服务端**已经有一个真进程在跑**了。
   * 吞掉异常把 session 返回出去 = 画一个永远不更新的终端 + 留一个孤儿进程；
   * 所以这里失败即关闭并给可读拒绝（本实现的第一版正是漏了这一步，实测踩到）。
   */
  try {
    session.off = (frameSource ?? sharedSource)((f) => {
      if (session.disposed || f.id !== session.id) return;
      term.write(f.data);
    });
  } catch (err) {
    console.warn('[terminal] 输出订阅失败，回收已开的 pty：' + (err instanceof Error ? err.message : String(err)));
    try { term.dispose(); } catch { /* 尽力 */ }
    try { await terminalClose(session.id); } catch { /* 尽力回收 */ }
    return { session: null, refusal: t('chat.wb.term.unavailable') };
  }
  // 上行：xterm 把按键（含 \r、\x03、方向键转义序列）原样交出来，逐字节送。
  const dataSub = term.onData((data) => { void sendBytes(session, data); });
  session.offData = () => dataSub.dispose();
  return { session, refusal: '' };
}

/**
 * 把一串字节写进 pty。
 *
 * **不追加换行**：回车是 xterm 在用户按 Enter 时交出的 \r，服务端不替用户发明
 * 一个。这正是 REPL 能工作的原因。失败只置 failed 并告警，不打断后续按键
 * （一次网络抖动不该让整个终端变成只读）。
 */
export async function sendBytes(session: PtySession, data: string): Promise<void> {
  if (session.disposed || data === '') return;
  try {
    await terminalInput(session.id, data);
  } catch (err) {
    session.failed = true;
    console.warn('[terminal] 按键上行失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * 杀掉一个 pty 会话（幂等；永不抛）。
 *
 * 先注销订阅再关闭：否则关闭期间到达的帧会写进已 dispose 的 term。服务端
 * SIGTERM 整个进程组，所以终端里起的 python3 / top 一并死掉 —— 这就是
 * 「无进程泄漏」的机制，不是承诺。
 */
export async function closePty(session: PtySession): Promise<void> {
  if (session.disposed) return;
  session.disposed = true;
  session.off();
  session.offData();
  try {
    session.term.dispose();
  } catch (err) {
    console.warn('[terminal] xterm dispose 失败：' + (err instanceof Error ? err.message : String(err)));
  }
  try {
    await terminalClose(session.id);
  } catch (err) {
    console.warn('[terminal] 关闭终端失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

/** 页面卸载时的同步兜底：尽力发出关闭请求（浏览器不保证送达）。 */
export function closePtyOnUnload(session: PtySession): void {
  if (session.disposed) return;
  session.disposed = true;
  try {
    // keepalive 让请求在文档卸载后仍有机会送达（fetch 默认会被取消）。
    void fetch('/api/terminal/' + encodeURIComponent(session.id) + '/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      keepalive: true,
    }).catch(() => undefined);
  } catch { /* 卸载路径：尽力而为，服务端空闲回收是兜底 */ }
}
