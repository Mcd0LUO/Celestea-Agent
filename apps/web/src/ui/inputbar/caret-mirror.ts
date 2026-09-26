// ============================================================================
// ui/inputbar/caret-mirror.ts — W1525 VSCode 风格光标（镜像层 + 绝对定位假光标）
// ----------------------------------------------------------------------------
// 为什么必须这么做（本文件存在的唯一理由）：
//   输入框是**原生 <textarea>**（index.html 的 #input）。原生插入符只有
//   `caret-color` 一个可调旋钮 —— **形状不可定制、位置不可过渡**；而「VSCode 风格」
//   的两条特征（平滑移动的定制形状光标、位置可编程）恰好要求这两点。于是只有一条路：
//     ① 把 textarea 的文字设为透明（color: transparent）—— 但**仅当假光标确认可用**；
//     ② 下方铺一层**同字体/同字号/同行高/同内边距/同宽度**的 div 渲染同样的文本；
//     ③ 再放一个绝对定位的「假光标」，位置从镜像层的**排版结果**量出来，
//        用 CSS transition 平滑移动。
//
// 真源不变式（绝对不许破坏）：
//   input.value / selectionStart / selectionEnd **永远由真实 textarea 持有**。
//   本模块对 textarea 只做两件事：读 value / 读 selectionStart·End·selectionDirection，
//   外加读计算样式与几何。它**不写** textarea 的任何状态，也**不参与**任何输入法/
//   键鼠事件的处理链（不 preventDefault、不 stopPropagation、不 execCommand）——
//   所有监听器都是只读观察者。镜像层与假光标都是纯装饰：aria-hidden、pointer-events:none。
//
// 为什么用 Range 而不是「逐字符测量 + 累加」：
//   换行是浏览器断行算法（CJK 逐字断、西文按词断、overflow-wrap 兜底、制表位）的产物，
//   自己实现必然与 Blink 分叉（尤其中英混排）。镜像层里**建一个 Range 落在插入点**
//   再读它的矩形，量到的就是浏览器自己的排版结果 —— 换行/折行/制表位全部免费正确。
//   真机实测（报告 W1525）：8 类文本 × 全部偏移，与真 textarea 的原生插入点**逐点 0 偏差**。
//
// 三条「必须回落原生插入符」的边界（都已在真机验证，不是推测）：
//   · IME 组合中（compositionstart..compositionend）：组合串由浏览器画在 textarea 内，
//     `color: transparent` 会让**预编辑串整个看不见**。⇒ 组合期间整体交还原生
//     （文字恢复不透明 + 原生插入符可见），compositionend 后立刻接管回来。
//   · 文本超过 MAX_PREFIX：镜像层只渲染前缀（防 O(n²) 重排），超长时让位原生插入符。
//   · 镜像层量不出可用矩形（隐藏视图 / 未排版 / 字体未就绪）：fail-closed 回落。
//   三条都走同一个开关：`has-fake-caret` 类。**文字透明与假光标可见是同一条类**，
//   所以不存在「文字透明了但没有光标」的中间态（见 caret.css）。
//
// 选区（非空）：假光标钉在**活动端**（selectionDirection === 'backward' ⇒ 起点，
//   否则终点），与 VSCode 一致。选区高亮仍由原生 ::selection 绘制 —— caret.css 里
//   专门把选中文字的颜色恢复成不透明，否则透明文字会让「有选区但看不见字」。
// ============================================================================

/** 必须与真 textarea 逐条同源的排版属性（真源 = getComputedStyle(input)）。 */
const COPY_PROPS: readonly string[] = [
  // 字体度量：少一条就会让镜像层的断行位置与 textarea 分叉。
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent',
  'text-rendering', 'font-kerning', 'font-variant-ligatures', 'tab-size',
  // 盒内排版：断行策略、方向、内边距（内边距决定文字原点）。
  'direction', 'text-align', 'white-space', 'overflow-wrap', 'word-break', 'box-sizing',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
];

/** 镜像层渲染的字符数上限：超过则整体让位给原生插入符（见文件头「三条边界」）。 */
const MAX_PREFIX = 4096;

/** 位移超过这么多像素就不做过渡（跨行跳转 / 点击重定位时滑过去很怪，VSCode 也是瞬移）。 */
const SNAP_PX = 120;

/** 读 --caret-dur（真源在 caret.css）；读不到（jsdom / 样式未加载）走兜底 90ms。 */
function readCaretDurMs(stateEl: HTMLElement | null): number {
  const raw = stateEl ? getComputedStyle(stateEl).getPropertyValue('--caret-dur').trim() : '';
  const n = parseFloat(raw);
  return !Number.isFinite(n) || n <= 0 ? 90 : raw.endsWith('ms') ? n : raw.endsWith('s') ? n * 1000 : 90;
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

export interface CaretMirror {
  /** 重算假光标位置（文本 / 选区 / 焦点变化后调用）。 */
  sync(): void;
  /** 当前是否由假光标接管（false = 已回落原生插入符）。 */
  ok(): boolean;
  /** 卸载（幂等）：移除监听器与装饰节点，恢复原生插入符。 */
  detach(): void;
}

interface CaretOrigin { x: number; y: number; h: number }

/**
 * 接管判定的**纯函数**（把「什么时候可以用假光标」从 DOM 里择出来）。为什么必须择成
 * 纯函数：这几条边界只在**真机**才表现得出差异（jsdom 无排版 ⇒ 探测恒失败 ⇒ 无论判定写成
 * 什么，最终都是「不接管」），针对 sync() 的 jsdom 断言都会**空转**（真实教训：把
 * `input.value.length` 改成截断后的 `text.length`，单元测试照样全绿，只有真机才抓到）。
 */
export function shouldTakeOver(o: { probed: boolean; focused: boolean; composing: boolean; valueLen: number }): boolean {
  return o.probed && o.focused && !o.composing && o.valueLen <= MAX_PREFIX;
}

/** 光标本次位移该怎么走：瞬移 / 真的动了 / 没动。 */
export type CaretMotion = 'snap' | 'animate' | 'hold';

/**
 * 位移种类的**纯函数**（W9105「移动中不要闪」的判定核心）。择成纯函数的理由同
 * shouldTakeOver：jsdom 走不到这一步，针对 sync() 的 jsdom 断言都是空转的。
 *   · 'snap'    差超过 SNAP_PX，或还没量到过位置（首帧 / 回落态后的第一次接管）⇒ 瞬移，
 *               且**不重启**闪烁（那会凭空制造一次无位移的闪烁脉冲）。
 *   · 'animate' 真的动了 ⇒ 过渡期间停闪，落位后从**亮**重新计时（用户要的行为）。
 *   · 'hold'    一模一样 ⇒ 什么都不做。**这条不是优化是正确性**：方向键按到行首/行尾边界、
 *               点一下已经贴着光标的文字、ResizeObserver 因宽度没变又回调一次，都会带着
 *               同一个坐标走进 sync()；若按 'animate' 处理，每次都「停闪 → 90ms 后重启」，
 *               光标就**周期性地亮一下** —— 正是用户报的「闪」。高度也算动（textarea 自动
 *               增高 / 换行时 --caret-h 同样在过渡）；0.5px 容差与 probe() 比几何同量级。
 */
export function motionKind(o: {
  lastX: number; lastY: number; lastH: number; x: number; y: number; h: number;
}): CaretMotion {
  if (!Number.isFinite(o.lastX) || !Number.isFinite(o.lastY) || !Number.isFinite(o.lastH)) return 'snap';
  if (Math.abs(o.x - o.lastX) > SNAP_PX || Math.abs(o.y - o.lastY) > SNAP_PX) return 'snap';
  const moved = Math.abs(o.x - o.lastX) > 0.5 || Math.abs(o.y - o.lastY) > 0.5 || Math.abs(o.h - o.lastH) > 0.5;
  return moved ? 'animate' : 'hold';
}

/** 闪烁控制器：把「过渡期间不闪、落位后从亮重新计时」这条时序收在一个可测对象里。 */
export interface CaretBlink {
  /** 过渡开始：停闪；过渡结束（或超时兜底）后相位从亮重来。 */
  restart(): boolean;
  /** transitionend：立刻收尾（摘停闪类）。幂等。 */
  done(): void;
  /** 没有过渡可等（瞬移 / 回落 / 卸载）：撤掉计时器，且确保不留在停闪态。 */
  halt(): void;
}

/**
 * 闪烁控制器（**注入式**：DOM 副作用全由调用方给的闭包提供）。单独立一个对象是为了可测：
 * sync() 在 jsdom 里走不到，而「过渡期间不闪、落位后从亮重新计时」这条**时序**正是本次
 * 改动的全部内容 —— 择出来才能用假定时器钉死。
 *
 * transitionend 会**缺席**：同一帧既改 transform 又改 height 时 Blink 只发一次事件、且只带
 * 其中一个属性名，只听 propertyName 会漏掉另一半，光标就永远不闪（比原来更糟）。所以每次
 * 都排一个 --caret-dur 兜底定时器，谁先到谁收尾；收尾回调还**自己保证恢复**（带着排它时的
 * 代号醒来，代号对不上直接返回）—— 无论定时器 / transitionend / halt() 以什么顺序到达，
 * 光标都不会被永久留在「不闪」态（宁可闪，不可不闪）。
 *
 * 为什么「摘掉停闪类」= 「相位从亮重新计时」：动画声明写在 `.caret-fake.on` 上，停闪只靠更高
 * 特异性的 `.caret-fake.on.is-moving { animation: none }`。摘掉 is-moving 让 animation-name 从
 * none 变回 caret-blink —— 按 CSS Animations 规范那是**新建**一条动画，从 0% 起（= opacity:1
 * = 亮）；两次声明变化至少隔一帧（transitionend 与 90ms 定时器都在后面的任务里），不存在
 * 「同帧摘了又加被合并、接着跑旧相位」的风险。顺带：停闪期间 animation:none 落到 `.caret-fake.on` 的
 * opacity:1 ⇒ **移动中光标恒亮**（正是用户要的观感），摘类不可能产生脉冲（亮 → 亮）。
 */
export function createCaretBlink(opts: {
  el: HTMLElement; movingClass: string; // caret.css 里由 .caret-fake.on.is-moving 压掉 animation
  /** 兜底延时（ms），应与 --caret-dur 同值。定时器可注入（测试用假定时器）。 */
  durationMs: number; setTimer?: (fn: () => void, ms: number) => number; clearTimer?: (id: number) => void;
}): CaretBlink {
  let pending: number | null = null; // 在途收尾定时器；null = 没有在停闪
  let gen = 0; // 代号：只有「当代」的回调才允许动 DOM（见上文 ③）
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): number => window.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: number): void => window.clearTimeout(id));
  function clear(): void {
    if (pending === null) return;
    clearTimer(pending);
    pending = null;
    gen += 1;
  }
  function settle(token: number): void {
    // 两道幂等门：pending === null = 已收过尾；token !== gen = 迟到回调。少了第一道，done()
    // 就不幂等 —— 迟到的 transitionend 会掀掉新一段移动的停闪态（= 边滑边闪回归）。
    if (pending === null || token !== gen) return;
    clear();
    opts.el.classList.remove(opts.movingClass);
  }
  return {
    restart: () => {
      // 连续按键：上一段还没落位就来了下一段 —— 光标已经停着，只把收尾时刻往后推。
      const wasIdle = pending === null;
      if (wasIdle) opts.el.classList.add(opts.movingClass);
      clear();
      const token = gen;
      pending = setTimer(() => settle(token), Math.max(1, opts.durationMs));
      return wasIdle;
    },
    done: () => settle(gen),
    halt: () => {
      clear();
      opts.el.classList.remove(opts.movingClass);
    },
  };
}

/** 挂载镜像层与假光标。host 必须能当绝对定位的包含块；为 static 时就地补一条 relative。 */
export function mountCaretMirror(input: HTMLTextAreaElement, host: HTMLElement | null): CaretMirror {
  const doc = input.ownerDocument;
  const root: HTMLElement = host ?? (input.parentElement as HTMLElement | null) ?? doc.body;
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
  // 状态类挂在 #inputbar 上（caret.css 的选择器锚点），**不是**挂 root（.input-box）：
  // 挂错地方 CSS 匹配不上 ⇒ 文字不透明但镜像层没显示 ⇒ 输入框看起来是空的。
  // 找不到 #inputbar（旧夹具 / 异常结构）就整体不接管 —— fail-closed，宁可不做。
  const stateEl = input.closest('#inputbar') as HTMLElement | null;

  const mirror = doc.createElement('div');
  mirror.className = 'caret-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  const caret = doc.createElement('div');
  caret.className = 'caret-fake';
  caret.setAttribute('aria-hidden', 'true');
  // 单次替换（铁律 1：不清空后加载）—— 一次 appendChild 挂上整棵装饰子树。
  mirror.appendChild(caret);
  root.appendChild(mirror);

  let node: Text | null = null;
  /** 结尾空行（空值 / 文本以 \n 结尾）时补的那个 <br>：那一行的插入点盒由它给出。 */
  let br: HTMLBRElement | null = null;
  let text = '\u0000'; // 与 DOM 不同源的哨兵：首帧必然重排一次
  let alive = true;
  let ready = false;
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastH = Number.NaN; // --caret-h 同样在过渡：textarea 自动增高 / 换行时闪烁也得停

  /**
   * 把真 textarea 的排版度量抄到镜像层。
   * 宽高都取**亚像素实测值**（getBoundingClientRect 而非 clientWidth/Height）：
   * 取整会让镜像层的断行位置与 textarea 分叉，一差就是一整行。
   */
  function copyMetrics(): void {
    const cs = getComputedStyle(input);
    for (const p of COPY_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v !== '') mirror.style.setProperty(p, v);
    }
    const r = input.getBoundingClientRect();
    mirror.style.setProperty('width', r.width + 'px');
    mirror.style.setProperty('height', r.height + 'px');
    // 把镜像层**精确盖在 textarea 的边框盒上**（而不是假设二者同原点）：
    // left/top 相对 root 的 padding 盒，所以先减掉 root 自己的边框。
    const rr = root.getBoundingClientRect();
    const rcs = getComputedStyle(root);
    const bl = parseFloat(rcs.borderLeftWidth) || 0;
    const bt = parseFloat(rcs.borderTopWidth) || 0;
    mirror.style.setProperty('left', r.left - rr.left - bl + 'px');
    mirror.style.setProperty('top', r.top - rr.top - bt + 'px');
  }

  /** 滚动同步：镜像层与 textarea 的滚动位必须一致，否则文字一滚假光标就停在原地。 */
  function syncScroll(): void {
    if (mirror.scrollTop !== input.scrollTop) mirror.scrollTop = input.scrollTop;
    if (mirror.scrollLeft !== input.scrollLeft) mirror.scrollLeft = input.scrollLeft;
  }

  /** 重排镜像层文本（值未变则只重抄度量）。 */
  function refresh(): void {
    if (!alive) return;
    copyMetrics();
    const v = input.value;
    const shownText = v.length > MAX_PREFIX ? v.slice(0, MAX_PREFIX) : v;
    if (shownText === text) return;
    text = shownText;
    const tn = doc.createTextNode(shownText);
    // 空串 / 以 \n 结尾：块级盒不为「结尾换行」建行盒（浏览器一贯行为），但真 textarea 会
    // —— 补一个 <br>，让光标所在的那个空行真的存在，否则插入点会掉到上一行。
    // 实测（报告 W1525）：这个 <br> 的盒 = 原生插入点，逐像素一致（空值 {24,35,0,16} 对原生
    // {24,35,1,16}；以 \n 结尾 {24,81,0,16} 对原生 {24,81,1,16}）。所以它不只是占位，
    // 而是结尾空行插入点的**测量依据**（见 rectAt 的兜底分支）。
    // 注意：replaceChildren 会把**假光标一起清掉**（它是 mirror 的子节点），
    // 所以每次重排都要把 caret 重新挂回去 —— 且挂在文本之后，保证它画在文字上面。
    if (shownText === '' || shownText.endsWith('\n')) {
      br = doc.createElement('br');
      mirror.replaceChildren(tn, br, caret);
    } else {
      br = null;
      mirror.replaceChildren(tn, caret);
    }
    node = tn;
  }

  /** 插入点在**视口坐标**下的位置；量不到则返回 null（调用方据此回落）。 */
  function rectAt(offset: number): CaretOrigin | null {
    if (!node) return null;
    const i = clamp(offset, 0, node.data.length);
    const r = doc.createRange();
    r.setStart(node, i);
    r.setEnd(node, i);
    const rects = r.getClientRects();
    const b = rects.length > 0 ? rects[0] : null;
    if (b && b.height > 0 && Number.isFinite(b.x) && Number.isFinite(b.y)) {
      return { x: b.x, y: b.y, h: b.height };
    }
    // 空文本节点 / 结尾空行：Range 落在文本节点里量不到盒（插入点在「最后那个空行」上，
    // 而那一行的盒是 <br> 建的）—— 用 <br> 自己的盒。它就是原生插入点，不做任何估算。
    if (br) {
      const bb = br.getBoundingClientRect();
      if (bb.height > 0 && Number.isFinite(bb.x) && Number.isFinite(bb.y)) {
        return { x: bb.x, y: bb.y, h: bb.height };
      }
    }
    return null;
  }

  /** 可用性探测（fail-closed）：只有**实测**镜像层与输入框同宽同原点、且能给出非零高的
   * 插入点矩形时才接管。任何一条不成立 ⇒ 回落原生插入符（caret.css 的回落分支）。 */
  function probe(): boolean {
    if (!node || !stateEl) return false;
    // 镜像层必须仍在文档里，且 caret.css **确实生效**（position:absolute 是它独有的
    // 声明，其余样式都是 JS 抄来的内联值）。CSS 没加载时镜像层会退回普通流 —— 那时
    // 它是「一段重复的可见文字」而不是装饰，必须立刻停手。
    if (!mirror.isConnected || getComputedStyle(mirror).position !== 'absolute') return false;
    const ir = input.getBoundingClientRect();
    const mr = mirror.getBoundingClientRect();
    if (!(ir.width > 0) || !(mr.width > 0)) return false; // 还没排版（隐藏视图）：保持原生，稍后再试
    // 镜像层必须与输入框**同宽同原点** —— 差一点点都会让假光标整体偏移。
    if (Math.abs(mr.width - ir.width) > 0.5) return false;
    if (Math.abs(mr.left - ir.left) > 0.5 || Math.abs(mr.top - ir.top) > 0.5) return false;
    return rectAt(0) !== null;
  }

  // 闪烁控制器（W9105）：过渡时长读自 caret.css 的 --caret-dur（读不到才走兜底，见 readCaretDurMs）。
  const blink = createCaretBlink({ el: caret, movingClass: 'is-moving', durationMs: readCaretDurMs(stateEl) });

  /** 唯一的接管开关：文字透明 ⇄ 假光标可见，永远同进同出（不留中间态）。 */
  function paint(active: boolean): void {
    const on = active && stateEl !== null;
    stateEl?.classList.toggle('has-fake-caret', on);
    caret.classList.toggle('on', on);
    // 回落态没有假光标可闪：撤掉在途收尾定时器并摘掉停闪类，下次接管时相位才干净
    // （回落后再接管如果留着 .is-moving，光标会一直不闪 —— 那是一个新的 bug）。
    if (!on) blink.halt();
  }

  function sync(): void {
    if (!alive) return;
    refresh();
    syncScroll();
    ready = probe();
    // 四条回落边界（探测失败 / 失焦 / IME 组合中 / 文本超长）全部由纯函数判定，
    // 见 shouldTakeOver 的注释：这几条只有在真机才表现得出差异，必须能单独钉。
    const active = shouldTakeOver({
      probed: ready,
      focused: doc.activeElement === input,
      composing,
      valueLen: input.value.length,
    });
    if (!active) {
      lastX = Number.NaN;
      lastY = Number.NaN;
      lastH = Number.NaN;
      paint(false);
      return;
    }
    const len = node ? node.data.length : 0;
    const start = clamp(input.selectionStart ?? len, 0, len);
    const end = clamp(input.selectionEnd ?? start, 0, len);
    const at = start === end ? start : input.selectionDirection === 'backward' ? start : end;
    const r = rectAt(at);
    if (!r) {
      paint(false);
      return;
    }
    // 坐标换算：Range 的矩形是**视口坐标**（已含镜像层的滚动量），而假光标是
    // 镜像层的子节点，会被镜像层自己的 overflow 再滚一次 —— 直接相减会把滚动量
    // **算两遍**（真机实测：40 行文本滚到底时假光标比原生插入点高 736px，正好是
    // scrollTop）。所以要把镜像层的滚动量**加回去**，换算到镜像层的**内容坐标**：
    //   假光标视口位置 = origin.top - scrollTop + (r.y - origin.top + scrollTop) = r.y ✓
    // 镜像层 overflow:hidden 顺带负责裁剪 —— 插入点滚出可视区时假光标自然消失，
    // 与真 textarea 的行为一致（不需要额外的显隐判断）。
    const origin = mirror.getBoundingClientRect();
    const x = r.x - origin.left + mirror.scrollLeft;
    const y = r.y - origin.top + mirror.scrollTop;
    // 远距离跳转（点击重定位 / 换行）瞬移，近距离（打字 / 方向键）才过渡 ——
    // 全程过渡会把「跳到文首」变成一条横扫屏幕的动画。
    const kind = motionKind({ lastX, lastY, lastH, x, y, h: r.h });
    if (kind === 'snap') {
      caret.classList.add('no-anim');
      void caret.offsetWidth; // 强制样式落地，保证这一帧真的不带过渡
      requestAnimationFrame(() => caret.classList.remove('no-anim'));
      // 瞬移**不重启**闪烁：位置没在过渡，重启只会让光标凭空亮一下（用户报的
      // 「闪」的一种）。只保证它落位后是亮的（.on 的 opacity:1）。
      blink.halt();
    } else if (kind === 'animate') {
      // 过渡期间停闪（.is-moving 压掉 animation），transitionend / 兜底定时器一到
      // 就摘类并从亮重新计时。这就是「移动过程中不要闪烁」的实现。
      blink.restart();
    }
    lastX = x;
    lastY = y;
    lastH = r.h;
    caret.style.setProperty('--caret-x', x + 'px');
    caret.style.setProperty('--caret-y', y + 'px');
    caret.style.setProperty('--caret-h', r.h + 'px');
    paint(true);
  }

  // ---- 只读观察者：全部不改变 textarea 的任何状态 ------------------------------
  let composing = false;
  const onInput = (): void => sync();
  const onFocus = (): void => sync();
  const onBlur = (): void => sync();
  const onComposeStart = (): void => {
    composing = true;
    sync();
  };
  const onComposeEnd = (): void => {
    composing = false;
    sync();
  };
  const onSelChange = (): void => {
    if (doc.activeElement === input) sync();
  };
  const onScroll = (): void => sync();

  input.addEventListener('input', onInput);
  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', onBlur);
  input.addEventListener('scroll', onScroll);
  input.addEventListener('compositionstart', onComposeStart);
  input.addEventListener('compositionend', onComposeEnd);
  doc.addEventListener('selectionchange', onSelChange);

  const win = doc.defaultView ?? window;
  const RO = (globalThis as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const ro = typeof RO === 'function' ? new RO(() => sync()) : null;
  ro?.observe(input);
  const onWinResize = (): void => sync();
  win.addEventListener('resize', onWinResize);

  // 过渡结束 → 恢复闪烁（相位从亮重新计时）。**只**听 transform/height：opacity 也在这条
  // transition 列表里（接管态的淡入），它结束不该被当成「落位」。这只是「提前收尾」的
  // 优化，不是唯一路径 —— Blink 同时排了 --caret-dur 的兜底定时器。
  const onCaretTransitionEnd = (e: Event): void => {
    const prop = (e as TransitionEvent).propertyName;
    if (prop !== 'transform' && prop !== 'height') return;
    blink.done();
  };
  caret.addEventListener('transitionend', onCaretTransitionEnd);

  const api: CaretMirror = {
    sync,
    ok: () => ready,
    detach: () => {
      if (!alive) return;
      alive = false;
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('scroll', onScroll);
      input.removeEventListener('compositionstart', onComposeStart);
      input.removeEventListener('compositionend', onComposeEnd);
      doc.removeEventListener('selectionchange', onSelChange);
      win.removeEventListener('resize', onWinResize);
      caret.removeEventListener('transitionend', onCaretTransitionEnd);
      ro?.disconnect();
      blink.halt(); // 撤掉兜底计时器，卸载后不再有 DOM 写入
      stateEl?.classList.remove('has-fake-caret');
      mirror.remove();
    },
  };
  sync();
  return api;
}
