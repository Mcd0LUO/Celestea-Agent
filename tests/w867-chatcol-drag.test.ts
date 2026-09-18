// @vitest-environment jsdom
/**
 * W867 · 用户 5（2/2）：正文列宽（两侧留白）可自由调节放缩 —— 拖动 / 键盘 / 持久化 / 上下限。
 *
 * 驱动的是真实模块 ui/chatcol.ts：指针事件走它真实注册的 handler，宽度读
 * documentElement 的内联 --chat-col-user（applyChatCol 的唯一写出口），持久化走
 * 一个**记账版 localStorage**（jsdom 的 Storage 是 Proxy，spyOn 盖不住它的方法）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

const KEY = 'celestea-studio.chat-col-width';
const G = globalThis as unknown as {
  Event: new (t: string, i?: object) => Event;
  KeyboardEvent: new (t: string, i?: object) => Event;
};

interface ChatColMod {
  initChatCol(): void;
  readChatCol(): number | null;
  chatColValue(): number | null;
  clampChatCol(w: number): number;
  applyChatCol(w: number | null): void;
  CHAT_COL_STORAGE_KEY: string;
  CHAT_COL_MIN: number;
  CHAT_COL_MAX: number;
}

/** 记账版 localStorage：能读能写，并把每次写入原样记下来（断言「写几次、写什么」）。 */
class StorageRecorder {
  data = new Map<string, string>();
  writes: [string, string][] = [];
  removes: string[] = [];
  getItem(k: string): string | null {
    return this.data.has(k) ? (this.data.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
    this.writes.push([k, v]);
  }
  removeItem(k: string): void {
    this.data.delete(k);
    this.removes.push(k);
  }
}
let store: StorageRecorder;

/** 带 clientX/pointerId 的指针事件（jsdom 的 Event 构造器不接受这些字段）。 */
function pointer(type: string, clientX: number): Event {
  const e = new G.Event(type, { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: clientX });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}
const key = (k: string): Event => new G.KeyboardEvent('keydown', { key: k, bubbles: true });

interface GripLike {
  tabIndex: number;
  getAttribute(name: string): string | null;
  dispatchEvent(e: unknown): boolean;
}

const grip = (): GripLike => doc.querySelector('.chatcol-resizer') as unknown as GripLike;
const inlineChatCol = (): string =>
  (doc as unknown as { documentElement: { style: { getPropertyValue(p: string): string } } })
    .documentElement.style.getPropertyValue('--chat-col-user');

async function boot(): Promise<ChatColMod> {
  const mod = (await import(/* @vite-ignore */ at('ui/chatcol.ts'))) as ChatColMod;
  mod.initChatCol();
  return mod;
}

/** 装成「用户已经拖过一次」：先落一个持久化值，再按键读入。 */
function seeded(mod: ChatColMod, w: number): void {
  store.data.set(KEY, String(w));
  mod.initChatCol();
}

/** 在同一个手势里连拖 n 帧（每帧 +1px）。 */
function dragFrames(g: GripLike, n: number): void {
  g.dispatchEvent(pointer('pointerdown', 0));
  for (let i = 1; i <= n; i++) g.dispatchEvent(pointer('pointermove', i));
  g.dispatchEvent(pointer('pointerup', n));
}

describe('W867 · 用户 5：列宽可调（拖动 / 键盘 / 持久化 / 上下限）', () => {
  beforeEach(() => {
    resetHarness();
    store = new StorageRecorder();
    vi.stubGlobal('localStorage', store);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('装配：在 #messages 里挂一个可聚焦的竖分隔手柄（role=separator）', async () => {
    await boot();
    const g = grip();
    expect(g.getAttribute('role')).toBe('separator');
    expect(g.getAttribute('aria-orientation')).toBe('vertical');
    expect(g.tabIndex, '键盘可达').toBe(0);
    expect(inlineChatCol(), '没拖过 = 不写覆盖，保持缺省 clamp').toBe('');
  });

  it('拖动：列居中 ⇒ 位移的 2 倍变宽；拖动中不落盘，抬手落盘一次', async () => {
    const mod = await boot();
    seeded(mod, 700);
    expect(inlineChatCol()).toBe('700px');

    const g = grip();
    g.dispatchEvent(pointer('pointerdown', 200));
    g.dispatchEvent(pointer('pointermove', 240)); // +40px 位移
    expect(inlineChatCol(), '向右拖 = 列变宽（位移 2 倍）').toBe('780px');
    expect(store.writes, '拖动中每帧落盘毫无意义').toEqual([]);

    g.dispatchEvent(pointer('pointermove', 260)); // +60px
    expect(inlineChatCol()).toBe('820px');
    g.dispatchEvent(pointer('pointerup', 260));
    expect(store.writes, '抬手只写一次，写的是最终宽度').toEqual([[KEY, '820']]);
  });

  it('抖动合并：一次手势里 30 帧微动 = 1 次写盘（只有收尾那次）', async () => {
    const mod = await boot();
    seeded(mod, 700);
    dragFrames(grip(), 30);
    expect(store.writes.length, '30 帧微动合并成 1 次写盘').toBe(1);
    expect(store.writes[0]).toEqual([KEY, '760']);
  });

  it('左右上下限：窄不过 560、宽不过 1400（拖过头只会夹住，不会溢出/不可读）', async () => {
    const mod = await boot();
    expect([mod.CHAT_COL_MIN, mod.CHAT_COL_MAX]).toEqual([560, 1400]);
    expect(mod.clampChatCol(1)).toBe(560);
    expect(mod.clampChatCol(99999)).toBe(1400);
    const g = grip();
    seeded(mod, 700);
    g.dispatchEvent(pointer('pointerdown', 0));
    g.dispatchEvent(pointer('pointermove', -9999)); // 往左拖到底
    expect(inlineChatCol()).toBe('560px');
    g.dispatchEvent(pointer('pointermove', 9999)); // 往右拖到底
    expect(inlineChatCol()).toBe('1400px');
    g.dispatchEvent(pointer('pointerup', 9999));
    expect(store.data.get(KEY)).toBe('1400');
  });

  it('指针取消（pointercancel）同样落盘，不留半个手势', async () => {
    const mod = await boot();
    seeded(mod, 700);
    const g = grip();
    g.dispatchEvent(pointer('pointerdown', 0));
    g.dispatchEvent(pointer('pointermove', 50));
    g.dispatchEvent(pointer('pointercancel', 50));
    expect(store.writes).toEqual([[KEY, '800']]);
    g.dispatchEvent(pointer('pointermove', 500)); // 手势已结束：不再改宽
    expect(inlineChatCol()).toBe('800px');
  });

  it('键盘：← / → 各走一步 16px；双击复位 = 删键回到缺省 clamp', async () => {
    const mod = await boot();
    expect(mod.readChatCol(), '没存过 → null（缺省），不是 0').toBeNull();
    seeded(mod, 700);
    mod.initChatCol(); // 幂等：不重复挂手柄、但会重放持久化值
    expect(doc.querySelectorAll('.chatcol-resizer').length).toBe(1);
    expect(inlineChatCol(), '装配时恢复持久化值').toBe('700px');

    const g = grip();
    g.dispatchEvent(key('ArrowRight'));
    expect(inlineChatCol()).toBe('716px');
    expect(store.data.get(KEY)).toBe('716');
    g.dispatchEvent(key('ArrowLeft'));
    expect(inlineChatCol()).toBe('700px');
    expect(store.data.get(KEY)).toBe('700');

    g.dispatchEvent(new G.Event('dblclick', { bubbles: true }));
    expect(inlineChatCol(), '双击复位 = 移除覆盖').toBe('');
    expect(store.data.has(KEY), '双击复位 = 删键（回到会随窗口变化的缺省）').toBe(false);
  });

  it('持久化容错：脏值 / 越界值 / storage 不可用都不得崩溃（回落缺省或夹住）', async () => {
    const mod = await boot();
    store.data.set(KEY, '不是数字');
    expect(mod.readChatCol()).toBeNull();
    store.data.set(KEY, '-5');
    expect(mod.readChatCol()).toBeNull();
    store.data.set(KEY, '99999');
    expect(mod.readChatCol(), '越界值夹到上限').toBe(1400);
    store.data.set(KEY, '12');
    expect(mod.readChatCol()).toBe(560);

    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('storage unavailable');
      },
      setItem() {
        throw new Error('storage unavailable');
      },
      removeItem() {
        throw new Error('storage unavailable');
      },
    });
    expect(() => mod.initChatCol()).not.toThrow();
    expect(mod.readChatCol(), 'storage 不可用 → 缺省，不崩').toBeNull();
  });
});
