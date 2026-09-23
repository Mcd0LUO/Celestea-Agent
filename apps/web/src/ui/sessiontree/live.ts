// ============================================================================
// ui/sessions/live.ts — 只看不改结构**的局部更新**（铁律 6：轮询/事件只做局部更新；
//   W748 从 ui/sessions.ts 拆出）。只切 class/文本/显隐，绝不重建树。
// ============================================================================
import { grantMarkOf, type GrantMark } from '../grants';
import { setHint } from '../hint'; // W790：运行态点提示走注册缝
import { activeSessionId, paneBusy } from '../viewctx';
import { grantShieldIcon } from './icons';
import { getActiveSession } from './store';
import { t } from '../../i18n';

/** 侧栏底部提示行（#sideFoot）。 */
export function note(text: string): void {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.textContent = text;
}

/** 激活高亮只切 class（不重建树，避免闪烁）；真源 = 当前聚焦容器。 */
export function updateActiveHighlight(container: HTMLElement): void {
  const act = activeSessionId() || getActiveSession();
  for (const n of container.querySelectorAll<HTMLElement>('.sess-leaf')) {
    n.classList.toggle('active', n.dataset.id === act);
  }
}

/** 运行态点：只切 class/文案，不重建行（铁律 6：轮询/事件只做局部更新）。 */
export function updateBusyDots(container: HTMLElement): void {
  for (const d of container.querySelectorAll<HTMLElement>('.sess-dot[data-dot]')) {
    const id = d.dataset.dot ?? '';
    const busy = paneBusy(id);
    d.classList.toggle('busy', busy);
    setHint(d, busy ? t('shell.tree.running') : t('shell.tree.idle'));
  }
  for (const row of container.querySelectorAll<HTMLElement>('.ws-worker-row')) {
    const id = row.dataset.id ?? '';
    const busy = paneBusy(id);
    row.classList.toggle('running', busy);
    const st = row.querySelector<HTMLElement>('.ws-worker-state');
    if (st === null) continue;
    // W1470b：上一代行的状态位是**注册表状态**，不是本页运行态。没有活实例的行永远
    // 不 busy，这里若照旧写 idle，就会在渲染后的第一次轮询里抹掉徽标要说明的那个事实
    // （真机 CDP 实测抓到的正是这一条：渲染正确、轮询后变回 Idle）。
    if (row.classList.contains('inherited')) continue;
    st.textContent = busy ? t('shell.tree.running') : t('shell.tree.idle');
    st.classList.toggle('busy', busy);
  }
}

/** W701：把某条会话的放宽标记画到已存在的节点上（只改 class/文本/显隐）。 */
export function paintGrantMark(node: HTMLElement, mark: GrantMark | null): void {
  if (!mark || mark.count <= 0) {
    node.classList.add('hidden');
    node.replaceChildren();
    node.title = '';
    return;
  }
  node.classList.remove('hidden');
  node.classList.toggle('danger', mark.danger);
  node.title = mark.danger
    ? t('shell.tree.grantDanger', { n: mark.count })
    : t('shell.tree.grantRelaxed', { n: mark.count });
  if (!node.firstChild) node.appendChild(grantShieldIcon());
}

/** W701：标记变化 → 只更新既有叶子的标记节点（不重建树）。 */
export function updateGrantMarks(container: HTMLElement): void {
  for (const node of container.querySelectorAll<HTMLElement>('.sess-leaf-grant[data-grant-mark]')) {
    const id = node.dataset.grantMark ?? '';
    paintGrantMark(node, grantMarkOf(id));
  }
}
