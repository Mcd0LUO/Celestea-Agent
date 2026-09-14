// ============================================================================
// ui/grants/copy.ts — 授予流程面向用户的固定句式（W773 新建；纯函数，零 DOM/零网络）。
//
//   文案纪律（安全不变量，随代码一并搬来）：本模块所有面向用户的字符串都是
//   **固定常量**，绝不采用工具输出或模型文本中的任何字符串；范围值（路径/站点/
//   工具名）只作为**数据**填入固定句式。
//
//   为什么从 ./flow.ts 搬出来（W773）：
//     ① 「永久」措辞只能有一处实现 —— 到期短语统一取 caps.ts 的 untilPhrase /
//        expiryParen / PERMANENT_TEXT，任何一处都不会退化成时刻；
//     ② 确认文案是这一轮的核心产物（授予 = 永久 + 可随时撤销），因此必须能被
//        **机械断言**：tools/check-grants-permanent.mjs 在 node 里直接跑本模块。
// ============================================================================
import type { EffectiveGrants, GrantEntry, GrantScope } from '../../types';
import { PERMANENT_TEXT, listOf, untilPhrase, expiryParen, type CapDef } from './caps';
import { phraseFor } from './panel/phrase';

/** 计划中的一步（快捷授权）：范围 + 该步的到期时刻（null = 永久）。 */
export interface PlannedGrant {
  def: CapDef;
  scope: GrantScope;
  expiresAt: number | null;
}

/**
 * 二次确认正文（单项）：固定句式，范围值只作数据填入。
 * `expiresAt === null`（= 永久，W773 的默认路径）时显示「撤销前一直有效」，不出现时刻。
 */
export function confirmMessageFor(def: CapDef, scope: GrantScope, expiresAt: number | null): string {
  const until = untilPhrase(expiresAt);
  switch (def.cap) {
    case 'network':
      return (
        '允许本会话中运行的命令访问互联网与内网（包括本机运行的服务）。' +
        '此授权' +
        until +
        '。仅在你信任即将运行的命令时授予。'
      );
    case 'write_roots':
      return (
        '允许本会话在 ' +
        listOf(scope.roots).join('、') +
        ' 中创建与修改文件。该目录之外的写入仍然被拒绝。此授权' +
        until +
        '。'
      );
    case 'unsandboxed':
      return (
        '允许本会话中运行的命令绕过文件系统与网络的额外隔离。' +
        '恶意或被注入的命令可能读取或修改你的文件。此授权只能使用一次，' +
        until +
        '。'
      );
    case 'read_roots':
      return (
        '允许本会话读取 ' + listOf(scope.roots).join('、') + '（不能修改）。此授权' + until + '。'
      );
    case 'net_hosts':
      return '允许本会话访问 ' + listOf(scope.hosts).join('、') + '。此授权' + until + '。';
    case 'tool_extra':
      return '允许本会话使用 ' + listOf(scope.tools).join('、') + '。此授权' + until + '。';
  }
}

/** 快捷授权的确认正文：逐项后果（沿用单项句式）+ 一行到期说明。 */
export function presetConfirmMessage(presetLabel: string, planned: readonly PlannedGrant[]): string {
  const head = '本次快捷授权（' + presetLabel + '）会依次放宽 ' + planned.length + ' 项权限：';
  const body = planned.map(
    (p) => '· ' + p.def.label + '：' + confirmMessageFor(p.def, p.scope, p.expiresAt),
  );
  const tail = planned.every((p) => p.expiresAt === null)
    ? '到期时间：' + PERMANENT_TEXT + '。'
    : '到期时间：' +
      planned.map((p) => p.def.label + ' ' + untilPhrase(p.expiresAt)).join('；') +
      '。';
  return [head, ...body, tail].join('\n');
}

/** 授予后的效果预览（§3.4 的固定句式；范围值只作数据填入）。 */
export function previewForPending(def: CapDef, scope: GrantScope): string {
  return '授予后，本会话可以：' + phraseFor(def, scope) + '。除此之外的权限与现在相同。';
}

/** 授予成功后的状态行：永久 ⇒ 「永久（可随时撤销）」，不再出现时刻（W773）。 */
export function successText(
  def: CapDef,
  r: { effective?: EffectiveGrants; grant?: GrantEntry },
): string {
  return '已放宽：' + def.label + expiryParen(r.grant?.expires_at);
}
