// ============================================================================
// ui/batchresult.ts — 批量端点响应（`BatchOpResp`）的**失败呈现**（W792）。
//   背景（实测 http://127.0.0.1:3777，2026-09-16）：批量删除/归档**部分失败也返回
//   200 + `{ok:true}`**，失败项只在 `failed[{id,error}]` 里。调用方若只 catch HTTP
//   异常就会把失败当成功、静默吞掉 —— 本模块把那一份响应翻成一句用户能看懂的话。
//
//   纪律：
//     · 面向用户的文案只出现**会话 id 末段**（我们自己的标识符）+ 条数；
//       服务端 `error` 原文（英文技术串）只写 console，绝不进 UI 文案；
//     · 纯函数、零 DOM、零网络 ⇒ 可在 node（vitest）里直接跑真实生产代码。
// ============================================================================
import type { BatchFailedItem, BatchOpResp } from '../types';
import { t } from '../i18n';

/** 最多列几个失败项（更多只报数，避免把提示行刷爆）。 */
const MAX_LISTED = 3;

/**
 * 服务端失败原因（英文原文，`failed[].error`）→ **可行动的**中文文案。
 *   只映射**已实测确认**的模式（生产实测，见报告「验证」）：
 *     · `unknown session 'x'`    —— 该会话已经不在了；
 *     · `unknown workspace 'x'`  —— 该行所属工作区已不存在。
 *   未识别的原文一律落回空串（调用方用通用句 + id 末段），**绝不把英文原文透传给用户**
 *   （api.ts 文案纪律：服务端原文只进 console）。
 *   注：**不**为 `active session` 之类做特例 —— 活动与否只是状态标记，不该成为
 *   「换个会话再来」的理由（用户裁决，W794 起后端允许直接删除活动会话）。
 */
export function failureReasonText(err: unknown): string {
  const e = typeof err === 'string' ? err.toLowerCase() : '';
  if (e === '') return '';
  if (e.includes('unknown workspace')) return t('settings.batch.reasonUnknownWorkspace');
  if (e.includes('unknown session')) return t('settings.batch.reasonUnknownSession');
  return '';
}

/** 会话 id 末段（`ws/name` → `name`）；空/缺失回退 `(未知)`。 */
export function failedTail(it: BatchFailedItem): string {
  const raw = (it.id ?? '').trim();
  if (raw === '') return t('settings.batch.unknownTail');
  const i = raw.lastIndexOf('/');
  return i >= 0 ? raw.slice(i + 1) : raw;
}

/**
 * 批量响应 → 失败提示行；**无失败（含 legacy 服务缺省 failed）返回空串**。
 *   · 单项失败 → 先给**可理解的原因**（`删除失败：该会话已不存在（可能已被删除）`），
 *     原因无法识别时退回 `删除失败：<id 末段>`（**不**为 `active session` 之类编特例文案：
 *     活动与否只是状态标记，见下面 failureReasonText 的说明）；
 *   · 多项失败 → `删除失败 2 个：a、b（已成功 1 个）`（成功条数来自响应，不臆造）。
 */
export function batchFailureText(verb: string, resp: BatchOpResp | null | undefined): string {
  const failed = Array.isArray(resp?.failed) ? resp.failed : [];
  if (failed.length === 0) return '';
  for (const f of failed) {
    if (typeof f?.error === 'string' && f.error !== '') {
      console.warn('[batch] ' + verb + '失败 ' + (f.id ?? '') + '：' + f.error);
    }
  }
  const done = typeof resp?.deleted === 'number' ? resp.deleted : resp?.archived;
  const rest = typeof done === 'number' && done > 0 ? t('settings.batch.rest', { n: done }) : '';
  const reason = failureReasonText(failed[0]?.error);
  if (failed.length === 1) {
    return t('settings.batch.failedOne', { verb, reason: reason !== '' ? reason : failedTail(failed[0] as BatchFailedItem), rest });
  }
  const tails = failed.map(failedTail);
  const shown = tails.slice(0, MAX_LISTED).join(t('settings.batch.listSep'));
  const more = tails.length > MAX_LISTED ? t('settings.batch.more', { n: tails.length }) : '';
  const head = reason !== '' ? t('settings.batch.headSep', { reason }) : '';
  return t('settings.batch.failedMany', { verb, n: failed.length, head, shown, more, rest });
}

/** 批量响应的成功条数（缺省/legacy 服务 → undefined，不臆造数字）。 */
export function batchDoneCount(resp: BatchOpResp | null | undefined): number | undefined {
  const n = typeof resp?.deleted === 'number' ? resp.deleted : resp?.archived;
  return typeof n === 'number' ? n : undefined;
}

/** 响应里的失败 id 清单（批量重试/保留勾选用；无失败 → 空数组）。 */
export function batchFailedIds(resp: BatchOpResp | null | undefined): string[] {
  const failed = Array.isArray(resp?.failed) ? resp.failed : [];
  return failed.map((f) => f?.id ?? '').filter((id) => id !== '');
}
