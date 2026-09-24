// ============================================================================
// utils/markdown-lines.ts — 流式 markdown 的**行切分**（W1485 从 utils/markdown.ts 拆出）
//
// 为什么单独成模块：行切分是「边界判定」（markdown-region.ts）与「标题 id 计算」
// （markdown-heading-id.ts）共用的最小原语，而 utils/markdown.ts 受模块体积棘轮
// 约束（例外表上限 509 行，只许降不许升）—— 新逻辑只能开新文件。
// 本模块是纯搬家：CRLF / CR / LF 归一化口径与拆分前逐字一致。
// ============================================================================

/** 一行的切分结果：line = 不含行尾符的内容，next = 下一行起点，eol = 本行有行尾符。 */
export interface LineSlice {
  line: string;
  next: number;
  eol: boolean;
}

/**
 * 取 i 处的行内容与下一行起点。CRLF / CR / LF 均视为换行——marked 的 Lexer
 * 会先把 `\r\n|\r` 归一化为 `\n`，若这里只按 `\n` 切行，含 `\r` 的文本会
 * 与 marked 看到的分块结构不一致（可能把围栏行误判为普通行）。
 */
export function lineAt(text: string, i: number): LineSlice {
  let j = i;
  while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j += 1;
  if (j >= text.length) return { line: text.slice(i), next: text.length, eol: false };
  let next = j + 1;
  if (text[j] === '\r' && text[next] === '\n') next += 1;
  return { line: text.slice(i, j), next, eol: true };
}
