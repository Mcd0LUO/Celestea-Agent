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
 * 接管判定的**纯函数**（把「什么时候可以用假光标」从 DOM 里择出来）。
 * 为什么要单独一个可导出的纯函数：这几条边界全都只在**真机**才表现得出差异
 * （jsdom 无排版 ⇒ 探测恒失败 ⇒ 无论判定写成什么，最终都是「不接管」）——
 * 于是任何针对 sync() 的 jsdom 断言都会**空转**（真实教训：把
 * `input.value.length` 改成截断后的 `text.length`，单元测试照样全绿，
 * 只有真机才抓到）。择成纯函数后，判定本身就能被机械钉死。
 */
export function shouldTakeOver(o: {
  /** 镜像层探测通过（同宽同原点、能量出插入点盒）。 */
  probed: boolean;
  /** textarea 是否持有焦点。 */
  focused: boolean;
  /** 是否处于 IME 组合中（预编辑串不在 value 里，按 selection 定位会偏）。 */
  composing: boolean;
  /** **input.value** 的长度（不是镜像层截断后的长度）。 */
  valueLen: number;
}): boolean {
  return o.probed && o.focused && !o.composing && o.valueLen <= MAX_PREFIX;
}

/**
 * 挂载镜像层与假光标。
 * @param input 真 textarea（几何与选区的唯一真源）
 * @param host  挂载容器。**必须**能当绝对定位的包含块；为 static 时就地补一条
 *              relative（旧夹具 / 异常结构下也不会把光标甩到视口左上角）。
 */
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

  /**
   * 滚动同步：镜像层与 textarea 的滚动位必须一致，否则文字一滚假光标就停在原地。
   * 输入框恒 `white-space: pre-wrap` + `overflow-wrap: break-word` ⇒ 不会横向溢出，
   * scrollLeft 恒 0；仍然抄过来，是为了不依赖那个前提。
   */
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

  /**
   * 可用性探测（fail-closed）：只有**实测**镜像层与输入框同宽、且能给出非零高的
   * 插入点矩形时才接管。任何一条不成立 ⇒ 回落原生插入符（caret.css 的回落分支）。
   */
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

  /** 唯一的接管开关：文字透明 ⇄ 假光标可见，永远同进同出（不留中间态）。 */
  function paint(active: boolean): void {
    const on = active && stateEl !== null;
    stateEl?.classList.toggle('has-fake-caret', on);
    caret.classList.toggle('on', on);
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
    const far2 = !Number.isFinite(lastX) || Math.abs(x - lastX) > SNAP_PX || Math.abs(y - lastY) > SNAP_PX;
    if (far2) {
      caret.classList.add('no-anim');
      void caret.offsetWidth; // 强制样式落地，保证这一帧真的不带过渡
      requestAnimationFrame(() => caret.classList.remove('no-anim'));
    }
    lastX = x;
    lastY = y;
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
      ro?.disconnect();
      stateEl?.classList.remove('has-fake-caret');
      mirror.remove();
    },
  };
  sync();
  return api;
}
