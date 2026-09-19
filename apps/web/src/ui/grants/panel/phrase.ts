// ============================================================================
// ui/grants/panel/phrase.ts — 能力 → 用户语言的固定句式（W760 拆出）。
//
//   纯函数（零 DOM）：结果预览（previewText）与逐项明细的短语（phraseFor）。
//   flow.ts 的二次确认文案也直接用这里的 phraseFor，所以它经 ../panel.ts 原样再导出。
//   W760 只搬家：句式、join 分隔符逐字未改；W773 把 TTL 取值（maxTtlOf / ttlOf）
//   移到 ../request.ts —— 与授予请求体同层，便于机械断言「默认永久」。
// ============================================================================
import type { GrantScope } from '../../../types';
import { caps, listOf, scopeOf, type CapDef } from '../caps';
import { t } from '../../../i18n';
import { activeFor, activeGrants } from './active';

/** 当前生效集 → 一句话预览（固定常量句式，范围值只作数据填入）。 */
export function previewText(): string {
  const active = activeGrants();
  if (!active.length) return t('grants.phrase.default');
  const parts: string[] = [];
  for (const def of caps()) {
    const g = activeFor(def.cap);
    if (!g) continue;
    parts.push(phraseFor(def, scopeOf(g)));
  }
  if (!parts.length) return t('grants.phrase.default');
  return t('grants.phrase.canNow') + parts.join(t('grants.copy.listSep')) + t('grants.phrase.suffix');
}

/** 单项能力的「可以做什么」短语（固定句式 + 范围数据）。 */
export function phraseFor(def: CapDef, scope: GrantScope): string {
  switch (def.cap) {
    case 'network':
      return t('grants.phrase.network');
    case 'write_roots':
      return t('grants.phrase.writeRoots', { roots: listOf(scope.roots).join(t('grants.copy.listSep')) });
    case 'read_roots':
      return t('grants.phrase.readRoots', { roots: listOf(scope.roots).join(t('grants.copy.listSep')) });
    case 'net_hosts':
      return t('grants.phrase.netHosts', { hosts: listOf(scope.hosts).join(t('grants.copy.listSep')) });
    case 'tool_extra':
      return t('grants.phrase.toolExtra', { tools: listOf(scope.tools).join(t('grants.copy.listSep')) });
    case 'unsandboxed':
      return t('grants.phrase.unsandboxed');
  }
}

