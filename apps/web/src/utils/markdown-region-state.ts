// ============================================================================
// utils/markdown-region-state.ts — 候选区域的**行内结构统计**（W1485 从
// utils/markdown.ts 拆出，纯搬家）。
//
// 为什么单独成模块：这些统计是「边界是否安全」判定的输入，且必须**增量累加**
// （每 tick 只扫新到的行，不重扫旧行）；把它们与边界判定分开，判定逻辑才能
// 保持在模块体积棘轮之内，也便于直接断言。
//
// 口径要点（与 marked 逐条对齐，改了就会产生「与整段一次解析不一致」的 HTML）：
//   · 围栏开行只切围栏状态，不参与行内标记统计，也不作为表格候选行；
//   · 围栏内容行是字面量，全部跳过，只等与开行**同字符且不短于开行**的闭行；
//   · 缩进代码行里的标记是字面量（不参与行内配对、不算引用定义/用法）；
//   · 主题分隔线（*** / --- / ___）是分隔线，不是未闭合强调。
// ============================================================================
import {
  CODE_LINE_RE, FENCE_LINE_RE, FENCE_OPEN_RE, LIST_ANY_RE,
  RAW_HTML_RE, REF_USE_RE, THEMATIC_RE,
} from './markdown-scan';

/** 区域 [stable, 候选边界) 的结构统计，用于判定该切分点是否与整段解析等价。 */
export interface RegionState {
  inFence: boolean;        // 是否位于未闭合围栏内
  fenceChar: string;       // 围栏字符（反引号 或 ~）
  fenceLen: number;        // 围栏长度
  ticks: number;           // 行内代码标记（反引号串）计数
  strong: number;          // ** 计数
  strike: number;          // ~~ 计数
  openBrackets: number;    // [ 计数
  closeBrackets: number;   // ] 计数
  refUse: boolean;         // 出现引用式链接用法（围栏/缩进代码之外）
  hasDollar: boolean;      // 出现未转义 $ —— 保守：不固化（数学可能跨边界）
  hasList: boolean;        // 出现列表项（含嵌套）
  hasRawHtml: boolean;     // 区域内出现裸 HTML 标签/构造（保守：不固化）
  lastLine: string | null; // 最后一个非空行（含缩进行）
  hasContent: boolean;     // 区域内是否有非空内容
}

/** 空白区域状态。 */
export function newRegion(): RegionState {
  return {
    inFence: false,
    fenceChar: '',
    fenceLen: 0,
    ticks: 0,
    strong: 0,
    strike: 0,
    openBrackets: 0,
    closeBrackets: 0,
    refUse: false,
    hasDollar: false,
    hasList: false,
    hasRawHtml: false,
    lastLine: null,
    hasContent: false,
  };
}

/** 快照（候选边界处挂起的状态必须与后续增长解耦）。 */
export function cloneRegion(st: RegionState): RegionState {
  return { ...st };
}

/** 把一行计入区域状态（围栏行只切围栏状态，不参与行内标记统计）。 */
export function feedLine(st: RegionState, line: string): void {
  if (!st.inFence) {
    const fm = FENCE_OPEN_RE.exec(line);
    if (fm) {
      const marker = fm[1] ?? '';
      st.inFence = true;
      st.fenceChar = marker.charAt(0);
      st.fenceLen = marker.length;
      if (line.trim() !== '') st.hasContent = true;
      return; // 围栏开行不参与行内统计，也不作为表格候选行
    }
  } else {
    // 围栏内容行：字面量，全部跳过；只等与开行同字符且不短于开行的闭行
    const cm = FENCE_LINE_RE.exec(line);
    const marker = cm?.[1] ?? '';
    if (marker !== '' && marker.charAt(0) === st.fenceChar && marker.length >= st.fenceLen) {
      st.inFence = false;
      st.fenceChar = '';
      st.fenceLen = 0;
    }
    if (line.trim() !== '') st.hasContent = true;
    return;
  }
  if (line.trim() === '') return;
  st.hasContent = true;
  st.lastLine = line;
  // 缩进代码：其中的标记是字面量，不参与行内配对，也不算引用定义/用法
  if (CODE_LINE_RE.test(line)) return;
  // 主题分隔线：*** / --- 是分隔线而非未闭合强调
  if (THEMATIC_RE.test(line)) return;
  if (RAW_HTML_RE.test(line)) st.hasRawHtml = true;
  const ticks = line.match(/`+/g);
  if (ticks) st.ticks += ticks.length;
  const strong = line.match(/\*\*/g);
  if (strong) st.strong += strong.length;
  const strike = line.match(/~~/g);
  if (strike) st.strike += strike.length;
  const open = line.match(/\[/g);
  if (open) st.openBrackets += open.length;
  const close = line.match(/\]/g);
  if (close) st.closeBrackets += close.length;
  if (REF_USE_RE.test(line)) st.refUse = true;
  // W846：含未转义 $ 的区域一律不固化 —— 块数学可跨空行边界，固化半个数学会
  // 与「整段一次解析」不一致；保守退化到全量重渲染（正确性优先于增量）。
  if (/(^|[^\\])\$/.test(line)) st.hasDollar = true;
  if (LIST_ANY_RE.test(line)) st.hasList = true;
}
