// ============================================================================
// ui/sessionbar.ts — 当前聚焦会话条（chrome，W514）：
//   一行显示「聚焦会话（标题/worker 标记/运行态）」，并在**其它**会话运行中时
//   给出可点击的快捷入口 —— 明确区分「运行中的会话」与「当前聚焦的会话」。
//   只更新文本与 class；快捷入口仅在集合变化时一次性替换（铁律 1/5/6）。
//
// W1471：worker 会话页补上**回程** —— 聚焦一个 worker 时，本行右侧给出
//   「← 返回 <父会话>」入口（点它回到派发这个 worker 的会话）。为什么落在这里：
//   本行已经在回答「我现在看的是谁」（WORKER + 名字），「它属于谁」是同一句话的
//   下半句；它常驻会话页、不随正文滚动，不需要用户先发现左上角的快捷条。
//   谱系事实见 ui/worker-lineage.ts（只读派生；无父可回时按既有口径如实说明）。
// ============================================================================
import { el, need } from '../utils/dom';
import { activePane, allPanes, paneBusy, type SessionPane } from './viewctx';
import { openSession } from './restore';
import { lineageOf, type LineageLink } from './worker-lineage';
import { installTaskPanel } from './taskpanel'; // W1533：会话页顶部的任务面板（todo list）
import { t } from '../i18n';

let nameEl: HTMLElement | null = null;
let kindEl: HTMLElement | null = null;
let stateEl: HTMLElement | null = null;
let lineageEl: HTMLElement | null = null;
let othersEl: HTMLElement | null = null;
let lastOthersKey = '\u0000';
let lastLineageKey = '\u0000';

function labelOf(pane: SessionPane): string {
  const title = (pane.title ?? '').trim();
  if (title) return title;
  if (pane.id === '') return t('shell.sessbar.unresolved');
  const i = pane.id.lastIndexOf('/');
  return i >= 0 ? pane.id.slice(i + 1) : pane.id;
}

export function initSessionBar(): void {
  // W1533：任务面板的装配点。
  // 为什么落在这里：main.ts（架构师独占）在 initViewCtx() 之后紧接着调本函数，
  // 此刻每个会话视图容器 .sess-pane 都已存在 —— 面板正是挂进这些容器（见
  // ui/taskpanel/panel.ts 的位置决策）。装配是幂等的，重复调用无副作用。
  installTaskPanel();
  const bar = need<HTMLElement>('#sessionBar');
  nameEl = el('span', 'sess-bar-name', '—');
  kindEl = el('span', 'sess-bar-kind hidden', 'WORKER');
  stateEl = el('span', 'sess-bar-state', t('shell.sessbar.idle'));
  // W1471：worker 会话的「返回父会话」槽位（普通会话恒为空；见文件头落点说明）
  lineageEl = el('span', 'sess-bar-lineage');
  othersEl = el('span', 'sess-bar-others');
  // W1462：去掉「会话」前缀（.sess-bar-lead）—— 贴底信息行要「不显眼」，一个 SESSION 标签
  // 在这条 11px 灰字里是最响的元素；会话名本身（.sess-bar-name）已经说明这一格是什么。
  bar.replaceChildren(kindEl, nameEl, stateEl, lineageEl, othersEl);
}

/**
 * W1471：把谱系画进本行（只在「内容签名」变化时替换节点，铁律 6）。
 *   有父可回 → 可点按钮「← 返回 <名字>」；
 *   无父/父已不在 → **不可点**的说明（沿用 shell.worker.unlinked 既有口径）；
 *   行未知 → 什么都不画（诚实降级，见 worker-lineage.ts）。
 */
function paintLineage(link: LineageLink | null): void {
  if (lineageEl === null) return;
  const key = link === null ? '' : link.state + '\u0001' + link.id + '\u0001' + link.title;
  if (key === lastLineageKey) return;
  lastLineageKey = key;
  if (link === null) {
    lineageEl.replaceChildren();
    return;
  }
  lineageEl.replaceChildren();
  const sep = el('span', 'sess-bar-sep', '·');
  lineageEl.appendChild(sep);
  if (link.state !== 'ok') {
    // 诚实降级：不画死按钮，直接说明「这个 worker 没有可回的父会话」。
    const note = el('span', 'sess-bar-unlinked', t(link.state === 'gone' ? 'shell.sessbar.parentGone' : 'shell.worker.unlinked'));
    note.title = link.id === '' ? t('shell.worker.unlinked') : t('shell.sessbar.parentGoneHint', { id: link.id });
    lineageEl.appendChild(note);
    return;
  }
  const back = el('button', 'sess-bar-back', t('shell.sessbar.backToParent', { name: link.title })) as HTMLButtonElement;
  back.type = 'button';
  back.dataset.parent = link.id;
  back.title = t('shell.worker.parentHint') + ' · ' + link.id;
  back.addEventListener('click', () => {
    openSession(link.id, { kind: 'session' });
  });
  lineageEl.appendChild(back);
}

/** 聚焦会话或运行态变化时调用（文本就地更新，不重建）。 */
export function updateSessionBar(): void {
  const pane = activePane();
  if (!nameEl || !stateEl || !kindEl || !othersEl) return;
  if (!pane) {
    nameEl.textContent = '—';
    stateEl.textContent = t('shell.sessbar.idle');
    stateEl.className = 'sess-bar-state';
    kindEl.classList.add('hidden');
    othersEl.replaceChildren();
    lastOthersKey = '\u0000';
    paintLineage(null);
    return;
  }
  const busy = pane.streaming || paneBusy(pane.id);
  nameEl.textContent = labelOf(pane);
  nameEl.title = pane.id || t('shell.sessbar.unresolvedShort');
  kindEl.classList.toggle('hidden', pane.kind !== 'worker');
  // W846：聚焦会话「运行中」的**文字**由 statusbar 的 #statusText 单点表达；
  // 本行只留状态点（.busy → ::before 绿点 + 呼吸，W790 语义不变），
  // 避免同一状态在状态区出现两次。非本地的「后台运行」另给文字以与纯运行区分。
  stateEl.textContent = busy ? (pane.streaming ? '' : t('shell.sessbar.background')) : t('shell.sessbar.idle');
  stateEl.className = 'sess-bar-state' + (busy ? ' busy' : '');
  // W1471：worker 会话页的回程入口（普通会话 → lineageOf 返回 null ⇒ 槽位清空）
  paintLineage(lineageOf(pane));

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
  off.appendChild(el('span', 'sess-bar-note', t('shell.sessbar.others', { n: others.length })));
  for (const p of others) {
    const chip = el('button', 'sess-bar-chip', labelOf(p)) as HTMLButtonElement;
    chip.type = 'button';
    chip.title = t('shell.sessbar.switchTo', { name: p.id || t('shell.sessbar.thatSession') });
    chip.addEventListener('click', () => {
      openSession(p.id, { kind: p.kind, title: p.title });
    });
    off.appendChild(chip);
  }
  othersEl.replaceChildren(...Array.from(off.childNodes));
}
