// @vitest-environment jsdom
/**
 * W871 · 三条前端定位/范围缺陷的机械回归（真实模块 + 真实 index.html + 几何垫片）。
 *
 * 用户报案（都由 W867 引入/暴露）：
 *   ① 「我说的是 statusline 和下面的会话发送栏是一体圆角，你直接给整个会话页圆角了」
 *   ② 「点 Full Access 弹出的面板错位到左边」
 *   ③ 「鼠标悬浮会话树的 session 行，弹出的『xxx 点击打开』提示也错位」
 *
 * 本文件的几何断言全部是**具体数字区间**（不是「存在即通过」）。数字来源 =
 * headless Chromium 1280×800 上对真实 build 产物的实测（原始 json 见报告
 * /server-center/runtime/worker-exec/results/W871-圆角范围与弹层错位.md）：
 *   结构     pre-W867: #messages L322 W958 ｜ W867(bug): L331 W940（margin 8 + border 0.5）
 *   提示卡   W867: 卡片 L330 T255.56（行右缘 303 / 行下沿 249.56）、style.left 恒 8px
 *   档位弹层 W867: 面板 L345 vs 触发键 #slPerm L1125.45（横向差 −780.45px）
 *
 * jsdom 无排版 ⇒ 本文件给锚点/宿主装**几何垫片**（getBoundingClientRect / offsetWidth
 * / offsetHeight 桩），把「坐标口径」跑通；像素级落位由上面那次真机实测复验。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, WEB, type ElLike } from './lib/w795-dom.js';

const css = (rel: string): string => readFileSync(join(WEB, 'src', 'styles', rel), 'utf8');
const src = (rel: string): string => readFileSync(join(WEB, 'src', rel), 'utf8');
const indexHtml = (): string => readFileSync(join(WEB, 'index.html'), 'utf8');

/** 取某选择器**最后一条**规则体（后写的规则才生效）。 */
function rule(text: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = [...text.matchAll(new RegExp(esc + '\\s*\\{([^}]*)\\}', 'g'))];
  expect(all.length, '找不到规则：' + selector).toBeGreaterThan(0);
  return all[all.length - 1]?.[1] ?? '';
}

interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): Rect }
const rect = (left: number, top: number, right: number, bottom: number): Rect =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top });

/** 给节点装几何垫片（只影响被点名的节点，其余仍是 jsdom 的 0 矩形）。 */
function geom(node: unknown, r: Rect): Rect {
  (node as RectHost).getBoundingClientRect = () => r;
  return r;
}

/**
 * jsdom 的 offsetWidth/offsetHeight 是只读 getter 且恒为 0 —— 而落位算式
 * （ui/hint/card.ts 的 place()、ui/anchor-popup.ts 的 naturalSize()）要读它们做
 * 越界回退与 max-height。这里把原型上的 getter 换成常量，模拟真机实测的卡片尺寸。
 */
function stubBoxSize(w: number, h: number): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
  const before = {
    w: Object.getOwnPropertyDescriptor(proto, 'offsetWidth'),
    h: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
  };
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => w });
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => h });
  return () => {
    if (before.w) Object.defineProperty(proto, 'offsetWidth', before.w);
    if (before.h) Object.defineProperty(proto, 'offsetHeight', before.h);
  };
}

/** 真实 index.html 的 <body>（#main / .chat-shell / 三条发送栏与线上同构）。 */
function useRealBody(): void {
  const raw = indexHtml();
  doc.body.innerHTML = raw.slice(raw.indexOf('<body>') + 6, raw.indexOf('</body>'));
}

/** 视口尺寸垫片 + 复位器。 */
function viewport(w: number, h: number): () => void {
  const g = globalThis as unknown as { innerWidth: number; innerHeight: number };
  const old = { w: g.innerWidth, h: g.innerHeight };
  g.innerWidth = w;
  g.innerHeight = h;
  return () => { g.innerWidth = old.w; g.innerHeight = old.h; };
}

const px = (v: unknown): number => Number.parseFloat(String(v ?? 'NaN'));
const styleOf = (n: ElLike): Record<string, unknown> => n.style as unknown as Record<string, unknown>;

// ============================================================================
// ① 结构 + ② 滚动几何 + ③ 输入框宽度不变量
// ============================================================================

describe('W871 ① · .chat-shell 的范围 = 底部发送栏，不是整个会话页', () => {
  beforeEach(() => resetHarness());
  afterEach(() => doc.body.replaceChildren());

  it('#messages 在 .chat-shell 外；外框挂在 #main 内', () => {
    useRealBody();
    const shell = doc.querySelector('.chat-shell');
    expect(shell?.parentElement?.id, '外框仍在 #main 内').toBe('main');
    const msgs = doc.querySelector('#messages');
    expect(msgs?.closest('.chat-shell'), '#messages 不得被框住').toBeNull();
    expect(msgs?.parentElement?.id, '#messages 必须直接挂在 #main 下').toBe('main');
  });

  it('滚动几何不变：.sess-pane 仍是唯一滚动容器；外框既不滚也不裁', () => {
    useRealBody();
    const shell = rule(css('layout.css'), '.chat-shell');
    expect(rule(css('views.css'), '.sess-pane')).toContain('overflow-y: auto');
    expect(rule(css('views.css'), '#messages')).toContain('overflow: hidden');
    expect(shell, '外框不参与滚动（滚动仍是 .sess-pane）').not.toContain('overflow-y');
    expect(shell, '外框不得裁剪（三个 .sl-popup 从这里向上弹）').not.toContain('overflow: hidden');
    expect(shell, '外框只包内容：grow 会把发送栏拉高、把 #messages 挤矮').toContain('flex: 0 0 auto');
    expect(shell, '圆角走 token，不硬编码 px').toMatch(/border-radius:\s*var\(--r-/);
    for (const f of ['layout.css', 'responsive.css', 'statusline.css', 'hint.css', 'rail.css']) {
      expect(css(f), f + ' 不得出现虚线').not.toMatch(/\b(dashed|dotted)\b/);
    }
  });

  it('W847 输入框宽度不变量：外框改动不动输入栏的任何几何声明', () => {
    useRealBody();
    const bar = rule(css('layout.css'), '#inputbar');
    expect(bar, '输入栏仍是 flex + stretch（#input 吃满剩余宽度）').toContain('align-items: stretch');
    expect(rule(css('layout.css'), '.input-box')).toContain('flex: 1 1 auto');
    expect(rule(css('layout.css'), '#input')).toContain('flex: 1');
    // A2：展示夹改为内嵌行 —— 仍出流（flex-basis:100% 独占一行，不参与 #input 的 flex
    // 分配），但已**不是**绝对定位浮层；#input 宽度的两个真源声明照旧。
    expect(rule(css('attachments.css'), '.attach-tray'), 'A2 内嵌：独占一行、不抢 #input 槽位').toContain('flex: 0 0 100%');
    expect(rule(css('attachments.css'), '.attach-tray'), 'A2 起不再是浮层').not.toContain('position: absolute');
  });
});

// ============================================================================
// ④ hover 提示：宿主 = body，卡片 fixed，落位用视口坐标
// ============================================================================

interface HintMod {
  initHints(): void;
  setHint(t: ElLike, s: string | null): void;
  hoverHint(t: ElLike | null): void;
  hintCardEl(): ElLike | null;
}

/** 真机实测的侧栏会话行：L12 T218.94 R303 B249.56（#main 从 322 起）。 */
const LEAF = rect(12, 218.94, 303, 249.56);
/** 真机实测的提示卡尺寸。 */
const CARD = { w: 218, h: 30.67 };

async function bootHint(): Promise<{ hint: HintMod; leaf: ElLike }> {
  useRealBody();
  const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
  hint.initHints();
  const leaf = doc.createElement('div') as unknown as ElLike;
  leaf.className = 'sess-leaf';
  doc.querySelector('#sessionTree')?.appendChild(leaf);
  geom(leaf, LEAF);
  hint.setHint(leaf, '甲会话（点击打开）');
  return { hint, leaf };
}

describe('W871 ② · 会话树 hover 提示落在行的右下方，不再飞到主区', () => {
  let restore: () => void;
  beforeEach(() => {
    resetHarness();
    restore = viewport(1280, 800);
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  });
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('卡片宿主 = body；left = 行左缘 + GAP(12)、top = 行下沿 + 6，与真机实测逐像素一致', async () => {
    const restoreBox = stubBoxSize(CARD.w, CARD.h);
    try {
      const { hint, leaf } = await bootHint();
      hint.hoverHint(leaf);
      // W896：显式 5s。默认 1s 在 CPU 争用下不够（本仓其它 waitFor 同此约定）。
      await vi.waitFor(() => expect(hint.hintCardEl()).not.toBeNull(), { timeout: 5_000 });
      const card = hint.hintCardEl() as ElLike;
      expect(card.parentElement?.tagName, '宿主 = document.body（全站定位基准）').toBe('BODY');
      expect(rule(css('hint.css'), '.hint-card'), 'fixed ⇒ style.left/top 与 rect 同坐标系').toContain('position: fixed');
      const left = px(styleOf(card)['left']);
      const top = px(styleOf(card)['top']);
      // GAP = 12、纵向 +6（ui/hint/card.ts 的常量）。真机实测：style = {left:'24px',
      // top:'255.562px'}、rect = {left:24, top:255.56, right:242, bottom:286.23}。
      expect(left, 'left = 行左缘(12) + GAP(12) —— 与真机实测的 24px 一致').toBe(24);
      expect(top, 'top = 行下沿(249.56) + 6 —— 与真机实测的 255.56 一致').toBeCloseTo(255.56, 2);
      // 具体几何断言（不是「存在即通过」）：
      expect(left, 'left ≥ 行左缘（不再被夹成与锚点无关的常量）').toBeGreaterThanOrEqual(LEAF.left);
      expect(top, 'top ≥ 行下沿（落在行的下方，不盖住行）').toBeGreaterThanOrEqual(LEAF.bottom);
      expect(top - LEAF.bottom, '与行下沿的间距恰为 6').toBeCloseTo(6, 2);
      expect(left + CARD.w, '不出视口右缘（行右缘 303，卡片右缘 242）').toBeLessThanOrEqual(1280);
      expect(top + CARD.h, '不出视口下缘').toBeLessThanOrEqual(800);
      // 与旧口径的差别：旧实现被夹到 EDGE=8、卡片画在 #main 里（x≥330），不贴行
      expect(left, '必须落在侧栏（旧实现画在 #main 内、x≥330）').toBeLessThan(316);
    } finally {
      restoreBox();
    }
  });

  it('右/下越界时回退到行左上方，仍不出视口（回退分支真的存在）', async () => {
    const restoreBox = stubBoxSize(CARD.w, CARD.h);
    try {
      const { hint, leaf } = await bootHint();
      // 行贴近视口右下角（真机窄屏/末行的场景）
      geom(leaf, rect(1100, 760, 1260, 790));
      hint.setHint(leaf, '末行会话（点击打开）');
      hint.hoverHint(leaf);
      // W896：显式 5s。默认 1s 在 CPU 争用下不够（本仓其它 waitFor 同此约定）。
      await vi.waitFor(() => expect(hint.hintCardEl()).not.toBeNull(), { timeout: 5_000 });
      const card = hint.hintCardEl() as ElLike;
      const left = px(styleOf(card)['left']);
      const top = px(styleOf(card)['top']);
      // 右越界（1100 + 12 + 218 = 1330 > 1280 − 8）→ 左缘回退到「行右缘 − 卡宽」= 1042
      expect(left, '右越界 → 卡片右缘贴回行右缘').toBeCloseTo(1260 - CARD.w, 5);
      // 下越界（790 + 6 + 30.67 = 826.67 > 800 − 8）→ 翻到行的上方（760 − 30.67 − 6）
      expect(top, '下越界 → 翻到行的上方').toBeCloseTo(760 - CARD.h - 6, 5);
      expect(left, '仍不出视口左边').toBeGreaterThanOrEqual(8);
      expect(top, '仍不出视口上边').toBeGreaterThanOrEqual(8);
      expect(left + CARD.w, '回退后右缘不再越界').toBeLessThanOrEqual(1280 - 8);
      expect(top + CARD.h, '回退后下缘不再越界').toBeLessThanOrEqual(800 - 8);
    } finally {
      restoreBox();
    }
  });

  it('rail 的自定义 position() 仍被优先调用（换宿主不破坏 rail 预览卡）', async () => {
    const { hint } = await bootHint();
    const built = doc.createElement('div') as unknown as ElLike;
    built.className = 'railv3-card';
    const anchor = doc.createElement('div') as unknown as ElLike;
    doc.body.appendChild(built);
    doc.body.appendChild(anchor);
    let called = 0;
    const registry = (await import(/* @vite-ignore */ at('ui/hint/registry.ts'))) as {
      registerHintPlugin(p: unknown): () => void;
    };
    registry.registerHintPlugin({
      id: 'w871-rail',
      priority: 99,
      claim: () => ({
        build: () => built,
        position: (box: ElLike) => { called += 1; styleOf(box)['left'] = '4242px'; },
      }),
    });
    hint.setHint(anchor, 'rail 预览');
    hint.hoverHint(anchor);
    await vi.waitFor(() => expect(hint.hintCardEl()).not.toBeNull(), { timeout: 5_000 });
    expect(called, '自定义 position() 必须被调用（引擎不得越权改写）').toBe(1);
    expect(String(styleOf(hint.hintCardEl() as ElLike)['left'])).toBe('4242px');
    expect(hint.hintCardEl()?.parentElement?.tagName, 'rail 卡与文本卡同宿主').toBe('BODY');
    expect(rule(css('rail.css'), '.railv3-card'), 'rail 卡与宿主同坐标系（fixed + 视口坐标）').toContain('position: fixed');
  });

  it('rail 预览卡落位 = 视口坐标（卡片 fixed；纯函数 railCardPlacement 逐数字可断言）', async () => {
    // 真机 1280×800 实测：长条 rect.right=402、#main 在 (322, 54.09)、railX=8
    // ⇒ 卡片 left 必须是 410（= 402 + 8）、top 必须等于长条 top（335.7）。
    const geom = (await import(/* @vite-ignore */ at('ui/rail-geom.ts'))) as {
      RAIL_CARD_W: number;
      railCardPlacement(i: {
        mainX: number; mainY: number; mainW: number;
        railTop: number; railH: number; railX: number;
        anchor: { top: number; right: number }; cardH: number;
      }): { top: number; left: number };
    };
    const place = geom.railCardPlacement({
      mainX: 322, mainY: 54.09, mainW: 958,
      railTop: 9, railH: 550.14, railX: 8,
      anchor: { top: 335.7, right: 402 }, cardH: 79.3,
    });
    expect(geom.RAIL_CARD_W, '卡片宽与 styles/rail.css 的 width 同源').toBe(280);
    expect(place.left, 'left = 长条右缘(402) + 8 —— 真机实测 410').toBe(410);
    expect(place.top, 'top 与长条顶对齐（未触发纵向 clamp）').toBeCloseTo(335.7, 5);
    // 旧口径（相对 #main）：88 会被 fixed 当成视口 x=88 ⇒ 卡片落到侧栏、与长条错开 242px
    expect(place.left - (402 - 322 + 8), '新口径 + #main 左缘 = 视口坐标').toBe(322);
    // 纵向 clamp 仍在（贴轨道上下缘，不越出长条带）
    const up = geom.railCardPlacement({ mainX: 322, mainY: 54.09, mainW: 958, railTop: 9, railH: 550.14, railX: 8, anchor: { top: 54, right: 402 }, cardH: 79.3 });
    expect(up.top, '长条高于轨道顶 → 夹到 railTop + 4').toBe(54.09 + 13);
    const down = geom.railCardPlacement({ mainX: 322, mainY: 54.09, mainW: 958, railTop: 9, railH: 550.14, railX: 8, anchor: { top: 900, right: 402 }, cardH: 79.3 });
    expect(down.top, '长条低于轨道底 → 夹到 railTop + railH − 卡高 − 4').toBeCloseTo(54.09 + 9 + 550.14 - 79.3 - 4, 5);
    // 横向也不越出 #main
    const far = geom.railCardPlacement({ mainX: 322, mainY: 54.09, mainW: 500, railTop: 9, railH: 550.14, railX: 8, anchor: { top: 335.7, right: 1500 }, cardH: 79.3 });
    expect(far.left, '横向上限 = mainX + mainW − 卡宽').toBe(322 + 500 - 280);
    // 接线：rail.ts 的 positionCard 必须走这个纯函数（不得自己再写一套）
    const rail = src('ui/rail.ts');
    const fn = rail.slice(rail.indexOf('function positionCard'));
    const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'));
    expect(body, 'positionCard 走纯函数').toContain('railCardPlacement');
    expect(rule(css('rail.css'), '.railv3-card'), '卡片与宿主同坐标系（fixed）').toContain('position: fixed');
  });

  it('反向变异对照：旧口径（宿主 #main + 相对坐标）在同一锚点下必然错位', () => {
    // 旧实现：left = a.left − h.left + GAP；#main 左缘 322 > 行左缘 12
    const main = rect(322, 54.09, 1280, 800);
    const oldLeft = LEAF.left - main.left + 12;
    expect(oldLeft, '旧口径算出负值').toBeLessThan(0);
    expect(Math.max(8, oldLeft), '夹到 EDGE=8 后与锚点无关（真机实测 style.left 恒 8px）').toBe(8);
    // 新口径：直接写视口坐标（= 真机实测的 24px）
    expect(LEAF.left + 12).toBe(24);
    expect(LEAF.left + 12 - LEAF.left).toBe(12);
  });
});

// ============================================================================
// ⑤ 档位弹层：唯一落位适配器（复用 panelGeom）
// ============================================================================

interface AnchorPopupMod {
  anchorOf(btn: ElLike | null): Rect | null;
  placeAnchoredPopup(popup: ElLike, anchor: Rect): void;
}

describe('W871 ③ · 档位弹层锚到触发键 #slPerm（视口坐标 + panelGeom）', () => {
  let restore: () => void;
  beforeEach(() => {
    resetHarness();
    useRealBody();
    restore = viewport(1280, 800);
    // 真机实测：徽标在发送栏**右端**
    geom(doc.querySelector('#slPerm'), rect(1125.45, 623.23, 1223, 641.23));
    geom(doc.querySelector('#statusline'), rect(331, 613.23, 1271, 672.2));
  });
  afterEach(() => {
    restore();
    doc.body.replaceChildren();
  });

  it('落位 = 下沿贴锚点上沿 − gap、右缘对齐锚点右缘（具体数字）', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/anchor-popup.ts'))) as AnchorPopupMod;
    const popup = doc.createElement('div') as unknown as ElLike;
    popup.className = 'sl-popup perm-popup';
    doc.body.appendChild(popup);
    const restoreBox = stubBoxSize(420, 47.97);
    try {
      const anchor = mod.anchorOf(doc.querySelector('#slPerm'));
      expect(anchor, '锚点取自触发键').not.toBeNull();
      mod.placeAnchoredPopup(popup, anchor as Rect);

      const left = px(styleOf(popup)['left']);
      const top = px(styleOf(popup)['top']);
      // panelGeom：left = clamp(anchor.right − panelW) = 1223 − 420 = 803；真机实测 803 ✓
      expect(left, '面板右缘与触发键右缘对齐（1223 − 420）').toBe(803);
      // top = anchor.top − gap(8) − height(47.97) = 567.26 → round 567；真机实测 567 ✓
      expect(top, '面板下沿贴触发键上沿 − 8px 间距').toBe(567);
      expect(top + 47.97, '面板下沿在触发键上沿之上').toBeLessThan(623.23);
      // panelGeom 把 top 四舍五入到整px（567），故实测间距 8.26 = gap 8 + 取整 0.26
      expect(623.23 - (top + 47.97), '与触发键的垂直间距 = gap(8) ± 取整(<1px)').toBeCloseTo(8, 0);
      // 与旧口径的对照：旧实现恒 left:14px ⇒ 面板左缘 345，横向差 −780.45px
      const oldLeft = 331 + 14;
      expect(oldLeft, '旧口径的面板左缘（真机实测 345）').toBe(345);
      expect(left - oldLeft, '新口径比旧口径右移 458px（旧值就是「错位到左边」）').toBe(458);
      // 面板不出视口
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + 420).toBeLessThanOrEqual(1280 - 8);
      expect(top).toBeGreaterThanOrEqual(8);
    } finally {
      restoreBox();
    }
  });

  it('真实模块开弹层：openPermissionPopup 走 placePopup()，内联 top/left 与 panelGeom 一致', async () => {
    const restoreBox = stubBoxSize(420, 47.97);
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      const payload = u.includes('/permission')
        ? { ok: true, preset: 'full-access', effective: [] }
        : {
            ok: true,
            max: 'full-access',
            presets: [
              { id: 'read-only', label: 'Read only', network: false, workspaceWritable: false, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: [] },
              { id: 'full-access', label: 'Full access', network: true, workspaceWritable: true, toolRootsWritable: true, writeRoots: [], allPaths: true, unsandboxed: true, toolDeny: [] },
            ],
          };
      return { ok: true, status: 200, json: async () => payload };
    });
    try {
      const store = (await import(/* @vite-ignore */ at('ui/permissions/store.ts'))) as {
        ensurePresets(): Promise<unknown>;
        resetPresetsForTest?(): void;
      };
      await store.ensurePresets();
      const perm = (await import(/* @vite-ignore */ at('statusline/permission.ts'))) as {
        openPermissionPopup(h: unknown): void;
        closePermissionPopup(): void;
      };
      const opened: string[] = [];
      perm.openPermissionPopup({
        root: doc.getElementById('statusline') as ElLike,
        sessionId: 'ws/s1',
        currentPreset: 'full-access',
        applyPermission: (p: string) => opened.push(p),
        setNote: () => {},
      });
      const popup = doc.querySelector('.sl-popup.perm-popup') as ElLike;
      expect(popup, '弹层必须建出来').not.toBeNull();
      // 位置一律由 JS 现算并写内联 —— 没写就是退回了 left:14px 死坐标
      const left = px(styleOf(popup)['left']);
      const top = px(styleOf(popup)['top']);
      expect(Number.isFinite(left), '必须写内联 left（旧口径靠 CSS 的 left:14px）').toBe(true);
      expect(Number.isFinite(top), '必须写内联 top').toBe(true);
      expect(left, 'right 对齐触发键右缘（1223 − 420）').toBe(803);
      expect(top, '下沿贴触发键上沿 − 8px').toBe(567);
      expect(px(styleOf(popup)['maxHeight']), '高度上限也由 panelGeom 给').toBeGreaterThan(0);
      // 具体几何关系：面板右缘 = 触发键右缘；面板整体落在发送栏右半侧（不再横跨到左边）
      expect(left + 420, '面板右缘 = #slPerm 右缘').toBe(1223);
      expect(left, '面板左缘必须 > 触发键左缘 − 面板宽 … 即落在发送栏右半侧').toBeGreaterThan(331 + 400);
      perm.closePermissionPopup();
      expect(doc.querySelector('.sl-popup.perm-popup'), '关闭后摘掉').toBeNull();
    } finally {
      restoreBox();
    }
  });

  it('锚点不可见时兜底为发送栏右缘（不返回 null、不抛）', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/anchor-popup.ts'))) as AnchorPopupMod;
    const anchor = mod.anchorOf(null);
    expect(anchor, '没有触发键也要有兜底锚点').not.toBeNull();
    expect((anchor as Rect).left, '兜底 = 发送栏右缘').toBe(1271);
    expect((anchor as Rect).width, '零宽锚点 ⇒ 不会误判为可见').toBe(0);
  });

  it('三个弹层共用同一套落位：档位弹层复用 placeAnchoredPopup，盾牌面板不再另写算式', () => {
    expect(src('ui/anchor-popup.ts'), '唯一适配器复用 panelGeom 纯函数').toContain('panelGeom');
    expect(src('ui/grants/panel/position.ts'), '盾牌面板走同一适配器').toContain('placeAnchoredPopup');
    expect(src('ui/grants/panel/position.ts'), '盾牌面板不再自己调 panelGeom（没有第二套算式）').not.toContain('panelGeom({');
    const perm = src('statusline/permission.ts');
    expect(perm, '档位弹层走同一适配器').toContain('placeAnchoredPopup');
    expect(perm, '锚点 = 触发键 #slPerm').toContain("getElementById('slPerm')");
    expect(perm, '挂载后现算（panelGeom 要量真实尺寸）').toContain('placePopup()');
    // 弹层是 fixed + 内联坐标 ⇒ 不再依赖 .sl-popup 基类的固定左边距
    const permRule = rule(css('permissions.css'), '.sl-popup.perm-popup');
    expect(permRule).toContain('position: fixed');
    expect(permRule, 'base 的 bottom/left 必须被 auto 掉（top+bottom 同存会拉伸高度）').toContain('bottom: auto');
    expect(permRule, 'right 也要归零（否则与 left 打架）').toContain('right: auto');
    expect(permRule, '窄屏要压得过 responsive 的 .sl-popup{width:auto}').toContain('width: min(420px');
    // 基类保留左端口径（模型/档位/工作方式三个左端触发键仍然对）
    expect(rule(css('statusline.css'), '.sl-popup')).toContain('left: 14px');
  });
});

