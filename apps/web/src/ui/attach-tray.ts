// ============================================================================
// ui/attach-tray.ts — W867（追加）：附件「收纳展示夹」的**挂载与刷新**单一职责。
// ----------------------------------------------------------------------------
// A2（内嵌）：展示夹从「绝对定位浮在输入框上方」改为**内嵌在消息框与输入框之间的
//   一行紧凑条**——它是 #inputbar 的直接子项，插在 .input-box **之前**；CSS 给它
//   flex-basis:100% ⇒ 独占一行（#inputbar 允许换行），.input-box + .input-side 在
//   下一行按原规则分配宽度 ⇒ W847 的「#input 宽度逐像素不变」不变量不受影响
//   （本条既不在 .input-box 内参与 flex 分配，也不挤它的槽位）。
//   空列表 .hidden → display:none，不占任何高度。
// 不再需要 placeTray / ResizeObserver：行内布局由 CSS 负责，不存在「输入框长高后浮层
//   贴不住」的问题（这也是 A2 去掉浮层的收益之一）。
// placeAttachTray 保留为 **no-op 兼容导出**（既有调用方 / 测试仍可调，行为=不写定位）。
// ============================================================================
import { el } from '../utils/dom';
import { pendingList, removePending, renderTray } from './attachments';

let trayEl: HTMLElement | null = null;

/** A2：内嵌布局由 CSS 负责，落位不再需要写内联定位（保留导出仅为兼容）。 */
export function placeAttachTray(): void {
  /* no-op：见文件头 A2 说明 */
}

/**
 * 重建展示夹内容（选择 / 粘贴 / 拖入、发送清空、失败回滚后都要调）。
 * 离屏由 renderTray 内部完成（单次 replaceChildren）。
 */
export function refreshAttachmentTray(): void {
  if (!trayEl) return;
  renderTray(
    trayEl,
    pendingList(),
    (item) => {
      removePending(item);
      refreshAttachmentTray();
    },
    () => refreshAttachmentTray(), // 折叠/展开后重画折叠键的方向
  );
}

/**
 * 建出展示夹并**插在 .input-box 之前**（内嵌行；旧夹具没有 .input-box 时回落宿主）。
 * 不订阅尺寸变化：行内布局不依赖实测高度。
 */
export function createAttachTray(host: HTMLElement, box: HTMLElement | null): void {
  trayEl = el('div', 'attach-tray hidden');
  const anchor = box ?? host;
  if (anchor === host) host.appendChild(trayEl);
  else anchor.parentElement?.insertBefore(trayEl, anchor) ?? host.insertBefore(trayEl, host.firstChild);
}
