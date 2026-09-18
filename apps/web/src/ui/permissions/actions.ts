// ============================================================================
// ui/permissions/actions.ts — 自定义预设的新建 / 编辑 / 删除（乐观优先，失败回滚）。
//
//   口径（W795 / W858）：点保存**当帧**就把新卡片插进列表（或按新值替换），请求在
//   后台跑；失败则把列表退回动作前的快照，并把**服务端给的原因**就地在表单旁显示。
//   列表重渲染由 PERMISSIONS_CHANGED 事件驱动（store 派发），本模块不碰 DOM。
//
//   关于服务端 error 原文：api.ts 的通用纪律是不把 technical 渲染给用户；本 pane 是
//   例外 —— W858 明确要求把 409/404/422 的校验原因就地展示（id 已存在 / 字段非法 /
//   档位不存在都是操作者要据以改表单的信息）。只对这三个状态透传，其余仍走固定措辞。
// ============================================================================
import { ApiError, api, userErrorText } from '../../api';
import type { PermissionPreset } from '../../types/permission';
import { findPreset, removeCustom, restore, snapshot, upsertCustom } from './store';

export interface ActionResult {
  ok: boolean;
  text: string;
  preset?: PermissionPreset;
}

/** 后端校验原因的透传白名单（只有这三种状态码的原因值得给操作者看）。 */
const REASON_STATUS: readonly number[] = [404, 409, 422];

export function reasonText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (REASON_STATUS.includes(err.status) && err.technical.trim() !== '') return err.technical;
    return err.message;
  }
  return userErrorText(err, fallback);
}

/** 200 但 ok:false / 缺 preset：不假装成功。 */
function rejected(r: { ok?: boolean; preset?: PermissionPreset }): boolean {
  return r.ok === false || r.preset === undefined;
}

export async function createPreset(preset: PermissionPreset): Promise<ActionResult> {
  const before = snapshot();
  upsertCustom(preset); // 乐观：先插卡片
  try {
    const r = await api.createPermissionPreset(preset);
    if (rejected(r) || r.preset === undefined) throw new ApiError('服务拒绝了该预设');
    upsertCustom(r.preset); // 以服务端回声为准（label/字段可能被截断规范化）
    return { ok: true, text: '已保存自定义预设', preset: r.preset };
  } catch (err) {
    restore(before); // 回滚：坏档不许留在列表里
    return { ok: false, text: '保存失败：' + reasonText(err, '请检查填写内容') };
  }
}

export async function updatePreset(preset: PermissionPreset): Promise<ActionResult> {
  const before = snapshot();
  upsertCustom(preset);
  try {
    const r = await api.updatePermissionPreset(preset.id, preset);
    if (rejected(r) || r.preset === undefined) throw new ApiError('服务拒绝了该预设');
    upsertCustom(r.preset);
    return { ok: true, text: '已保存自定义预设', preset: r.preset };
  } catch (err) {
    restore(before);
    return { ok: false, text: '保存失败：' + reasonText(err, '请检查填写内容') };
  }
}

export async function deletePreset(id: string): Promise<ActionResult> {
  const before = snapshot();
  const label = findPreset(id)?.label ?? id;
  removeCustom(id);
  try {
    const r = await api.deletePermissionPreset(id);
    if (r.ok === false) throw new ApiError('服务拒绝了该操作');
    return { ok: true, text: '已删除「' + label + '」' };
  } catch (err) {
    restore(before);
    return { ok: false, text: '删除失败：' + reasonText(err, '请稍后重试') };
  }
}
