// ============================================================================
// ui/commands/files.ts — H（@提及工作区文件）：**只传路径**的目录列举与补全源。
// ----------------------------------------------------------------------------
// 用户裁决（2026-09-19，必须遵守）：「@弹出的是工作区」+「@提及**不带文件内容，
//   **只传路径**」。因此本模块只做两件事：
//     1) 用 GET /api/fs/list?path= 列目录（目录 + 文件，冻结形状 {name,type,size,mtime}）；
//     2) 把选中的 **路径文本** 返回给补全框 —— **绝不读文件内容、绝不注入文件正文**。
//   输入框里最终只是 `@src/ui/send.ts` 这样的文本，随普通消息一起发出去。
// 逐级进入：`@src/` ⇒ 列 src 下的内容；前缀过滤由服务端返回后本地按已输入片段过滤。
// 降级：工作区无法解析 / 端点报错 / truncated ⇒ 返回可读 desc 或由调用方提示，不静默。
// ============================================================================
import { api } from '../../api';
import type { FsListEntry } from '../../types/fs-list';
import { activePane } from '../viewctx';
import { getWsList } from '../sessiontree/store';
import type { PopupItem } from './popup';
import { t } from '../../i18n';
import { joinPath } from '../fs-path'; // 平台路径（绝对路径拼接用工作区根自己的分隔符）

/** 目录列举结果（含降级原因）。 */
export interface DirListing {
  /** 当前绝对路径。 */
  path: string;
  items: PopupItem[];
  /** 非空 = 可读降级原因（端点/工作区/截断），调用方必须显示。 */
  notice: string;
}

/** 把 \ 统一成 /（仅用于展示；请求仍用原样绝对路径）。 */
function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 由会话的 workspace 名解析工作区绝对路径；解析不到返回 ''。 */
export function workspacePath(): string {
  const pane = activePane();
  const ws = (pane?.workspace ?? '').trim();
  if (ws === '') return '';
  // 后端偶尔直接给绝对路径（而非注册名）：原样采用，省一次注册表查询。
  if (ws.startsWith('/') || /^[A-Za-z]:[\\/]/.test(ws)) return ws;
  const row = getWsList().find((w) => w.name === ws);
  return row?.path ?? '';
}

/** 目录项的右侧提示：目录「目录」；文件大小。 */
function metaOf(e: FsListEntry): string {
  if (e.type === 'dir') return t('chat.mention.dir');
  if (e.size === null) return t('chat.mention.file');
  if (e.size < 1024) return e.size + ' B';
  if (e.size < 1024 * 1024) return (e.size / 1024).toFixed(1) + ' KB';
  return (e.size / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * 列举一行 `@` 之后的内容。
 * `after` = '@' 之后已输入的片段（可能含 '' 与已进入的目录前缀）。
 * 返回的 item.value = **可选中的路径文本**（绝对路径的展示形态；只传路径）。
 */
export async function listMentions(after: string): Promise<DirListing> {
  const root = workspacePath();
  if (root === '') {
    return { path: '', items: [], notice: t('chat.mention.noWorkspace') };
  }
  // 拆出「目录前缀」与「正在输入的末段」：末段用于前缀过滤。
  const raw = slash(after);
  const cut = raw.lastIndexOf('/');
  const dirPart = cut >= 0 ? raw.slice(0, cut + 1) : '';
  const leaf = cut >= 0 ? raw.slice(cut + 1) : raw;
  // 绝对路径按工作区根自身的平台分隔符逐段拼接（win32 下不再混出 'C:\\Users\\me/src'）。
  // 注意：item.value（插进输入框的**提及文本**）仍是工作区相对路径、沿用 '/' —— 那是提及的展示约定。
  let abs = root;
  for (const seg of dirPart.split('/').filter(Boolean)) abs = joinPath(abs, seg);
  let resp;
  try {
    resp = await api.fsList(abs);
  } catch (err) {
    return { path: abs, items: [], notice: t('chat.mention.unavailable') };
  }
  if (resp.error !== undefined && resp.error !== '') {
    return { path: abs, items: [], notice: t('chat.mention.openFailed', { reason: resp.error }) };
  }
  const entries = resp.entries ?? [];
  const prefix = leaf.toLowerCase();
  const filtered = prefix === '' ? entries : entries.filter((e) => e.name.toLowerCase().startsWith(prefix));
  const items: PopupItem[] = filtered.map((e) => {
    const rel = dirPart + e.name;
    const label = e.type === 'dir' ? rel + '/' : rel;
    return {
      label,
      desc: metaOf(e),
      isDir: e.type === 'dir',
      // 只传路径：value 就是要插入输入框的路径文本（目录带尾 '/' 以便继续进入）。
      value: label,
    };
  });
  const notice = resp.truncated === true ? t('chat.mention.truncated') : '';
  return { path: abs, items, notice };
}
