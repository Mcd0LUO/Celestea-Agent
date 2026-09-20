// ============================================================================
// plugins/apply.ts — 客户端插件的装配与**真热开关**（W859）。
// ----------------------------------------------------------------------------
//   startClientPlugins()  装配时调用一次：把登记表里启用的提供者挂上去；
//   setClientPlugin(id,on) 开关：真的注册/真的注销（幂等），失败回滚且不写偏好。
// 语义要点：
//   · 乐观优先 —— 调用方（设置页）当帧翻开关，本函数同步完成注册/注销；
//   · 失败回滚 —— 注册抛错 ⇒ 保证不留半挂载；注销抛错 ⇒ 把旧的挂回去，
//     且**不写偏好**，下次打开页面仍是原状态；
//   · 未知 id 拒绝（不猜、不静默成功）。
// ============================================================================
import { clientPlugins, clientPluginIds, clientPluginById } from './descriptor';
import { t } from '../i18n';
import { activatePlugin, deactivatePlugin, isRegistered, registerEnhancerPlugin, registerHintPlugin } from './register';
import { setDisabled } from './store';

/** 切换回执：pane 就地显示；失败时 pane 负责把开关拨回去（状态没变）。 */
export interface ToggleResult {
  ok: boolean;
  text: string;
}

/** 装配内建客户端插件（ui/hint 的 initHints 调用；幂等，只挂当前启用的）。 */
export function startClientPlugins(): void {
  for (const d of clientPlugins()) {
    // W895：两种缝共用同一套记账，只有「挂到哪」不同。
    if (d.kind === 'hint') registerHintPlugin(d.create());
    else registerEnhancerPlugin(d.create());
  }
}

/** 该插件此刻是否真的挂着（不是看偏好；诊断/测试/设置页初值都用它）。 */
export function isClientPluginOn(id: string): boolean {
  return isRegistered(id);
}

/** 幂等开关：真的注册/注销，成功后写偏好；失败保持原状态并返回说明。 */
export function setClientPlugin(id: string, on: boolean): ToggleResult {
  const d = clientPluginById(id);
  if (d === null) return { ok: false, text: t('plugins.notFound') };
  try {
    if (on) activatePlugin(id);
    else deactivatePlugin(id);
  } catch (err) {
    restore(id, !on);
    console.warn('[plugins] 切换失败：' + (err instanceof Error ? err.message : String(err)));
    return { ok: false, text: t('plugins.toggleFailed', { label: d.label }) };
  }
  setDisabled(id, !on, clientPluginIds());
  return { ok: true, text: t('plugins.toggled', { state: on ? t('plugins.on') : t('plugins.off'), label: d.label }) };
}

/** 兜底把实际挂载状态拉回期望值（失败路径专用；再失败只记日志，不掩盖原始错误）。 */
function restore(id: string, on: boolean): void {
  try {
    if (on) activatePlugin(id);
    else deactivatePlugin(id);
  } catch (err) {
    console.warn('[plugins] 回滚失败：' + (err instanceof Error ? err.message : String(err)));
  }
}
