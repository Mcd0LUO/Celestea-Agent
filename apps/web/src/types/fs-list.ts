// ============================================================================
// types/fs-list.ts — H（@提及工作区文件）：GET /api/fs/list?path= 的线格式。
//   冻结形状（contracts/endpoints.json 的 get_fs_list，docs/archive/decisions/iteration-g-workbench.md §0.1）：
//   entries: {name,type,size,mtime}；type: 'dir' | 'file'（符号链接不跟随）；
//   mtime: ISO-8601 或 null；truncated: 目录项被 MAX_DIR_ENTRIES 截断。
// ============================================================================

/** 一条目录项（冻结形状）。 */
export interface FsListEntry {
  name: string;
  type: 'dir' | 'file';
  /** 文件字节数；目录为 null。 */
  size: number | null;
  /** ISO-8601；读不到为 null。 */
  mtime: string | null;
}

/** GET /api/fs/list?path= 响应。 */
export interface FsListResp {
  path?: string;
  parent?: string | null;
  entries?: FsListEntry[];
  roots?: readonly string[];
  /** true = 目录项超过上限被截断（调用方必须如实提示）。 */
  truncated?: boolean;
  error?: string;
}
