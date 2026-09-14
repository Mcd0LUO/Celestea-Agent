// ============================================================================
// ui/grants/panel/phrase.ts — 能力 → 用户语言的固定句式（W760 拆出）。
//
//   纯函数（零 DOM）：结果预览（previewText）与逐项明细的短语（phraseFor）。
//   flow.ts 的二次确认文案也直接用这里的 phraseFor，所以它经 ../panel.ts 原样再导出。
//   W760 只搬家：句式、join 分隔符逐字未改；W773 把 TTL 取值（maxTtlOf / ttlOf）
//   移到 ../request.ts —— 与授予请求体同层，便于机械断言「默认永久」。
// ============================================================================
import type { GrantScope } from '../../../types';
import { CAPS, listOf, scopeOf, type CapDef } from '../caps';
import { activeFor, activeGrants } from './active';

/** 当前生效集 → 一句话预览（固定常量句式，范围值只作数据填入）。 */
export function previewText(): string {
  const active = activeGrants();
  if (!active.length) return '本会话现在只能读写工作区目录，不能访问网络。';
  const parts: string[] = [];
  for (const def of CAPS) {
    const g = activeFor(def.cap);
    if (!g) continue;
    parts.push(phraseFor(def, scopeOf(g)));
  }
  if (!parts.length) return '本会话现在只能读写工作区目录，不能访问网络。';
  return '本会话现在可以：' + parts.join('；') + '。除此之外的权限与现在相同。';
}

/** 单项能力的「可以做什么」短语（固定句式 + 范围数据）。 */
export function phraseFor(def: CapDef, scope: GrantScope): string {
  switch (def.cap) {
    case 'network':
      return '访问互联网与内网';
    case 'write_roots':
      return '在 ' + listOf(scope.roots).join('、') + ' 中创建与修改文件';
    case 'read_roots':
      return '读取 ' + listOf(scope.roots).join('、') + ' 中的文件';
    case 'net_hosts':
      return '访问 ' + listOf(scope.hosts).join('、');
    case 'tool_extra':
      return '使用额外工具 ' + listOf(scope.tools).join('、');
    case 'unsandboxed':
      return '不经额外隔离运行命令';
  }
}

