// ============================================================================
// ui/sessionbar.ts — 当前聚焦会话条（chrome，W514）：
//   一行显示「聚焦会话（标题/worker 标记/运行态）」，并在**其它**会话运行中时
//   给出可点击的快捷入口 —— 明确区分「运行中的会话」与「当前聚焦的会话」。
//   只更新文本与 class；快捷入口仅在集合变化时一次性替换（铁律 1/5/6）。
// ============================================================================
import { el, need } from '../utils/dom';
import { activePane, allPanes, paneBusy, type SessionPane } from './viewctx';
import { openSession } from './restore';

let nameEl: HTMLElement | null = null;
let kindEl: HTMLElement | null = null;
let stateEl: HTMLElement | null = null;
let othersEl: HTMLElement | null = null;
let lastOthersKey = '\u0000';

function labelOf(pane: SessionPane): string {
  const t = (pane.title ?? '').trim();
  if (t) return t;
  if (pane.id === '') return '当前会话（未解析）';
  const i = pane.id.lastIndexOf('/');
  return i >= 0 ? pane.id.slice(i + 1) : pane.id;
}

export function initSessionBar(): void {
  const bar = need<HTMLElement>('#sessionBar');
  nameEl = el('span', 'sess-bar-name', '—');
  kindEl = el('span', 'sess-bar-kind hidden', 'WORKER');
  stateEl = el('span', 'sess-bar-state', '空闲');
  othersEl = el('span', 'sess-bar-others');
  const lead = el('span', 'sess-bar-lead', '会话');
  bar.replaceChildren(lead, kindEl, nameEl, stateEl, othersEl);
}

/** 聚焦会话或运行态变化时调用（文本就地更新，不重建）。 */
export function updateSessionBar(): void {
  const pane = activePane();
  if (!nameEl || !stateEl || !kindEl || !othersEl) return;
  if (!pane) {
    nameEl.textContent = '—';
    stateEl.textContent = '空闲';
    stateEl.className = 'sess-bar-state';
    kindEl.classList.add('hidden');
    othersEl.replaceChildren();
    lastOthersKey = '\u0000';
    return;
  }
  const busy = pane.streaming || paneBusy(pane.id);
  nameEl.textContent = labelOf(pane);
  nameEl.title = pane.id || '（未解析）';
  kindEl.classList.toggle('hidden', pane.kind !== 'worker');
  stateEl.textContent = busy ? (pane.streaming ? '运行中' : '运行中 · 后台') : '空闲';
  stateEl.className = 'sess-bar-state' + (busy ? ' busy' : '');

  const others = allPanes().filter((p) => p !== pane && (p.streaming || paneBusy(p.id)));
  const key = others.map((p) => p.id).join('|');
  if (key === lastOthersKey) return;
  lastOthersKey = key;
  if (!others.length) {
    othersEl.replaceChildren();
    return;
  }
  const off = document.createDocumentFragment();
  off.appendChild(el('span', 'sess-bar-sep', '·'));
  off.appendChild(el('span', 'sess-bar-note', '另有 ' + others.length + ' 个会话运行中：'));
  for (const p of others) {
    const chip = el('button', 'sess-bar-chip', labelOf(p)) as HTMLButtonElement;
    chip.type = 'button';
    chip.title = '切换到 ' + (p.id || '该会话');
    chip.addEventListener('click', () => {
      openSession(p.id, { kind: p.kind, title: p.title });
    });
    off.appendChild(chip);
  }
  othersEl.replaceChildren(...Array.from(off.childNodes));
}
