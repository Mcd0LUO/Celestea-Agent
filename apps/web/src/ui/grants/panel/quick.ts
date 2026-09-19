// ============================================================================
// ui/grants/panel/quick.ts — 面板顶部「快捷授权」区（W751 任务 1c；W760 从 ../panel.ts 拆出）。
//
//   预设组合的数据在 ../presets.ts；本模块负责「等效已生效」判定所需的只读视图
//   （activeViews，与原文件同组）与整块渲染/触发：一条预设 = 逐项放宽，
//   等效授权已生效时显示「已生效」但仍可点击（重复点击幂等）。真正的授予动作在
//   ../flow.ts（经 state.ts 注册的 runner 调用，避免与 body.ts 成环）。
//   W760 只搬家：DOM 结构、类名、文案、禁用规则逐字未改。
// ============================================================================
import { el } from '../../../utils/dom';
import { caps, permanentLabel, ttlChoices, ttlLabel, listOf, scopeOf } from '../caps';
import { t } from '../../../i18n';
import { presets, presetSatisfied, type ActiveCapView, type GrantPreset } from '../presets';
import { getPresetRun, getPresetRunner, setPanelNote, type GrantsHost } from '../state';
import { activeFor } from './active';

// ---- 快捷授权预设（W751 任务 1c） ----------------------------------------------

/** 生效集 → 供纯函数判定的只读视图（站点类带上生效站点，用于「等效已生效」）。 */
function activeViews(): ActiveCapView[] {
  const out: ActiveCapView[] = [];
  for (const def of caps()) {
    const g = activeFor(def.cap);
    if (!g) continue;
    out.push({
      cap: def.cap,
      hosts: def.kind === 'hosts' ? listOf(scopeOf(g).hosts) : [],
    });
  }
  return out;
}

/**
 * 预设的统一有效期 → 用户语言。
 * W773：预设一律永久（`ttlSec: 0`）⇒ 显示「永久」；保留非 0 分支以防将来出现限时预设。
 */
export function presetTtlLabel(preset: GrantPreset): string {
  if (preset.ttlSec <= 0) return permanentLabel();
  const hit = ttlChoices().find((c) => c.sec === preset.ttlSec);
  if (hit) return t('grants.quick.ttlPrefix', { label: ttlLabel(hit) });
  return t('grants.quick.ttlMinutes', { n: Math.max(1, Math.round(preset.ttlSec / 60)) });
}

/**
 * 「快捷授权」区：一键组合按钮。
 * 等效授权已生效时**显示已生效态**（按钮加 .on + 「已生效」标），但仍可点击 ——
 * 重复点击是幂等的（后端同一 cap 本来就是 replace-by-cap，重授只会刷新到期时间）。
 */
export function renderPresets(host: GrantsHost): HTMLElement {
  const box = el('div', 'grant-presets');
  const head = el('div', 'grant-presets-head');
  head.appendChild(el('span', 'grant-presets-title', t('grants.quick.title')));
  head.appendChild(el('span', 'grant-presets-ttl-note', t('grants.quick.note')));
  box.appendChild(head);

  const run = getPresetRun();
  const active = activeViews();
  for (const preset of presets()) {
    const btn = el('button', 'grant-preset') as HTMLButtonElement;
    btn.type = 'button';
    const satisfied = presetSatisfied(preset, active);
    btn.classList.toggle('on', satisfied);
    // W795：请求在飞期间禁用其它预设（一次只跑一条，顺序语义不变），但**不再**显示
    // 「进行中 i/n」占位 —— 被点的那条在这一帧里已经是「已生效」终态。
    btn.disabled = run !== null;
    btn.title = preset.hint;

    const top = el('span', 'grant-preset-top');
    top.appendChild(el('span', 'grant-preset-label', preset.label));
    if (satisfied) {
      top.appendChild(el('span', 'grant-preset-tag', t('grants.quick.applied')));
    }
    top.appendChild(el('span', 'grant-preset-ttl', presetTtlLabel(preset)));
    btn.appendChild(top);
    btn.appendChild(el('span', 'grant-preset-hint', preset.hint));
    btn.addEventListener('click', () => void runPreset(host, preset));
    box.appendChild(btn);
  }
  return box;
}

async function runPreset(host: GrantsHost, preset: GrantPreset): Promise<void> {
  const runner = getPresetRunner();
  if (!runner) {
    setPanelNote({ text: t('grants.quick.unavailable'), cls: 'err' });
    host.renderPanel();
    return;
  }
  await runner(host, preset);
}
