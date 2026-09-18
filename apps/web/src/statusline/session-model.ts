// ============================================================================
// statusline/session-model.ts — W870：**会话级**模型切换请求（纯函数，零 DOM）。
//
//   为什么单独一层：picker.ts 的弹层切换与 statusline.ts 的 409 挂起重试都要问
//   同样两个问题 ——「这次切换打哪个端点」与「结果怎么归类」。两处各写一遍必然
//   分叉；这里只放这两个纯逻辑，DOM 与 setNote 仍在调用方（本模块不 import 它们，
//   也就不可能成环：与 ./optimistic.ts 同一条纪律）。
//
//   产品语义（W870，用户可见）：statusline 的模型选择器切的是**当前聚焦会话**的
//   模型（PUT /api/sessions/{id}/model → session.json.model）。它显示在哪个会话的
//   statusline 上，用户点的就是「这个会话用哪个模型」；全局默认仍归设置页「通用配置」
//   的 POST /api/config。没有聚焦会话（旧单会话容器）时回落到全局路径。
//
//   为什么必须这样：徽标轮询 GET /api/status?session=，其 model 来自**会话实例**
//   的 profile（全局 base + session.json.model 覆盖，见 runtime/session-compose.ts
//   的 profileFor）。只写全局配置时，带覆盖的会话会在 ≤2s 后的轮询被打回原值
//   —— 这正是用户报的「切换模型后几秒又弹回原状」。
// ============================================================================
import { api, ApiError, userErrorText } from '../api';

/** 一次切换的目标：会话级（有聚焦会话）或全局（无聚焦会话的回落路径）。 */
export type SessionModelTarget = 'session' | 'config';

/**
 * 这次切换打哪个端点：有聚焦会话 ⇒ 会话级端点（本会话模型）；
 * 无（`host.sessionId === ''`，旧单会话容器）⇒ 回落 POST /api/config（全局默认）。
 */
export function modelTargetOf(sessionId: string): SessionModelTarget {
  return sessionId === '' ? 'config' : 'session';
}

/**
 * 切换结果（三态分类，与 statusline/mode.ts 的 ModeSwitchOutcome 同款）：
 *   `ok`          成功（`covered` = 该会话现在是否有自己的覆盖）；
 *   `busy`        轮次进行中（409，调用方挂起重试）；
 *   `unsupported` 该部署没有这个端点（404/405，老服务）；
 *   `invalid`     取值被拒（400/422，模型名非法）；
 *   `error`       其它失败。
 * 四种失败都带一句可以**直接显示**的 `text`（不透传服务端原文，走 ./api 的措辞层）。
 */
export type SessionModelOutcome =
  | { kind: 'ok'; target: SessionModelTarget; model: string; covered: boolean; effective: string | null }
  | { kind: 'busy'; target: SessionModelTarget; text: string }
  | { kind: 'unsupported'; target: SessionModelTarget; text: string }
  | { kind: 'invalid'; target: SessionModelTarget; text: string }
  | { kind: 'error'; target: SessionModelTarget; text: string };

/** 失败态（`ok` 之外的全部）—— `failureText` 的入参。 */
export type SessionModelFailure = Exclude<SessionModelOutcome, { kind: 'ok' }>;

/** 把一次 api 调用的成功响应折成 `ok`（两个端点各有自己的字段）。 */
function okOutcome(
  target: SessionModelTarget,
  model: string,
  covered: boolean,
  effective: string | null,
): SessionModelOutcome {
  return { kind: 'ok', target, model, covered, effective };
}

/**
 * 切换一个会话的模型：`PUT /api/sessions/{id}/model {model}`。
 * `model: ''` = **清除覆盖**（该会话回落到全局默认）——服务端删除
 * `session.json.model` 这个键，并在响应里回 `covered:false`。
 *
 * 只有 200 且响应里带回了模型值才算成功：`ok:false` 的 200 也算失败（不假装成功）。
 */
export async function requestSessionModel(session: string, model: string): Promise<SessionModelOutcome> {
  if (session === '') return { kind: 'error', target: 'config', text: '当前会话尚未就绪，请稍后再试' };
  try {
    const r = await api.setSessionModel(session, model);
    if (r.ok === false) return { kind: 'error', target: 'session', text: '切换失败，请稍后重试' };
    const resolved = typeof r.model === 'string' && r.model !== '' ? r.model : model;
    const eff = r.effective === undefined ? '' : (r.effective.model ?? '');
    return okOutcome('session', resolved, r.covered === true, eff === '' ? null : eff);
  } catch (err) {
    return classify(err, 'session', '切换失败：' + userErrorText(err, '请稍后重试'));
  }
}

/**
 * 无聚焦会话时的**回落路径**：沿用 W227/W750 的 `POST /api/config {model}`
 * （全局默认）。`covered` 恒为 false —— 全局配置本来就不属于任何会话。
 */
export async function requestGlobalModel(model: string): Promise<SessionModelOutcome> {
  try {
    const d = await api.saveConfig({ model });
    // 服务端回声缺失时用**请求值**兜底（不假装切成功：请求 200 已说明写入成立）。
    const written = typeof d.model === 'string' && d.model !== '' ? d.model : model;
    return okOutcome('config', written, false, written);
  } catch (err) {
    return classify(err, 'config', '切换失败：' + userErrorText(err, '请稍后重试'));
  }
}

/** HTTP 失败的三态归类（409 / 404-405 / 400-422 各自成类，其余归 error）。 */
function classify(err: unknown, target: SessionModelTarget, text: string): SessionModelOutcome {
  if (err instanceof ApiError) {
    if (err.status === 409) return { kind: 'busy', target, text };
    if (err.status === 404 || err.status === 405) {
      return { kind: 'unsupported', target, text: '当前版本不支持切换本会话模型' };
    }
    if (err.status === 400 || err.status === 422) return { kind: 'invalid', target, text };
  }
  return { kind: 'error', target, text };
}

/** 成功后的如实提示：会话级 ≠ 全局，两种目标说两种话（W870 要求如实）。 */
export function switchedNote(target: SessionModelTarget): string {
  return target === 'session' ? '已切换本会话模型' : '已切换默认模型';
}

/**
 * 失败时的如实说明。**永不假成功**：调用方先回滚乐观显示，这里只负责这句给用户
 * 看的话；409 挂起由调用方走「本轮结束后按同一路径重试」那条路。
 */
export function failureText(outcome: SessionModelFailure): string {
  return outcome.text + '（已恢复原设置）';
}
