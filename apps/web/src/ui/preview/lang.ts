// ============================================================================
// ui/preview/lang.ts — W1545：扩展名 → highlight.js 语言名（**唯一一份**）。
// ----------------------------------------------------------------------------
// 为什么单独成文件：流式打开要给**每一个分段块**声明同一个语言 class
// （renderers.ts 的 codeNode 与 panel.ts 的 newCodeBlock 都要它）。原来这张表
// 长在 renderers.ts 里，panel.ts 再抄一份就是第二份真源 —— 两处漂移时会出现
// 「整篇预览高亮、分段预览不高亮」这种只在巨文件上复现的怪相。
// ============================================================================

/** 扩展名 → highlight.js 已注册语言（未登记的语言不声明 class ⇒ 渲染为纯文本）。 */
export const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', go: 'go', java: 'java', c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', html: 'xml', htm: 'xml', xml: 'xml',
  css: 'css', scss: 'css', less: 'css', yaml: 'yaml', yml: 'yaml',
};
