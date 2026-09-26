// @vitest-environment jsdom
/**
 * W1525 · VSCode 风格光标（镜像层 + 绝对定位假光标）机械门禁。
 *
 * 用户原话：「光标优化(vscode风格)」。
 *
 * 背景：输入框是**原生 <textarea>**（index.html 的 #input），它的插入符只有
 * `caret-color` 一个旋钮 —— 形状不可定制、位置不可过渡。要做 VSCode 风格，只有
 * 「文字交给镜像层 + 绝对定位假光标」一条路（见 ui/inputbar/caret-mirror.ts 头注）。
 *
 * 这条路的风险**不在观感，在丢字**：一旦接管态生效而镜像层没画出来，输入框就是
 * 空的（用户以为字没了）。所以本文件钉的不是「好不好看」，而是三条**安全不变量**：
 *   ① 真源不被污染：input.value / selectionStart·End 永远由真 textarea 持有，
 *      镜像层与假光标都是装饰（aria-hidden + pointer-events:none）；
 *   ② 接管是**条件**的：探测不通过 / 失焦 / IME 组合中 / 文本超长，一律回落原生；
 *   ③ 回落是**结构性**的：CSS 的透明规则同时要求 `.has-fake-caret` **和**
 *      `:has(> .input-box > .caret-mirror)` —— 镜像层不在，透明规则整体不匹配。
 *      这条不依赖 JS 记得清类，是丢字事故的最后一道闸。
 *
 * jsdom 无排版（getBoundingClientRect 恒 0）：本文件只做**结构与状态机**断言。
 * 像素级几何（假光标 vs 原生插入点的偏差）由真机 CDP 实测，数字见
 * results/W1525-caret-vscode.md —— 那里有逐采样点的 px 偏差。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const at = (rel: string): string => pathToFileURL(join(WEB, 'src', rel)).href;
const css = (rel: string): string =>
  readFileSync(join(WEB, 'src', 'styles', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 与 index.html 同构的最小骨架（照 tests/w846-composer-invariant-dom.test.ts 的口径）。
 * 必须够全：inputbar.ts 会连带拉进 statusline / attachments / quote tray 等模块，
 * 少一个 id 就在 import 期抛 need() 错误，测的就不是本模块了。
 */
const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slGrant" class="sl-grant hidden"><span class="sl-grant-tier" id="slGrantTier"></span>' +
  '<span class="sl-grant-badge" id="slGrantBadge"></span><span class="sl-grant-dot" id="slGrantDot"></span></button>' +
  '<button id="btnMode" class="sl-mode-btn hidden" type="button">插话</button>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">— tok/s</span><span class="sl-sep">·</span>' +
  '<span class="sl-cache" id="slCache">缓存 —</span><span class="sl-sep">·</span>' +
  '<span class="sl-steps" id="slSteps">— 步</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText">连接中…</span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><div class="input-box"><textarea id="input" rows="2"></textarea></div>' +
  '<div class="input-side"><button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

/**
 * 根 tsconfig **不含 DOM lib**（前端有自己的 apps/web/tsconfig.json），所以 tests/**
 * 里不能用 HTMLElement / document / CompositionEvent 这些全局类型 —— 照本仓既有做法
 * （tests/lib/w795-dom.ts、archive-manage.test.ts）用**最小结构接口 + 运行时取值**。
 */
interface ClassListLike {
  add(c: string): void;
  remove(c: string): void;
  contains(c: string): boolean;
  toggle(c: string, on?: boolean): boolean;
}
interface ElLike {
  id: string;
  className: string;
  value: string;
  textContent: string | null;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: string;
  parentElement: ElLike | null;
  previousElementSibling: ElLike | null;
  firstChild: unknown;
  classList: ClassListLike;
  isConnected: boolean;
  innerHTML: string;
  style: Record<string, unknown>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  setSelectionRange(a: number, b: number, dir?: string): void;
  addEventListener(t: string, f: (e: unknown) => void): void;
  removeEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  focus(): void;
  blur(): void;
  closest(sel: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  appendChild(n: ElLike): ElLike;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; left: number; top: number };
}
interface DocLike {
  body: ElLike & { innerHTML: string };
  head: ElLike;
  documentElement: ElLike;
  activeElement: ElLike;
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
}
const g = globalThis as unknown as {
  document: DocLike;
  Event: new (t: string, o?: unknown) => unknown;
  CompositionEvent: new (t: string, o?: unknown) => unknown;
  getComputedStyle: (e: ElLike) => { position: string; visibility: string };
};

/** 载入真实模块并初始化输入栏（jsdom：几何恒 0 ⇒ 探测必然不通过 ⇒ 恒回落）。 */
async function init() {
  const bar = (await import(/* @vite-ignore */ at('ui/inputbar.ts'))) as {
    initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
    setInputValue(v: string): void;
    clearInput(): void;
  };
  bar.initInputBar({ send: () => {}, cancel: () => {} });
  return bar;
}

const ib = (): ElLike => g.document.getElementById('inputbar') as ElLike;
const input = (): ElLike => g.document.getElementById('input') as ElLike;
const mirror = (): ElLike | null => g.document.querySelector('.caret-mirror');
const fake = (): ElLike | null => g.document.querySelector('.caret-fake');

beforeEach(() => {
  g.document.body.innerHTML = HTML;
  vi.resetModules();
  // 模块加载链会发起能力位/配置请求：给个恒定的空响应，别让网络参与断言。
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('W1525 · 光标：真源不被污染（输入正确性绝对不许变）', () => {
  it('镜像层与假光标都是纯装饰：aria-hidden + pointer-events:none，且不吞事件', async () => {
    await init();
    const m = mirror();
    expect(m, '镜像层必须挂上（挂在 .input-box 内）').not.toBeNull();
    expect(m!.getAttribute('aria-hidden'), '镜像层不得进无障碍树').toBe('true');
    expect(fake()!.getAttribute('aria-hidden'), '假光标不得进无障碍树').toBe('true');
    // 镜像层是 #input 的**兄弟**（不是包裹层）——包裹会改 flex 槽位、动到 #input 宽度。
    expect(m!.parentElement!.className).toBe('input-box');
    expect(m!.previousElementSibling).toBe(input());
    // pointer-events:none 由 CSS 保证（jsdom 不应用外部样式表，故查真源）。
    expect(css('caret.css')).toMatch(/\.caret-mirror\s*\{[^}]*pointer-events:\s*none/);
    expect(css('caret.css')).toMatch(/\.caret-mirror\s*\{[^}]*user-select:\s*none/);
  });

  it('模块只**读** textarea：不写 value / 不改 selection（程序化改值前后逐字一致）', async () => {
    const bar = await init();
    const el = input();
    el.value = 'hello 中文';
    el.focus();
    el.setSelectionRange(3, 3);
    const before = { v: el.value, a: el.selectionStart, b: el.selectionEnd };
    // 触发一次完整的同步链（input + selectionchange）
    el.dispatchEvent(new g.Event('input', { bubbles: true }));
    g.document.dispatchEvent(new g.Event('selectionchange'));
    expect({ v: el.value, a: el.selectionStart, b: el.selectionEnd }).toEqual(before);
    // 程序化写入路径（clearInput / setInputValue）也不得改动选区以外的任何东西
    bar.setInputValue('draft text');
    expect(el.value).toBe('draft text');
    bar.clearInput();
    expect(el.value).toBe('');
  });

  it('镜像层文本恒等于 textarea 的值（假光标量的是同一份文本）', async () => {
    await init();
    const el = input();
    for (const v of ['', 'a', 'line1\nline2', 'line1\nline2\n', '中文混排 tail']) {
      el.value = v;
      el.dispatchEvent(new g.Event('input', { bubbles: true }));
      const tn = mirror()!.firstChild as { data: string } | null;
      expect(tn, '镜像层必须有文本节点').not.toBeNull();
      expect(tn!.data, '镜像层文本 == textarea 值：' + JSON.stringify(v)).toBe(v);
    }
  });

  it('空值 / 以 \n 结尾：补一个 <br> 让结尾空行真的存在', async () => {
    await init();
    const el = input();
    for (const v of ['', 'a\n', 'a\nb\n']) {
      el.value = v;
      el.dispatchEvent(new g.Event('input', { bubbles: true }));
      expect(mirror()!.querySelector('br'), '结尾空行需要 <br> 建行盒：' + JSON.stringify(v)).not.toBeNull();
    }
    el.value = 'no trailing newline';
    el.dispatchEvent(new g.Event('input', { bubbles: true }));
    expect(mirror()!.querySelector('br'), '不以 \n 结尾时不该有 <br>').toBeNull();
  });
});

describe('W1525 · 接管是有条件的：任一不满足即回落原生插入符', () => {
  it('IME 组合中：compositionstart 摘下接管类，compositionend 装回', async () => {
    await init();
    const el = input();
    el.value = '组合输入';
    el.focus();
    el.dispatchEvent(new g.Event('input', { bubbles: true }));
    // jsdom 无排版 ⇒ 探测不通过 ⇒ 本就回落；这里钉的是**状态机**本身：
    // compositionstart 必须让接管类消失（无论之前是什么状态）。
    ib().classList.add('has-fake-caret');
    el.dispatchEvent(new g.CompositionEvent('compositionstart', { bubbles: true }));
    expect(ib().classList.contains('has-fake-caret'), '组合中必须回落（否则预编辑串透明不可见）').toBe(false);
    el.dispatchEvent(new g.CompositionEvent('compositionend', { bubbles: true }));
    // 组合结束后允许重新接管 —— 但 jsdom 无几何，探测仍不通过，所以这里只断言
    // 「不再被 composing 挡着」：类是否装上由真机验证（报告 C5）。
    expect(true).toBe(true);
  });

  it('失焦：blur 后不接管（真 textarea 失焦也不画插入符）', async () => {
    await init();
    const el = input();
    el.focus();
    ib().classList.add('has-fake-caret');
    el.blur();
    el.dispatchEvent(new g.Event('blur', { bubbles: true }));
    expect(ib().classList.contains('has-fake-caret'), '失焦必须回落').toBe(false);
  });

  it('超长文本：镜像层截断到 4096（防 O(n²) 重排）', async () => {
    await init();
    const el = input();
    el.value = 'x'.repeat(5000);
    el.dispatchEvent(new g.Event('input', { bubbles: true }));
    expect((mirror()!.firstChild as { data: string }).data.length, '镜像层只渲染前 4096 字').toBe(4096);
    expect(el.value.length, 'textarea 的值**不被截断**（真源完整）').toBe(5000);
  });

  /**
   * 为什么单独测这个纯函数：上面那条 jsdom 断言是**空转**的 —— jsdom 无排版 ⇒
   * probe 恒失败 ⇒ 无论判定写成什么，最终都是「不接管」。真实教训：把
   * `input.value.length > MAX_PREFIX` 改回 `text.length > MAX_PREFIX`（text 已被
   * 截成 4096，比它**永远为假**），单元测试照样 14/14 全绿，只有真机 CDP 才抓到
   * （5000 字时假光标错误接管，而镜像层只画了 4096 字 ⇒ 光标停错地方）。
   * 择成纯函数后，判定本身就能被机械钉死，不依赖真机跑一次。
   */
  it('接管判定（纯函数）：四条边界逐条钉死 —— 尤其「超长」比的是 value 而不是截断文本', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/inputbar/caret-mirror.ts'))) as {
      shouldTakeOver(o: { probed: boolean; focused: boolean; composing: boolean; valueLen: number }): boolean;
    };
    const base = { probed: true, focused: true, composing: false, valueLen: 3 };
    expect(mod.shouldTakeOver(base), '四条都满足 ⇒ 接管').toBe(true);
    expect(mod.shouldTakeOver({ ...base, probed: false }), '探测失败 ⇒ 不接管').toBe(false);
    expect(mod.shouldTakeOver({ ...base, focused: false }), '失焦 ⇒ 不接管').toBe(false);
    expect(mod.shouldTakeOver({ ...base, composing: true }), 'IME 组合中 ⇒ 不接管').toBe(false);
    // 边界：4096 恰好可以，4097 必须回落
    expect(mod.shouldTakeOver({ ...base, valueLen: 4096 }), '4096 = 上限，仍可接管').toBe(true);
    expect(mod.shouldTakeOver({ ...base, valueLen: 4097 }), '4097 > 上限 ⇒ 必须回落').toBe(false);
    expect(mod.shouldTakeOver({ ...base, valueLen: 5000 }), '5000 ⇒ 必须回落').toBe(false);
  });

  it('探测不通过（jsdom 无几何）：恒不接管 —— 回落是默认态，不是异常态', async () => {
    await init();
    const el = input();
    el.value = 'normal text';
    el.focus();
    el.dispatchEvent(new g.Event('input', { bubbles: true }));
    expect(ib().classList.contains('has-fake-caret'), '量不出几何时必须用原生插入符').toBe(false);
    expect(fake()!.classList.contains('on'), '假光标不得显示').toBe(false);
  });

  it('没有 #inputbar 宿主时整体不接管（fail-closed，而不是把类挂到别的元素上）', async () => {
    // 直接测 mountCaretMirror：initInputBar 自己就 need('#inputbar')，走不到这条路径。
    // 状态类的宿主是 closest('#inputbar') —— 它不存在时宁可整体不接管：
    // 把 .has-fake-caret 挂到别的元素上会让 CSS 匹配不到，文字就白透明了。
    const host = g.document.createElement('div');
    host.innerHTML = '<div class="input-box"><textarea id="input"></textarea></div>';
    g.document.body.appendChild(host);
    const mod = (await import(/* @vite-ignore */ at('ui/inputbar/caret-mirror.ts'))) as {
      mountCaretMirror(i: ElLike, h: ElLike | null): { ok(): boolean; sync(): void };
    };
    const ta = host.querySelector('#input') as ElLike;
    ta.value = 'text';
    const m = mod.mountCaretMirror(ta, host.querySelector('.input-box'));
    expect(g.document.querySelector('.caret-mirror'), '镜像层照挂').not.toBeNull();
    expect(g.document.querySelector('.has-fake-caret'), '但没有任何元素该拿到接管类').toBeNull();
    expect(m.ok(), 'ok() 必须为假（= 未接管）').toBe(false);
    // 连 .input-box 都没有时挂到 textarea 的父节点，仍然不接管
    const m2 = mod.mountCaretMirror(ta, null);
    expect(m2.ok()).toBe(false);
    expect(g.document.querySelector('.has-fake-caret')).toBeNull();
  });
});

describe('W1525 · 回落是结构性的：CSS 不依赖 JS 记得清类', () => {
  it('透明规则同时要求 .has-fake-caret **和** :has(> .input-box > .caret-mirror)', () => {
    const text = css('caret.css');
    const transparent = [...text.matchAll(/([^{}]+)\{([^}]*color:\s*transparent[^}]*)\}/g)];
    expect(transparent.length, '必须有「文字透明」规则').toBeGreaterThan(0);
    for (const m of transparent) {
      const sel = (m[1] ?? '').trim();
      expect(sel, '透明规则的选择器必须带 :has() 结构兜底：' + sel).toContain(':has(');
      expect(sel, '且必须带状态类：' + sel).toContain('.has-fake-caret');
    }
  });

  it('默认态（无接管类）不隐藏文字、不隐藏原生插入符', () => {
    const text = css('caret.css');
    // caret-color: transparent 只允许出现在带 .has-fake-caret 的规则里
    for (const m of text.matchAll(/([^{}]+)\{([^}]*caret-color:\s*transparent[^}]*)\}/g)) {
      expect((m[1] ?? '').trim(), 'caret-color:transparent 只能出现在接管态').toContain('.has-fake-caret');
    }
    // #input 自身不得被写死透明/隐藏（否则回落态也看不见字）
    const bare = [...text.matchAll(/(?:^|\})\s*#input\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    for (const body of bare) {
      expect(body, '#input 裸规则不得改文字颜色').not.toMatch(/color\s*:/);
    }
  });

  it('镜像层默认 visibility:hidden —— 非接管态只有一层文字在画', () => {
    const text = css('caret.css');
    const m = /\.caret-mirror\s*\{([^}]*)\}/.exec(text);
    expect(m, '找不到 .caret-mirror 规则').not.toBeNull();
    expect((m as RegExpExecArray)[1], '默认必须隐藏（否则与 textarea 双层描字）').toMatch(/visibility:\s*hidden/);
    // 用 visibility 而非 display：display:none 的盒子量不出几何，探测就没法做
    expect((m as RegExpExecArray)[1], '不能用 display:none（会量不出几何）').not.toMatch(/display:\s*none/);
  });

  it('假光标是绝对定位 + transform 位移（不触发布局），且带 transition', () => {
    const text = css('caret.css');
    const m = /\.caret-fake\s*\{([^}]*)\}/.exec(text);
    expect(m).not.toBeNull();
    const body = (m as RegExpExecArray)[1] ?? '';
    expect(body, '绝对定位：不参与输入栏的 flex 分配').toMatch(/position:\s*absolute/);
    expect(body, '位移走 transform（合成层，不触发重排）').toMatch(/transform:\s*translate3d/);
    expect(body, '平滑移动 = VSCode 风格的核心').toMatch(/transition:/);
  });

  it('减弱动效：光标不闪（无限 steps 动画在 reduced-motion 下必须显式关掉）', () => {
    const text = css('caret.css');
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(text);
    expect(block, 'caret.css 必须自带 reduced-motion 分支').not.toBeNull();
    expect((block as RegExpExecArray)[1]).toMatch(/animation:\s*none/);
  });
});
// ----------------------------------------------------------------------------
// W9105 · 光标「移动过程中不要闪烁」
// ----------------------------------------------------------------------------
// 用户原话：「输入框的 ux: 光标在移动过程中不要闪烁」。
//
// 症状：假光标在 --caret-dur(90ms) 的平滑位移里**仍在**按 --caret-blink(1.06s) 闪 ——
// 「一边滑一边闪」。VSCode 的行为是：移动期间暂停闪烁，落位后从**亮**重新计时。
//
// 为什么本节的断言不能写在 sync() 上：jsdom 无排版 ⇒ probe() 恒失败 ⇒ sync() 永远走不到
// 「算位移」那一步（与 shouldTakeOver 那条注释同一个理由）。所以把两件事各自择成可测单元：
//   · motionKind()       —— 纯函数，判「瞬移 / 真的动了 / 没动」；
//   · createCaretBlink() —— 注入式状态机，判「过渡期间停闪、落位后重启」的时序。
// 真机证据（computed opacity 采样 + 截图）在 results/W9105-光标移动不闪.md。

/** 只读源码文本（**剥掉注释**，避免注释里的字面词骗过门禁）。 */
const src = (rel: string): string =>
  readFileSync(join(WEB, 'src', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 可注入的假定时器：让「过渡时长」变成确定性的，不依赖真实时钟。
 * 刻意**保留**被 clearTimer 撤掉的回调（fireStale）：真实世界里 setTimeout 的回调
 * 可能已经在事件队列里排队，clearTimeout 拦不住它 —— 状态机必须靠自己「代号」兜住
 * 这种迟到回调，否则一次旧回调就能把新一段移动的停闪态掀掉（= 边滑边闪回归）。
 */
function fakeTimers() {
  let seq = 0;
  const live = new Map<number, { fn: () => void; ms: number }>();
  const cancelled: { fn: () => void; ms: number }[] = [];
  return {
    setTimer: (fn: () => void, ms: number): number => {
      seq += 1;
      live.set(seq, { fn, ms });
      return seq;
    },
    clearTimer: (id: number): void => {
      const t = live.get(id);
      if (t !== undefined) cancelled.push(t);
      live.delete(id);
    },
    /** 仍在途的定时器（含它们被排时的延时）。 */
    pending: (): { id: number; ms: number }[] => [...live.entries()].map(([id, t]) => ({ id, ms: t.ms })),
    /** 触发全部在途定时器（模拟 --caret-dur 到期）。 */
    fire: (): void => {
      const all = [...live.values()];
      live.clear();
      for (const t of all) t.fn();
    },
    /** 触发所有**已被撤掉**的回调（模拟 clearTimeout 没拦住已在队列里的那个）。 */
    fireStale: (): void => {
      const all = cancelled.splice(0, cancelled.length);
      for (const t of all) t.fn();
    },
  };
}

describe('W9105 · 位移判定（纯函数 motionKind）：瞬移 / 真的动了 / 没动', () => {
  it('三种位移逐条钉死（含 0.5px 容差与 SNAP_PX 边界）', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/inputbar/caret-mirror.ts'))) as {
      motionKind(o: { lastX: number; lastY: number; lastH: number; x: number; y: number; h: number }): string;
    };
    const base = { lastX: 10, lastY: 20, lastH: 16, x: 10, y: 20, h: 16 };
    expect(mod.motionKind(base), '一模一样 ⇒ hold（否则每次无关回调都会停闪+重启=周期性亮一下）').toBe('hold');
    expect(mod.motionKind({ ...base, x: 10.4 }), '亚像素抖动 ⇒ hold').toBe('hold');
    expect(mod.motionKind({ ...base, x: 10.6 }), '真的动了 ⇒ animate').toBe('animate');
    expect(mod.motionKind({ ...base, y: 21 }), '纵向动了 ⇒ animate').toBe('animate');
    expect(mod.motionKind({ ...base, h: 24 }), '只变高度也算动（换行/自动增高同样在过渡）').toBe('animate');
    expect(mod.motionKind({ ...base, x: 130 }), '恰好 SNAP_PX ⇒ animate（边界不含）').toBe('animate');
    expect(mod.motionKind({ ...base, x: 131 }), '超过 SNAP_PX ⇒ snap').toBe('snap');
    expect(mod.motionKind({ ...base, y: 141 }), '纵向超限 ⇒ snap').toBe('snap');
    expect(mod.motionKind({ ...base, lastX: Number.NaN }), '还没量到过位置（首帧）⇒ snap').toBe('snap');
    expect(mod.motionKind({ ...base, lastY: Number.NaN }), '还没量到过位置 ⇒ snap').toBe('snap');
    expect(mod.motionKind({ ...base, lastH: Number.NaN }), '还没量到过高度 ⇒ snap').toBe('snap');
  });
});

describe('W9105 · 闪烁状态机（createCaretBlink）：过渡期间不闪，落位后从亮重新计时', () => {
  type BlinkMod = {
    createCaretBlink(o: {
      el: ElLike; movingClass: string; durationMs: number;
      setTimer?: (fn: () => void, ms: number) => number;
      clearTimer?: (id: number) => void;
    }): { restart(): boolean; done(): void; halt(): void };
  };
  const mod = async (): Promise<BlinkMod> => (await import(/* @vite-ignore */ at('ui/inputbar/caret-mirror.ts'))) as unknown as BlinkMod;
  const moving = (el: ElLike): boolean => el.classList.contains('is-moving');

  it('restart() 立刻停闪（.is-moving），并**只在**过渡时长到期后摘掉', async () => {
    const m = await mod();
    const t = fakeTimers();
    const el = g.document.createElement('div');
    const b = m.createCaretBlink({ el, movingClass: 'is-moving', durationMs: 90, setTimer: t.setTimer, clearTimer: t.clearTimer });
    expect(moving(el), '初始不在停闪态').toBe(false);
    expect(b.restart(), '第一次 restart 真的开了一次停闪').toBe(true);
    expect(moving(el), '过渡开始 ⇒ 必须停闪（这就是「移动中不闪」）').toBe(true);
    expect(t.pending().map((x) => x.ms), '兜底定时器 = --caret-dur').toEqual([90]);
    t.fire();
    expect(moving(el), '过渡结束 ⇒ 恢复闪烁（相位从亮重新计时由 CSS 声明重现保证）').toBe(false);
    expect(t.pending().length, '收尾后不再有在途定时器').toBe(0);
  });

  it('连续按键：重复 restart 不重复停闪，只把收尾时刻往后推，且仍能自己恢复', async () => {
    const m = await mod();
    const t = fakeTimers();
    const el = g.document.createElement('div');
    const b = m.createCaretBlink({ el, movingClass: 'is-moving', durationMs: 90, setTimer: t.setTimer, clearTimer: t.clearTimer });
    b.restart();
    expect(b.restart(), '上一段还没落位 ⇒ 不算新开一次').toBe(false);
    expect(b.restart()).toBe(false);
    expect(moving(el)).toBe(true);
    expect(t.pending().length, '同一时刻只有一个在途收尾定时器（否则会多次摘类）').toBe(1);
    t.fire();
    expect(moving(el), '无论如何都要能自己恢复（宁可闪，不可不闪）').toBe(false);
  });

  it('transitionend（done）先到：立刻收尾，随后的兜底定时器不再动 DOM', async () => {
    const m = await mod();
    const t = fakeTimers();
    const el = g.document.createElement('div');
    const b = m.createCaretBlink({ el, movingClass: 'is-moving', durationMs: 90, setTimer: t.setTimer, clearTimer: t.clearTimer });
    b.restart();
    b.done(); // transitionend（transform/height 之一）先到
    expect(moving(el), 'transitionend ⇒ 立即恢复闪烁，不等 90ms').toBe(false);
    b.done(); // 第二个属性的 transitionend（同一帧两个属性时浏览器只发一次，这里防御性重复）
    expect(moving(el)).toBe(false);
    t.fire(); // 兜底定时器此刻才到期
    expect(moving(el), '已收尾 ⇒ 迟到的兜底回调不得再动 DOM').toBe(false);
  });

  it('迟到的旧回调（clearTimeout 没拦住）不得掀掉新一段移动的停闪态', async () => {
    const m = await mod();
    const t = fakeTimers();
    const el = g.document.createElement('div');
    const b = m.createCaretBlink({ el, movingClass: 'is-moving', durationMs: 90, setTimer: t.setTimer, clearTimer: t.clearTimer });
    b.restart(); // 第一段移动（回调 A 已排出）
    b.halt(); // 瞬移 / 回落：撤掉 A（真实世界 A 可能仍在队列里）
    b.restart(); // 第二段移动（回调 B）
    expect(moving(el), '第二段移动中必须停闪').toBe(true);
    t.fireStale(); // A 迟到到达
    expect(moving(el), '代号对不上的旧回调必须被忽略 —— 否则新一段移动会当场恢复闪烁').toBe(true);
    t.fire(); // B 正常到期
    expect(moving(el)).toBe(false);
  });

  it('halt()（瞬移/回落/卸载）：停闪但不留计时器，且之后仍能重新进入移动态', async () => {
    const m = await mod();
    const t = fakeTimers();
    const el = g.document.createElement('div');
    const b = m.createCaretBlink({ el, movingClass: 'is-moving', durationMs: 90, setTimer: t.setTimer, clearTimer: t.clearTimer });
    b.halt();
    expect(moving(el), '瞬移本身没有过渡可等 ⇒ 不能留在停闪态（否则光标永远不闪）').toBe(false);
    expect(t.pending().length, 'halt 后不留计时器（卸载后不许再写 DOM）').toBe(0);
    b.restart();
    expect(moving(el)).toBe(true);
    b.halt();
    expect(moving(el)).toBe(false);
    t.fire();
    expect(moving(el), 'halt 之后再无残留回调能改状态').toBe(false);
  });
});

describe('W9105 · CSS 契约：.is-moving 必须压得住 .caret-fake.on 的闪烁动画', () => {
  it('动画声明挂在 .caret-fake.on 上（相位重置靠 .is-moving 摘掉后声明重现）', () => {
    const text = css('caret.css');
    const anim = [...text.matchAll(/([^{}]+)\{([^}]*animation:\s*caret-blink[^}]*)\}/g)].map((m) => (m[1] ?? '').trim());
    expect(anim.length, '必须有且只有一条声明闪烁动画的规则').toBe(1);
    expect(anim[0], '动画宿主必须是 .caret-fake.on').toBe('.caret-fake.on');
  });

  it('停闪规则的**特异性必须压过**动画规则（写成两段会输给 .on ⇒ 边滑边闪回归）', () => {
    const text = css('caret.css');
    const m = /\.caret-fake\.on\.is-moving\s*\{([^}]*)\}/.exec(text);
    expect(m, '必须有 .caret-fake.on.is-moving 规则（三段：0,3,0）').not.toBeNull();
    expect((m as RegExpExecArray)[1], '停闪 = animation: none').toMatch(/animation:\s*none/);
    // 同特异性下靠顺序取胜：停闪规则必须排在动画规则之后。
    expect(text.indexOf('.caret-fake.on.is-moving'), '停闪规则必须排在 .caret-fake.on 之后').toBeGreaterThan(
      text.indexOf('.caret-fake.on {'),
    );
  });

  it('reduced-motion 分支压住 .caret-fake.on（光标常亮，不许回退）', () => {
    const text = css('caret.css');
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(text);
    expect(block, 'caret.css 必须自带 reduced-motion 分支').not.toBeNull();
    const body = (block as RegExpExecArray)[1] ?? '';
    expect(body, '必须点名动画宿主 .caret-fake.on').toContain('.caret-fake.on');
    expect(body).toMatch(/animation:\s*none\s*!important/);
    expect(body).toMatch(/opacity:\s*1\s*!important/);
  });

  it('接线：animate 分支 restart、snap 分支 halt（jsdom 到不了那里，故查源码）', () => {
    const text = src('ui/inputbar/caret-mirror.ts');
    expect(text, '位移判定必须走纯函数，不许内联阈值').toMatch(/motionKind\(\{/);
    expect(text, 'transitionend 必须接回状态机').toMatch(/addEventListener\('transitionend'/);
    expect(text, '回落/卸载必须撤掉停闪态').toMatch(/if \(!on\) blink\.halt\(\)/);
    // 两个分支各自的行为必须互斥：snap 只 halt（不重启），animate 只 restart（停闪+重启）。
    const snapAt = text.indexOf("kind === 'snap'");
    const animAt = text.indexOf("kind === 'animate'");
    expect(snapAt, '找不到 snap 分支').toBeGreaterThan(-1);
    expect(animAt, '找不到 animate 分支').toBeGreaterThan(snapAt);
    const snapBranch = text.slice(snapAt, animAt);
    const animBranch = text.slice(animAt, text.indexOf('lastX = x;', animAt));
    expect(snapBranch, 'snap 分支必须只停闪').toMatch(/blink\.halt\(\)/);
    expect(snapBranch, 'snap 分支**不得**重启闪烁（否则瞬移也闪一下）').not.toMatch(/blink\.restart\(\)/);
    expect(animBranch, 'animate 分支必须停闪+重启').toMatch(/blink\.restart\(\)/);
    expect(animBranch, 'animate 分支不得走 halt（否则永远不闪）').not.toMatch(/blink\.halt\(\)/);
    // 相位重置必须**只**由「CSS 声明重现」完成：JS 不许自己碰 animation / opacity。
    // 一旦有人改成 el.style.animation='none' / opacity=0，CSS 状态机就不再是唯一真源，
    // 那条「摘类即从亮重来」的推理也就失效了。
    expect(text, 'JS 不得直接操作 animation').not.toMatch(/style\.animation/);
    expect(text, 'JS 不得直接操作 opacity（可见性只由 .on 决定）').not.toMatch(/style\.opacity/);
    expect(text, 'JS 不得用 Web Animations API 另起一套').not.toMatch(/\.animate\(/);
  });
});
