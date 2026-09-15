// ============================================================================
// ui/grants/flow.ts — 授予流程与撤销（设计 §3.3/§3.4/§5.5）
//   （W748 从 ui/grants.ts 拆出；确认句式/令牌重试/提示文案逐字未改。）
//
//   文案纪律（安全不变量，随代码一并搬家）：本模块所有面向用户的字符串都是
//   **固定常量**，绝不采用工具输出或模型文本中的任何字符串；范围值（路径/站点/
//   工具名）只作为**数据**填入固定句式。
//
//   W751：
//     · 任务 1b —— 危险能力不再要求**逐字输入确认词**；保留一次轻量确认
//       （作用范围 / 到期时间 / 后果文案 + 服务端快照），确认弹窗内不再有文本输入框。
//       后端的令牌流程与人证检查（同源 Sec-Fetch-Site + 一次性令牌）一律未动。
//     · 任务 1c —— 新增 startPreset：一条预设 = 若干 cap 的组合，**按顺序逐项**授予
//       （不把多个 cap 塞进一次请求），失败中断 + 已成功项点名。
//
//   W795（乐观更新，去进度占位）：
//     授予 / 撤销都改成**先画终态、后台发请求**：
//       · 确认之后**同一帧内**把这一项（预设 = 全部步骤）画成已授予并重绘面板，
//         界面上不再有任何「正在提交…」之类的占位；
//       · 请求失败 ⇒ 只回滚**这一项**（optimisticUngrant / optimisticUnrevoke）+ 重绘，
//         并用面板状态行与状态栏提示写明失败原因（绝不静默、绝不假装成功）；
//       · 成功 ⇒ 拿服务端回执写状态行/侧栏标记，再强制刷新一次快照；
//         新鲜快照一落定，乐观层整体作废（见 state.clearOptimistic / ui/grants.ts）。
//     门禁口径未动：默认永久（ttl_sec=0）、确认弹窗、令牌流程、scope-hash 全部原样。
// ============================================================================
import { api, ApiError, userErrorText } from '../../api';
import { scopeHashOf } from '../../security/scope-hash';
import type { EffectiveGrants, GrantCap, GrantEntry, GrantReq, GrantScope } from '../../types';
import { confirmDialog } from '../confirm';
import { pickDirectory } from '../fsbrowser';
import { flashStatus } from '../statusbar';
import { CAP_BY_NAME, PERMANENT_TEXT, markFromEffective, nowSec, type CapDef } from './caps';
import {
  confirmMessageFor,
  presetConfirmMessage,
  previewForPending,
  successText,
  type PlannedGrant,
} from './copy';
import { setMark } from './marks';
import { phraseFor, renderShield } from './panel';
import { presetTtlSec, type GrantPreset, type PresetStep } from './presets';
import { maxTtlOf, reqFor, ttlOf } from './request';
import { validateHosts, validateTools } from './scope';
import {
  drafts,
  getData,
  getPresetRun,
  inlineError,
  optimisticGrant,
  optimisticRevoke,
  optimisticSettle,
  optimisticUngrant,
  optimisticUnrevoke,
  setPanelNote,
  setPresetRun,
  setPresetRunner,
  type GrantsHost,
} from './state';

/**
 * 乐观层改动后的统一重画（W795）：盾牌与面板读的是**同一份** activeGrants
 * （含乐观项），两处必须同帧一致 —— 否则会出现「面板说已授予、盾牌数字没动」。
 */
function paintOptimistic(host: GrantsHost): void {
  renderShield();
  host.renderPanel();
}

// ---- 授予流程（令牌 + 二次确认 + 结果预览；§3.3/§3.4/§5.5） ----------------------

export async function startGrant(host: GrantsHost, def: CapDef): Promise<void> {
  const session = host.focusedSession();
  if (session === '') return;
  inlineError.delete(def.cap);

  let scope: GrantScope = {};
  if (def.kind === 'dirs') {
    const path = await pickDirectory('选择要放宽的目录', '只能选择目录；' + PERMANENT_TEXT);
    if (path === null || path.trim() === '') return;
    scope = { roots: [path.trim()] };
  } else if (def.kind === 'hosts') {
    const v = validateHosts(drafts.get(def.cap) ?? '');
    if (v.error !== '') {
      inlineError.set(def.cap, v.error);
      host.renderPanel();
      return;
    }
    scope = { hosts: v.values };
  } else if (def.kind === 'tools') {
    const v = validateTools(drafts.get(def.cap) ?? '');
    if (v.error !== '') {
      inlineError.set(def.cap, v.error);
      host.renderPanel();
      return;
    }
    scope = { tools: v.values };
  }

  const ttl = ttlOf(def);
  // W773：主路径 ttl=0 ⇒ 永久（expiresAt=null），确认文案走「撤销前一直有效」；
  // 只有用户在「临时授权…」里显式选了时长，才会出现具体到期时刻。
  const expiresAt = ttl === 0 ? null : nowSec() + ttl;
  const ok = await confirmDialog({
    title: '确认放宽权限 · ' + def.label,
    message: confirmMessageFor(def, scope, expiresAt),
    note: previewForPending(def, scope) + '\n变更将在会话下一轮开始时生效。',
    snapshot: JSON.stringify(getData()?.effective ?? {}, null, 2),
    snapshotLabel: '结果预览 · 生效快照（原样取自服务）',
    // W751：不再传 requireText —— 危险能力只保留这一次点击确认（无逐字输入框）。
    okLabel: '授予',
    danger: true,
  });
  if (!ok) return;

  // W795 乐观：确认即终态 —— 这一项**立刻**画成已授予（面板徽标/明细/结果预览/盾牌
  // 同一帧内全部跟上），请求在后台发。注意这里写的是「界面状态」，不是成功宣告：
  // 回执文案（successText）仍然只由服务端确认后的那一次写。
  optimisticGrant(def.cap, { cap: def.cap, scope, expires_at: expiresAt });
  paintOptimistic(host);
  try {
    const r = await submitGrant(session, def, reqFor(def, scope, ttl), scope);
    if (r === null) {
      // 理论上不可达（submitGrant 要么返回要么抛）；真到了这里也不许停在半成品。
      optimisticUngrant(def.cap);
      const text = '放宽失败：' + userErrorText(undefined, '请稍后重试');
      setPanelNote({ text, cls: 'err' });
      paintOptimistic(host);
      return;
    }
    drafts.delete(def.cap);
    // 这一项的请求已结束：之后的快照才有资格以服务端事实否掉乐观项（见 settleOptimistic）
    optimisticSettle(def.cap);
    setPanelNote({ text: successText(def, r), cls: 'busy' });
    flashStatus(successText(def, r), 'ok', 6000);
    if (r.effective) setMark(session, markFromEffective(r.effective));
    await host.refresh(true);
  } catch (err) {
    // 失败回滚：把这一项退回动作前的样子，并说明原因（先回滚再报错，界面不留半成品）
    optimisticUngrant(def.cap);
    const text = '放宽失败：' + userErrorText(err, '请稍后重试');
    setPanelNote({ text, cls: 'err' });
    flashStatus(text, 'err', 8000);
    paintOptimistic(host);
  }
}

// ---- 快捷授权预设（W751 任务 1c） -----------------------------------------------

interface PlannedStep {
  def: CapDef;
  scope: GrantScope;
  ttl: number;
}

/**
 * 一条预设 = 一次点击 → （可选的一次目录选择）→ 一次轻量确认 → **按顺序逐项 POST**。
 *
 * 顺序与失败语义：
 *   1) 先把**所有**步骤的范围解析完（目录弹窗最多一次；取消或校验失败 ⇒ 整组放弃，
 *      此时还没有发出任何请求，所以「取消 = 零副作用」）；
 *   2) 一次确认弹窗列出全部能力、作用范围与到期时间（危险能力不再逐字输入确认词）；
 *   3) 逐项授予：面板顶部与结果行显示「快捷授权 i/n：正在授予「…」」，某项失败立即中断，
 *      并明示**哪一项失败、哪些已成功**（已成功的仍可在下面逐项撤销）。
 */
export async function startPreset(host: GrantsHost, preset: GrantPreset): Promise<void> {
  const session = host.focusedSession();
  if (session === '' || getPresetRun() !== null) return;
  inlineError.clear();

  const planned: PlannedStep[] = [];
  for (const step of preset.steps) {
    const p = await planStep(preset, step);
    if (p === null) {
      // 取消/不合法：未发出任何授予请求（已选目录也不落盘），整组作废。
      host.renderPanel();
      return;
    }
    planned.push(p);
  }
  if (planned.length === 0) return;

  const at = nowSec();
  // W773：预设一律永久（presets.ts 的 ttlSec=0）⇒ 各步 expiresAt=null。
  const plannedGrants: PlannedGrant[] = planned.map((step) => ({
    def: step.def,
    scope: step.scope,
    expiresAt: step.ttl === 0 ? null : at + step.ttl,
  }));
  const ok = await confirmDialog({
    title: '确认快捷授权 · ' + preset.label,
    message: presetConfirmMessage(preset.label, plannedGrants),
    note:
      '授予后一次生效：' +
      planned.map((p) => phraseFor(p.def, p.scope)).join('；') +
      '。\n变更将在会话下一轮开始时生效。',
    snapshot: JSON.stringify(getData()?.effective ?? {}, null, 2),
    snapshotLabel: '结果预览 · 生效快照（原样取自服务）',
    okLabel: '授予',
    danger: true,
  });
  if (!ok) return;

  // W795 乐观：一次点击 = **全部步骤**在同一帧内画成已授予（零进度占位），
  // 之后按顺序逐项发请求；任一步失败只回滚该项，已成功项保持已授予。
  for (const p of planned) {
    optimisticGrant(p.def.cap, {
      cap: p.def.cap,
      scope: p.scope,
      expires_at: p.ttl === 0 ? null : nowSec() + p.ttl,
    });
  }
  setPresetRun({ id: preset.id, index: 0, total: planned.length });
  paintOptimistic(host);

  const done: string[] = [];
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i]!;
    // 仅用于「一次只跑一条预设」的并发门（面板不再显示 i/n 占位）
    setPresetRun({ id: preset.id, index: i, total: planned.length });
    try {
      const r = await submitGrant(session, p.def, reqFor(p.def, p.scope, p.ttl), p.scope);
      if (r?.effective) setMark(session, markFromEffective(r.effective));
      optimisticSettle(p.def.cap); // 这一步的请求已结束（快照随后可确认它）
      done.push(p.def.label);
    } catch (err) {
      // 只回滚失败的那一项：其余步骤（含尚未发出的）保持乐观已授予
      optimisticUngrant(p.def.cap);
      setPresetRun(null);
      const reason = userErrorText(err, '请稍后重试');
      const text =
        '快捷授权中断：「' +
        p.def.label +
        '」没有授予成功（' +
        reason +
        '）。' +
        (done.length > 0
          ? '已成功：' + done.join('、') + '（可在下面逐项撤销）。'
          : '本次没有产生任何授权。');
      setPanelNote({ text, cls: 'err' });
      flashStatus(text, 'err', 10000);
      paintOptimistic(host);
      await host.refresh(true);
      return;
    }
  }
  setPresetRun(null);
  const text = '快捷授权完成：已放宽 ' + done.join('、') + '。';
  setPanelNote({ text, cls: 'busy' });
  flashStatus(text, 'ok', 6000);
  await host.refresh(true);
}

/** 解析一步的范围（复用面板既有的目录选择/站点校验逻辑与默认值）；null = 放弃整组。 */
async function planStep(preset: GrantPreset, step: PresetStep): Promise<PlannedStep | null> {
  const def = CAP_BY_NAME.get(step.cap);
  if (!def) {
    setPanelNote({ text: '这个快捷授权包含当前不可用的能力，已取消。', cls: 'err' });
    return null;
  }
  let scope: GrantScope = {};
  if (step.scopeKind === 'dir') {
    const path = await pickDirectory(
      '选择要放宽的目录 · ' + preset.label,
      '本次快捷授权只会用到这一个目录；' + PERMANENT_TEXT,
    );
    if (path === null || path.trim() === '') {
      setPanelNote({ text: '已取消快捷授权：没有选择目录。', cls: 'err' });
      return null;
    }
    scope = { roots: [path.trim()] };
  } else if (step.scopeKind === 'hosts') {
    const draft = drafts.get(step.cap) ?? '';
    const raw = draft.trim() !== '' ? draft : (step.hosts ?? []).join(', ');
    const v = validateHosts(raw);
    if (v.error !== '') {
      inlineError.set(step.cap, v.error);
      setPanelNote({ text: '快捷授权已取消：「' + def.label + '」的站点范围不合法。', cls: 'err' });
      return null;
    }
    scope = { hosts: v.values };
  }
  return { def, scope, ttl: presetTtlSec(preset, maxTtlOf(def)) };
}

/** 取一次性令牌（有效期 60 秒）→ POST；令牌失效时重取一枚再试一次。 */
async function submitGrant(
  session: string,
  def: CapDef,
  req: GrantReq,
  scope: GrantScope,
): Promise<{ effective?: EffectiveGrants; grant?: GrantEntry } | null> {
  const scopeHash = await scopeHashOf(def.cap, scope);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await api.grantToken(session, def.cap, scopeHash);
    if (!t.token) throw new ApiError(userErrorText(t.error, '无法发起授权，请稍后重试'));
    try {
      const r = await api.grantCap(session, req, t.token);
      if (r.ok === false) throw new ApiError(userErrorText(r.error, '放宽失败，请稍后重试'));
      return { effective: r.effective, grant: r.grant };
    } catch (err) {
      // 令牌过期/已被使用：重新取一枚再试一次（确认动作本身已经完成）
      if (err instanceof ApiError && (err.status === 403 || err.status === 409) && attempt === 0) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

// 面板 → 本模块的单向注册（面板不 import 本模块，避免与 panel.ts 成环）。
setPresetRunner((host, preset) => startPreset(host, preset));

// ---- 撤销（不需要二次确认；§3.3 末段） ------------------------------------------

export async function revoke(host: GrantsHost, cap: GrantCap | null): Promise<void> {
  const session = host.focusedSession();
  if (session === '') return;
  const def = cap ? CAP_BY_NAME.get(cap) : undefined;
  // W795 乐观：撤销不需要二次确认 ⇒ 点下去这一帧就把该项（或全部）画成已撤销，
  // 请求在后台发；失败则把乐观层摘掉（界面回到撤销前的样子）并说明原因。
  optimisticRevoke(cap);
  paintOptimistic(host);
  try {
    const r = await api.revokeCap(session, cap ? { cap } : {});
    optimisticSettle(cap); // 撤销请求已结束：快照随后可确认「它确实没了」
    const n = (r.revoked ?? []).length;
    const text = cap && def ? '已撤销：' + def.label : n > 1 ? '已撤销 ' + n + ' 项放宽权限' : '已撤销放宽权限';
    setPanelNote({ text, cls: 'busy' });
    flashStatus(text, 'ok', 6000);
    if (r.effective) setMark(session, markFromEffective(r.effective));
    await host.refresh(true);
  } catch (err) {
    optimisticUnrevoke(cap);
    const text = '撤销失败：' + userErrorText(err, '请稍后重试');
    setPanelNote({ text, cls: 'err' });
    flashStatus(text, 'err', 8000);
    paintOptimistic(host);
  }
}
