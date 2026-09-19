// ============================================================================
// ui/fs-path.ts — 文件系统路径的平台判定与拆分/拼接（**纯函数、零 DOM、零网络**）。
// ----------------------------------------------------------------------------
// 为什么需要它：目录选择器 / 文件管理器整段是 POSIX 假设（split('/')、根写死 '/'），
//   在 Windows（C:\Users\me\proj、\\server\share\dir）上面包屑会变成一整段 + 一个假 '/' 根。
// 判定口径（前端自己判断，**不动后端契约**）：
//   · /^[A-Za-z]:[\\/]/ 或 /^[A-Za-z]:$/  ⇒ Windows 盘符路径，分隔符 '\'，根 'C:\'；
//   · /^\\\\/                             ⇒ UNC 路径，根 '\\server\share\'；
//   · 其余                                ⇒ POSIX，分隔符 '/'，根 '/'。
// **注意**：会话/工作区逻辑 id 里的 '/'（<workspace>/<session>）是协议分隔符，不是文件系统
//   路径，绝不能用本模块处理；URL 路径同理（URL 用 '/' 永远是对的）。
// ============================================================================

/** 是否 Windows 风格文件系统路径（盘符 C:\ / C:/ 或 UNC \\server）。 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(path) || /^\\\\/.test(path);
}

/** 该路径应使用的分隔符（Windows 风格 ⇒ '\'，否则 '/'）。 */
export function sepOf(path: string): string {
  return isWindowsPath(path) ? '\\' : '/';
}

/**
 * 真实根：POSIX ⇒ '/'；盘符 ⇒ 'C:\'；UNC ⇒ '\\server\share\'（取前两段）。
 * 面包屑的根按钮标签与点击目标都用它（不再写死 '/'）。
 */
export function rootOfPath(path: string): string {
  const drive = /^([A-Za-z]:)[\\/]?/.exec(path);
  if (drive) return drive[1] + '\\';
  const unc = /^(\\\\[^\\/]+[\\/][^\\/]+)[\\/]?/.exec(path);
  if (unc) return unc[1] + '\\';
  return '/';
}

/**
 * 按平台分隔符切分，**去掉根与空段**：返回根之后的路径段。
 *   'C:\Users\me\proj' → ['Users','me','proj']；'C:\' → []；
 *   '\\server\share\dir' → ['dir']；'/a/b' → ['a','b']；'/' → []。
 */
export function splitPath(path: string): string[] {
  const root = rootOfPath(path);
  let rest = path;
  if (root !== '/') {
    rest = path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path;
  } else {
    rest = path.replace(/^\/+/, '');
  }
  return rest.split(/[\\/]+/).filter((s) => s !== '');
}

/** 用 base 的分隔符拼接一段：joinPath('C:\Users','me') ⇒ 'C:\Users\me'；joinPath('/a','b') ⇒ '/a/b'。 */
export function joinPath(base: string, seg: string): string {
  if (base === '') return seg;
  const sep = sepOf(base);
  return base.replace(/[\\/]+$/, '') + sep + seg;
}

/** 父目录（根之上仍是根）：'/a/b' ⇒ '/a'；'C:\a\b' ⇒ 'C:\a'；'C:\' ⇒ 'C:\'。 */
export function parentOfPath(path: string): string {
  const root = rootOfPath(path);
  const parts = splitPath(path);
  if (parts.length === 0) return root;
  let acc = root;
  for (let i = 0; i < parts.length - 1; i++) acc = joinPath(acc, parts[i]!);
  return acc;
}
