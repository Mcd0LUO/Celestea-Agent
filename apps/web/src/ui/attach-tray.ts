// ============================================================================
// ui/attach-tray.ts — W867（追加）：附件「收纳展示夹」的**落位与尺寸**单一职责。
//
//   为什么单独成模块：inputbar.ts 是模块体积棘轮盯着的文件，而展示夹这一摊是
//   「DOM 生命周期 + 按实测矩形算位置」的自洽单元，与输入框本身的编辑/发送语义无关。
//
//   几何约定（styles/attachments.css 的 .attach-tray）：
//     position: absolute; bottom: var(--tray-h, 0px); left/right: 0
//   ⇒ 本模块只负责把 --tray-h 写成 .input-box 的**实测高度**，展示夹就永远浮在输入框
//   上沿之上、且**出流**（W847 的「#input 宽度逐像素不变」不变量因此不被破坏）。
//
//   为什么不用纯 CSS：输入框会随内容长高（max-height --composer-text-max-h），窄屏规则
//   还会改 padding —— 只有量出来的高度才能保证「不盖住正在输入的文字」。
// ============================================================================
import { el } from '../utils/dom';
import { pendingList, removePending, renderTray } from './attachments';

let trayEl: HTMLElement | null = null;
/** 定位基准（.input-box；旧夹具没有它时回落 #inputbar）。 */
let trayBox: HTMLElement | null = null;

/** 把展示夹钉在输入框**上沿之上**（height ≤ 0 时不写，避免把 0 当成有效值）。 */
export function placeAttachTray(): void {
  if (!trayEl || !trayBox) return;
  const r = trayBox.getBoundingClientRect();
  if (r.height > 0) trayEl.style.setProperty('--tray-h', r.height + 'px');
}

/**
 * 重建展示夹内容（选择 / 粘贴 / 拖入、发送清空、失败回滚后都要调）。
 * 先落位再画内容：输入框可能刚刚长高；折叠/移除回调重入时同理。
 */
export function refreshAttachmentTray(): void {
  if (!trayEl) return;
  placeAttachTray();
  renderTray(
    trayEl,
    pendingList(),
    (item) => {
      removePending(item);
      refreshAttachmentTray();
    },
    () => refreshAttachmentTray(), // 折叠/展开后重画折叠键的方向
  );
  placeAttachTray();
}

/**
 * 建出展示夹并挂进 .input-box（旧夹具无它时回落宿主），返回挂载点。
 * 同时订阅 .input-box 的尺寸变化重新贴位（ResizeObserver 不可用则跳过 —— 落位仍由
 * 每次 refresh 兜底，功能不缺）。
 */
export function createAttachTray(host: HTMLElement, box: HTMLElement | null): void {
  trayEl = el('div', 'attach-tray hidden');
  trayBox = box ?? host;
  // 绝对定位浮在框上方；出流 ⇒ 不挤 #input 宽度、不顶高 #inputbar。
  (box ?? host).appendChild(trayEl);
  if (typeof ResizeObserver === 'function' && trayBox) {
    try {
      new ResizeObserver(() => placeAttachTray()).observe(trayBox);
    } catch {
      /* 观察失败不影响附件功能 */
    }
  }
}
