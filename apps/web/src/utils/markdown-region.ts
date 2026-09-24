// ============================================================================
// utils/markdown-region.ts — 流式 markdown 的**边界判定**（W1485 从 utils/markdown.ts 拆出）
// ----------------------------------------------------------------------------
// 这里回答一个问题：把「累积全文」切在哪个位置，与「整段一次解析」逐字节等价？
// 判定必须保守：宁可少固化（退化为全量重渲染），也绝不固化错。
//
//   1) 只在「空行边界」后固化完整区域（围栏内/HTML 容器块内的空行不算边界）；
//   2) 区域内未闭合围栏、未闭合 HTML 容器（pre/script/style/textarea/注释）
//      不固化；
//   3) 区域内行内标记未闭合（** / 反引号 / ~~ / 方括号）不固化；
//   4) 引用式链接（[x] / [x][y]）的解析依赖「全文任意位置」的引用定义行，
//      而定义常出现在文末：只要全文（围栏/缩进代码之外）存在定义行，含用法
//      的区域一律不固化；定义尚未出现时允许临时固化并记录 refFrozen，定义
//      一旦出现即整体重渲染一次（见 MarkdownStream.update）；
//   5) 区域末行含竖线且后一行也含竖线（可能组成表格）时不固化；
//   6) 区域含列表项且后一行是列表项/列表残行（1、1.、-）时不固化
//      （会被合并成同一个列表，松散化 → <p> 包裹）；
//   7) 后一行以缩进开头（列表/引用/缩进代码可跨空行续接）、或区域末尾之后
//      没有非空行时不固化。
//   边界不安全时**不立即停止**，而是把后续块并入候选区域继续找下一个边界
//   ——避免「一个表格/一次未闭合行内标记把后续全部文本永久留在 tail 里」。
//
// ★ 引用定义/用法判定必须**围栏与缩进代码感知**（W301 复审修复）：
//   代码块里一行 `[info]: xxx`（日志、YAML、`[INFO]:` 等）在纯文本正则下
//   会被误判为「引用定义行」。后果有两个，实测都能把卡死放回来：
//     - 误判为定义 → boundarySafe 永久拒绝固化含 `[x]` 用法的区域
//       → stableLen 恒为 0，每个节拍全量重解析（48K 文本实测 7726ms）；
//     - 误判为用法 → refFrozen 被置位，而同一行又命中「定义」检测
//       → 每节拍 reset() 一次（reset 风暴，实测 resets=1610）。
//   因此这里统一用「围栏感知扫描」判定：REF_DEF_LINE_RE / REF_USE_RE 只在
//   非围栏、非缩进代码行上生效——全文检测走 hasFenceAwareDef()，块检测走
//   blockHasRefUse()，逐行统计走 feedLine()（三者口径一致）。
//
// ★ W1485（本次修复）：`findFixLen` 的 force 档。
//   症状：一个**未闭合的代码围栏**会让 boundarySafe 永远返回 false（snap.inFence），
//   于是边界停在原地、stableLen 恒为 5，每个节拍都全量重解析 —— 106K 文本实测
//   6622ms / 4000 tick（正常段落同规模 3430ms 且 stableLen 已到 105887）。
//   后台标签页把上千次小 tick 攒成一次巨型 parse 时，这一次 parse 就是「切回即卡死」。
//   修法见 fixLen() 的 force 注释（只固化到最后一个空行，且该处必须与全文口径
//   一致：围栏**外**、无裸 HTML、无数学、行内标记成对）。
// ============================================================================
import { lineAt } from './markdown-lines';
import { cloneRegion, feedLine, newRegion, type RegionState } from './markdown-region-state';
import {
  CODE_LINE_RE, FENCE_LINE_RE, FENCE_OPEN_RE, INDENT_RE, LISTISH_RE, LIST_RE,
  REF_DEF_LINE_RE, REF_USE_RE, SETEXT_RE,
} from './markdown-scan';

// ---- 围栏感知的整段检测（引用定义 / 引用用法） ----------------------------------

/**
 * 围栏与缩进代码感知的行遍历：对每个「普通行」（非围栏内容、非缩进代码）
 * 调用 visit(line)。与 feedLine 的过滤口径一致。
 */
function scanPlainLines(text: string, visit: (line: string) => void): void {
  let i = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  while (i < text.length) {
    const { line, next } = lineAt(text, i);
    if (!inFence) {
      const fm = FENCE_OPEN_RE.exec(line);
      if (fm) {
        const marker = fm[1] ?? '';
        inFence = true;
        fenceChar = marker.charAt(0);
        fenceLen = marker.length;
        i = next;
        continue;
      }
    } else {
      const cm = FENCE_LINE_RE.exec(line);
      const marker = cm?.[1] ?? '';
      if (marker !== '' && marker.charAt(0) === fenceChar && marker.length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      i = next;
      continue;
    }
    if (line.trim() !== '' && !CODE_LINE_RE.test(line)) visit(line);
    i = next;
  }
}

/**
 * 全文（围栏/缩进代码之外）是否出现引用定义行。
 * 定义可以出现在用法之后的任意位置，因此边界判定必须用**全文**结果，
 * 否则「用法块先固化、定义后到」会产出与整段解析不一致的 HTML。
 */
export function hasFenceAwareDef(text: string): boolean {
  let found = false;
  scanPlainLines(text, (line) => {
    if (!found && REF_DEF_LINE_RE.test(line)) found = true;
  });
  return found;
}

/** 某段文本（围栏/缩进代码之外）是否出现引用式链接用法。 */
export function blockHasRefUse(block: string): boolean {
  let found = false;
  scanPlainLines(block, (line) => {
    if (!found && REF_USE_RE.test(line)) found = true;
  });
  return found;
}

// ---- 边界安全判定 --------------------------------------------------------------

/**
 * 候选区域 [stable, boundary) 是否可在 boundary 处固化（nextLine = 边界之后
 * 第一条非空行；hasDef = 全文（围栏/缩进代码之外）存在引用定义行）。
 */
export function boundarySafe(snap: RegionState, nextLine: string, hasDef: boolean): boolean {
  if (snap.inFence) return false;                              // 未闭合围栏
  if (snap.hasRawHtml) return false;                           // 区域含裸 HTML（保守：不固化）
  if (snap.refUse && hasDef) return false;                     // 用法会被文末定义解析成链接
  if (snap.hasDollar) return false;                            // 数学可能跨边界（W846）
  if (snap.ticks % 2 !== 0) return false;                      // 未闭合 反引号
  if (snap.strong % 2 !== 0) return false;                     // 未闭合 **
  if (snap.strike % 2 !== 0) return false;                     // 未闭合 ~~
  if (snap.openBrackets !== snap.closeBrackets) return false;  // 未闭合 [
  const last = snap.lastLine;
  // 表格：末行含竖线且后一行也含竖线（可能是表头 + 分隔行/数据行）
  if (last !== null && last.indexOf('|') !== -1 && nextLine.indexOf('|') !== -1) return false;
  // 列表合并：区域内有列表项且后一行是列表项/列表残行
  if (snap.hasList && (LIST_RE.test(nextLine) || LISTISH_RE.test(nextLine))) return false;
  // 续接：后一行以缩进开头（列表/引用/缩进代码）、或为 setext 下划线
  if (INDENT_RE.test(nextLine)) return false;
  if (SETEXT_RE.test(nextLine)) return false;
  return true;
}

/**
 * 在 tail 中寻找可安全固化的前缀长度（0 = 不前进，退化为全量行为）。
 *
 * ★ W1485 的结论（为什么这里**没有**「强制切点」兜底）：
 *   本轮的起点假设是「未闭合围栏让 stableLen 停在原地，因此要给它一个上限、
 *   超限就把围栏之外的已确定部分强制固化」。实测把这个假设证伪了：
 *     · 「围栏之外的已确定部分」**总是**已经被 findFixLen 固化了 —— 它不是
 *       因为围栏才停住的，而是围栏本身就在尾部（围栏之前的内容早已固化）。
 *       探针实测（markdown-region.ts 的 forcedCut 试验版）：5 组含未闭合围栏的
 *       输入上 forcedCut 的返回值与 findFixLen **逐例相同**（8/8、0/0、6/6、
 *       0/0、22/22），一次都没有超过；
 *     · 真正无法固化的是「整段都在未闭合围栏里」（模型连续吐几百 KB 代码）。
 *       那种尾部**不存在**任何与整段解析等价的切点，任何强制固化都是错的；
 *     · 所以尾部上限的正确落点不是「更聪明的切分」，而是**调用方的渲染上限**
 *       （ui/messages/oversize.ts 的 MESSAGE_RENDER_LIMIT）——把尾部长度本身
 *       钳在有限值上，每 tick 的代价就有界（实测 64K 尾部 2.1ms/tick）。
 *   故本文件只保留 W301 的保守判定，一行都没有为「强制」放宽。
 *
 * hasDef 由调用方传入（全文围栏感知检测结果）——定义可能在候选边界之后，
 * 只看已扫描范围会漏判。
 */
export function fixLen(tail: string, hasDef: boolean): number {
  return findFixLen(tail, hasDef);
}

/** 单次 O(n) 前向扫描的安全切点（W301 原实现，语义未变）。 */
export function findFixLen(tail: string, hasDef: boolean): number {
  let stable = 0;              // 已确认可固化的长度
  let st = newRegion();        // 当前区域 [stable, 扫描位置)
  let pending = -1;            // 挂起的候选边界（区域结束位置）
  let snap: RegionState | null = null;
  let i = 0;
  while (i < tail.length) {
    const { line, next, eol } = lineAt(tail, i);
    // 只把「真正空行」（长度为 0）当边界：只含空白的行可被 marked 的
    // setext 标题规则跨行吞并（`(?:.|\n(?!\n))+?` 允许 ` \n`），
    // 若在空白行处固化会与整段解析结果不一致。
    const blank = eol && line === '';
    if (!blank && line.trim() !== '') {
      // 非空行：先判定挂起候选（该行属于下一个区域，故先判定再计入）
      if (pending >= 0 && snap !== null) {
        if (boundarySafe(snap, line, hasDef)) {
          stable = pending;
          st = newRegion();
        }
        pending = -1;
        snap = null;
      }
    }
    feedLine(st, line);
    if (!st.inFence && blank) {
      if (!st.hasContent) {
        // 连续空行：直接并入已固化区（无内容可解析）
        stable = next;
        st = newRegion();
        pending = -1;
        snap = null;
      } else {
        pending = next;
        snap = cloneRegion(st);
      }
    }
    i = next;
  }
  return stable;
}
