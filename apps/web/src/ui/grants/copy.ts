// ============================================================================
// ui/grants/copy.ts — 授予流程面向用户的固定句式（W773 新建；纯函数，零 DOM/零网络）。
//
//   文案纪律（安全不变量）：本模块所有面向用户的字符串都是**固定句式**，
//   绝不采用工具输出或模型文本中的任何字符串；范围值（路径/站点/工具名）只作为
//   **数据**填入固定句式。
//
//   i18n（Batch4）：句式走 t()，**永久措辞的唯一真源仍是 caps.ts 的
//   untilPhrase / expiryParen / permanentText()** —— 本模块不自己定义「永久」。
// ============================================================================
import type { EffectiveGrants, GrantEntry, GrantScope } from '../../types';
import { t } from '../../i18n';
import { expiryParen, listOf, permanentText, untilPhrase, type CapDef } from './caps';
import { phraseFor } from './panel/phrase';

/** 计划中的一步（快捷授权）：范围 + 该步的到期时刻（null = 永久）。 */
export interface PlannedGrant {
  def: CapDef;
  scope: GrantScope;
  expiresAt: number | null;
}

/** 范围值列表的分隔符（数据 join，不是句式）。 */
function sep(): string {
  return t('grants.copy.listSep');
}

/**
 * 二次确认正文（单项）：固定句式，范围值只作数据填入。
 * `expiresAt === null`（= 永久，W773 的默认路径）时显示「撤销前一直有效」，不出现时刻。
 */
export function confirmMessageFor(def: CapDef, scope: GrantScope, expiresAt: number | null): string {
  const until = untilPhrase(expiresAt);
  switch (def.cap) {
    case 'network':
      return t('grants.copy.network', { until });
    case 'write_roots':
      return t('grants.copy.writeRoots', { roots: listOf(scope.roots).join(sep()), until });
    case 'unsandboxed':
      return t('grants.copy.unsandboxed', { until });
    case 'read_roots':
      return t('grants.copy.readRoots', { roots: listOf(scope.roots).join(sep()), until });
    case 'net_hosts':
      return t('grants.copy.netHosts', { hosts: listOf(scope.hosts).join(sep()), until });
    case 'tool_extra':
      return t('grants.copy.toolExtra', { tools: listOf(scope.tools).join(sep()), until });
  }
}

/** 快捷授权的确认正文：逐项后果（沿用单项句式）+ 一行到期说明。 */
export function presetConfirmMessage(presetLabel: string, planned: readonly PlannedGrant[]): string {
  const head = t('grants.copy.presetHead', { label: presetLabel, n: planned.length });
  const body = planned.map((p) =>
    t('grants.copy.presetBody', { label: p.def.label, text: confirmMessageFor(p.def, p.scope, p.expiresAt) }),
  );
  const tail = planned.every((p) => p.expiresAt === null)
    ? t('grants.copy.presetTailPermanent', { permanent: permanentText() })
    : t('grants.copy.presetTailLimited', {
        list: planned.map((p) => p.def.label + ' ' + untilPhrase(p.expiresAt)).join(sep()),
      });
  return [head, ...body, tail].join('\n');
}

/** 授予后的效果预览（§3.4 的固定句式；范围值只作数据填入）。 */
export function previewForPending(def: CapDef, scope: GrantScope): string {
  return t('grants.copy.previewPrefix') + phraseFor(def, scope) + t('grants.copy.previewSuffix');
}

/** 授予成功后的状态行：永久 ⇒ 「永久（可随时撤销）」，不再出现时刻（W773）。 */
export function successText(
  def: CapDef,
  r: { effective?: EffectiveGrants; grant?: GrantEntry },
): string {
  return t('grants.copy.successPrefix') + def.label + expiryParen(r.grant?.expires_at);
}
