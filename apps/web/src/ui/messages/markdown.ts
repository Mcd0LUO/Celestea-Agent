// ============================================================================
// ui/messages/markdown.ts — markdown 渲染与消毒（W759 从 ui/messages.ts 拆出）
//   md()          一次性渲染路径（历史恢复 / 终态文本）→ 已消毒 HTML
//   htmlToNodes() 渲染产物 → 安全节点数组（渲染产物进 DOM 的**唯一**通道）
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { renderMarkdown } from '../../utils/markdown';
import { sanitizeHtml, sanitizeNodes } from '../../utils/sanitize';

// ---- markdown ---------------------------------------------------------------
/**
 * Render markdown to **sanitized** HTML（历史恢复/一次性渲染路径）。
 * W739：返回值已过 utils/sanitize 白名单消毒（模型输出属不可信输入），
 * 可直接写入 DOM；需要节点时同样先走 sanitizeNodes。
 */
export function md(text: string): string {
  return sanitizeHtml(renderMarkdown(text));
}

/**
 * markdown 渲染产物 → 安全节点数组（不挂载；供单次替换用）。
 * W739：HTML 一律经 utils/sanitize 白名单消毒后再进 DOM —— 本函数是渲染产物
 * 变成真实节点的**唯一**通道（模型正文 / 工具结果 / 会话历史都走它），
 * 解析在惰性文档里完成（脚本不执行、资源不加载）。
 */
export function htmlToNodes(html: string): Node[] {
  return sanitizeNodes(html);
}
