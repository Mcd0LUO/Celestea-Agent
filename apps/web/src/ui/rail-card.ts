// ============================================================================
// ui/rail-card.ts — 灵动选择条的**预览卡内容**（W872 从 rail.ts 纯搬家）
// ----------------------------------------------------------------------------
// W790 起「悬停弹预览」是注册进 ui/hint 注册缝的一个提供者（id 'rail-preview'，
// 见 ui/rail.ts 的 railHintPlugin）：本模块只负责「取内容」——该轮消息列的首行前 40
// 字（数据全部取自已渲染消息 DOM，零请求）。
// 注册/认领/落位仍留在 ui/rail.ts（它才知道条目表、fisheye 与轨道几何；落位算式
// 的唯一真源是 ./rail-geom.ts 的 railCardPlacement，W871）。
//
// 为什么搬家（W872）：本轮要在 rail.ts 里加「中间判定（视口中间指示）」的接线，而
// rail.ts 受模块体积棘轮约束（tools/module-size-baseline.json 登记上限只许降不许升）。
// 把与中间判定无关的这一整段（取内容算式逐字未改）挪出来，新能力才有地方放。
// ============================================================================
import { el } from '../utils/dom';

/** 预览首行截断长度（W238 起未变）。 */
const PREVIEW_CHARS = 40;

/** 预览卡需要知道的条目字段（ui/rail.ts 的 RailItem 是它的超集）。 */
export interface RailCardItem {
  /** 轮起点（user 消息；孤立 assistant 为其自身）。 */
  startCol: HTMLElement;
  /** 该轮全部消息列（user + assistant 段）。 */
  cols: HTMLElement[];
  /** 该轮是否已有 assistant 回复。 */
  hasReply: boolean;
  /** >0 = 折叠条（表示更早 N 轮已折叠）。 */
  fold: number;
}

/** 消息内容首行前 N 字（压平空白、取第一个非空行）。 */
function firstLine(col: HTMLElement): string {
  const c = col.querySelector('.content');
  const raw = (c?.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
  if (!raw) return '';
  const line =
    raw
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
  return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) + '…' : line;
}

/** 该轮第一条 assistant 回复的内容首行（轮内查找，不跨轮）。 */
function replyLine(it: RailCardItem): string {
  for (const col of it.cols) {
    if (col.querySelector('.msg.assistant')) return firstLine(col);
  }
  return '';
}

/** 造预览卡（折叠条只说折叠了几轮；普通条给 Q/A 两行）。 */
export function buildRailCard(it: RailCardItem): HTMLElement {
  const card = el('div', 'railv3-card');
  if (it.fold > 0) {
    const ql = el('div', 'railv3-card-q');
    ql.appendChild(el('span', 'railv3-card-tag', '⋯'));
    ql.appendChild(el('span', null, '更早的 ' + it.fold + ' 轮已折叠'));
    card.appendChild(ql);
  } else {
    const q = firstLine(it.startCol);
    if (q) {
      const ql = el('div', 'railv3-card-q');
      ql.appendChild(el('span', 'railv3-card-tag', 'Q'));
      ql.appendChild(el('span', null, q));
      card.appendChild(ql);
    }
    if (it.hasReply) {
      const a = replyLine(it);
      if (a) {
        card.appendChild(el('div', 'railv3-card-sep'));
        const al = el('div', 'railv3-card-a');
        al.appendChild(el('span', 'railv3-card-tag', 'A'));
        al.appendChild(el('span', null, a));
        card.appendChild(al);
      }
    } else {
      card.appendChild(el('div', 'railv3-card-sep'));
      const al = el('div', 'railv3-card-a railv3-card-noa');
      al.appendChild(el('span', 'railv3-card-tag', 'A'));
      al.appendChild(el('span', null, '（无回复）'));
      card.appendChild(al);
    }
  }
  return card;
}
