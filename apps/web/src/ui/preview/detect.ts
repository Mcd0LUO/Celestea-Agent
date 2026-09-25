// ============================================================================
// ui/preview/detect.ts — F2 文件侧边预览：**候选文件识别**（纯函数、零 DOM、零网络）。
// ----------------------------------------------------------------------------
// P0 只预览「会话内已经出现过的内容」：工具结果（read_file 的 .tool-out 全文）与
// 消息文本里被提到的文件路径。本模块只回答「这段话/这个工具调用里有哪些候选文件」，
// 不做任何读取（没有 GET /api/fs/read，P0 明确不做）。
//
// 收窄策略（避免误报）：
//   · 行内反引号 / markdown 链接里的 token 必须是「已知扩展名」且
//     「含路径分隔符 / 以 . 开头 / 属于文档类扩展名（md/json/png…）」；
//   · 裸词（无扩展名）一律不算；URL（http(s)/file 等 scheme）一律不算；
//   · 「文件：x」句式只认紧跟在冒号后的单 token（无空白/标点）。
// ============================================================================

// W1534：html/htm 从 CODE_EXT **拆出来**单独成 kind —— 它要的是「渲染预览 / 高亮源码」
// 双模式，而 code 只有源码一种看法。留在 CODE_EXT 里会让 .html 永远当代码看（旧行为）。
export type PreviewKind = 'code' | 'markdown' | 'image' | 'diff' | 'html' | 'unknown';
export type PreviewSource = 'tool' | 'link' | 'code-span' | 'label';

/** 一个候选文件（路径 + 类型 + 来源）。 */
export interface PreviewCandidate {
  path: string;
  kind: PreviewKind;
  source: PreviewSource;
}

const IMAGE_EXT: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const MARKDOWN_EXT: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx']);
const DIFF_EXT: ReadonlySet<string> = new Set(['diff', 'patch']);
/** HTML 家族：可渲染预览（W1534）。svg 仍归 IMAGE_EXT（图片查看器更合适）。 */
const HTML_EXT: ReadonlySet<string> = new Set(['html', 'htm']);
const CODE_EXT: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'less', 'xml', 'json', 'jsonl',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'tex', 'rst', 'csv', 'tsv', 'txt', 'text',
]);
/**
 * 无路径分隔符也放行的「文档/数据/图片」扩展名（裸文件名如 README.md / config.json）。
 *
 * W1543：把 HTML_EXT 也放进来 —— `index.html` 是最常见的裸 HTML 文件名，
 * 而本波的整个需求就是「打开一个 .html」。原先 html/htm 只出现在
 * classifyByPath/looksLikePath 的**扩展名**判定里，没进这张裸名表，于是
 * 「见 `index.html`」这种不带路径分隔符的提法识别不出来
 * （tests/w1543-html-kind.test.ts 抓到；修法与既有 `README.md` 的口径对齐）。
 */
const BARE_OK_EXT: ReadonlySet<string> = new Set([
  ...IMAGE_EXT, ...MARKDOWN_EXT, ...DIFF_EXT, ...HTML_EXT,
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'csv', 'tsv', 'txt', 'text',
]);
/** P0 内容工具：结果全文就是文件内容（按钮只给 read_file 类）。 */
export const PREVIEW_CONTENT_TOOLS: ReadonlySet<string> = new Set(['read_file']);
/** 参数里带 path 的工具（候选识别用）。 */
const FILE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'write_file', 'list_dir']);

/** 去掉 query/hash 后取小写扩展名（无扩展名 = ''）。 */
export function extOf(path: string): string {
  const clean = (path.split(/[?#]/)[0] ?? '').replace(/^.*[\\/]/, '');
  const i = clean.lastIndexOf('.');
  return i > 0 ? clean.slice(i + 1).toLowerCase() : '';
}

/** 按扩展名分类。 */
export function classifyByPath(path: string): PreviewKind {
  const ext = extOf(path);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (DIFF_EXT.has(ext)) return 'diff';
  if (HTML_EXT.has(ext)) return 'html';
  if (CODE_EXT.has(ext)) return 'code';
  return 'unknown';
}

/** 路径启发式：排除 URL/裸词，只认已知扩展名 +（分隔符 / 前导 . / 文档类扩展名）。 */
export function looksLikePath(raw: string): boolean {
  const t = raw.trim();
  if (t === '' || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (t.startsWith('#')) return false;
  const ext = extOf(t);
  if (!(IMAGE_EXT.has(ext) || MARKDOWN_EXT.has(ext) || DIFF_EXT.has(ext) || HTML_EXT.has(ext) || CODE_EXT.has(ext))) {
    return false;
  }
  if (t.includes('/') || t.includes('\\') || t.startsWith('.')) return true;
  return BARE_OK_EXT.has(ext);
}

function asRecord(args: unknown): Record<string, unknown> | null {
  if (typeof args === 'string') {
    const t = args.trim();
    if (!t.startsWith('{')) return null;
    try {
      return asRecord(JSON.parse(t));
    } catch {
      return null;
    }
  }
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  return null;
}

/** 从工具调用提取候选：工具在 FILE_TOOLS 且 args.path 是合法路径。 */
export function detectFromTool(name: string, args: unknown): PreviewCandidate | null {
  if (!FILE_TOOLS.has(name)) return null;
  const rec = asRecord(args);
  const path = rec && typeof rec['path'] === 'string' ? rec['path'].trim() : '';
  if (path === '' || !looksLikePath(path)) return null;
  return { path, kind: classifyByPath(path), source: 'tool' };
}

/** 从消息文本提取候选（markdown 链接 / 行内反引号路径 / 「文件：x」句式）。 */
export function detectFromText(text: string): PreviewCandidate[] {
  const out: PreviewCandidate[] = [];
  const push = (raw: string, source: PreviewSource): void => {
    const path = raw.trim();
    if (!looksLikePath(path)) return;
    out.push({ path, kind: classifyByPath(path), source });
  };
  for (const m of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) push(m[1] ?? '', 'link');
  for (const m of text.matchAll(/`([^`\n]+)`/g)) push(m[1] ?? '', 'code-span');
  for (const m of text.matchAll(/文件[：:]\s*([^\s，。；、）)\]】]+)/g)) push(m[1] ?? '', 'label');
  return out;
}

/** 去重（同一路径保留首个出现）。 */
export function dedupeCandidates(list: readonly PreviewCandidate[]): PreviewCandidate[] {
  const seen = new Set<string>();
  const out: PreviewCandidate[] = [];
  for (const c of list) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    out.push(c);
  }
  return out;
}
