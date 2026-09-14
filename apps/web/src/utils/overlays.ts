// ============================================================================
// utils/overlays.ts — 浮层层级栈（Esc 关闭的唯一入口）
//
//   问题：设置页、编辑弹窗、内联面板、确认框各自注册 document Esc 监听，
//   按一次 Esc 会同时关掉多层（例如从设置页打开的提供商弹窗 → 关掉的是底层
//   设置页，弹窗变孤儿挂在 body 上）。
//
//   方案：全局只注册一个 document keydown 监听；每层浮层打开时 push 自己的
//   close 函数，Esc 只调用栈顶一层的 close。层自己关闭（按钮/保存成功）时
//   调 popOverlay(handle) 把该层从栈里摘掉，保证栈序与视觉层级一致。
// ============================================================================

/** 一层浮层的句柄：用于精准摘除该层（不用猜栈顶）。 */
export interface OverlayHandle {
  readonly id: number;
  readonly depth: number;
}

interface Entry {
  id: number;
  close: () => void;
  /** 已被摘除/已关闭：重复 pop 幂等。 */
  active: boolean;
}

const stack: Entry[] = [];
let seq = 0;
let bound = false;

function topEntry(): Entry | null {
  return stack.length ? stack[stack.length - 1]! : null;
}

function removeEntry(entry: Entry): boolean {
  if (!entry.active) return false;
  entry.active = false;
  const i = stack.indexOf(entry);
  if (i >= 0) stack.splice(i, 1);
  return true;
}

/** 唯一的 Esc 监听：只关闭栈顶一层。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = topEntry();
  if (!top) return;
  e.preventDefault();
  removeEntry(top);
  try {
    top.close();
  } catch {
    /* 单层关闭失败不得影响栈本身 */
  }
}

function ensureBound(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('keydown', onKeydown);
}

/** 压入一层浮层：返回句柄，供该层自己关闭时 popOverlay(handle) 使用。 */
export function pushOverlay(close: () => void): OverlayHandle {
  ensureBound();
  const entry: Entry = { id: ++seq, close, active: true };
  stack.push(entry);
  return { id: entry.id, depth: stack.length };
}

/** 摘除一层：无参 = 摘除栈顶（不调用其 close）；带句柄 = 摘除该层。 */
export function popOverlay(handle?: OverlayHandle): void {
  if (!handle) {
    const top = stack.pop();
    if (top) top.active = false;
    return;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i]!;
    if (e.id === handle.id) {
      removeEntry(e);
      return;
    }
  }
}

/** 关闭并摘除指定层之上的所有层（如关闭设置页时连带收起其派生的弹窗）。 */
export function closeOverlaysAbove(handle: OverlayHandle): void {
  const keep: Entry[] = [];
  const drop: Entry[] = [];
  for (const e of stack) (e.id > handle.id ? drop : keep).push(e);
  stack.length = 0;
  stack.push(...keep);
  for (let i = drop.length - 1; i >= 0; i--) {
    const e = drop[i]!;
    if (!e.active) continue;
    e.active = false;
    try {
      e.close();
    } catch {
      /* 忽略单层失败 */
    }
  }
}

/** 当前栈深（调试/自检用）。 */
export function overlayDepth(): number {
  return stack.length;
}
