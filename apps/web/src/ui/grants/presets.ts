// ============================================================================
// ui/grants/presets.ts — 「快捷授权」预设组合（W751 任务 1c）
//
//   一条预设 = 若干**现有** cap 的授予组合 + 一个统一有效期。
//   W773：**预设一律永久**（`ttlSec: 0`）；想限时请用面板上该能力位的「临时授权…」。
//   本模块是纯数据 + 纯函数（零 DOM，可在 node 里直接加载做断言），因此：
//     · 只允许引用 caps.ts 里已有的 cap，绝不发明新 cap；
//     · 文案是固定句式（安全不变量：不采用任何工具输出/模型文本）；
//     · **文案惰性解析**（presets() 函数而非常量）：语言切换后必须跟着变。
// ============================================================================
import type { GrantCap } from '../../types';
import { t } from '../../i18n';

/** 预设步骤的作用范围来源。 */
export type PresetScopeKind = 'none' | 'dir' | 'hosts';

export interface PresetStep {
  cap: GrantCap;
  scopeKind: PresetScopeKind;
  /** scopeKind='hosts' 的默认站点集（面板输入框草稿非空时以草稿为准）。 */
  hosts?: readonly string[];
}

export interface GrantPreset {
  id: string;
  label: string;
  /** 一句话说明（固定句式；写明代价与范围，不采用任何外部文本）。 */
  hint: string;
  /** 统一 TTL（秒）；实际值再按该能力的服务端上限收敛，见 presetTtlSec。 */
  ttlSec: number;
  steps: readonly PresetStep[];
}

/** 「本机服务」预设的默认站点集（仅这两个；不做网段/通配）。 */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * 四个一键组合（顺序即面板展示顺序）。
 *
 * 语义注意一（W773）：每条预设的 `ttlSec` 都是 0 = **永久**（撤销前一直有效）。
 * 语义注意二（安全面）：后端的 `net_hosts` 是**并集放宽**，不是白名单收窄 ——
 *   「本机服务」= 联网 + 放行本机站点，而不是「只能访问本机」。
 */
export function presets(): readonly GrantPreset[] {
  return [
    {
      id: 'read-workspace',
      label: t('grants.preset.readWorkspace.label'),
      hint: t('grants.preset.readWorkspace.hint'),
      ttlSec: 0,
      steps: [{ cap: 'read_roots', scopeKind: 'dir' }],
    },
    {
      id: 'write-output',
      label: t('grants.preset.writeOutput.label'),
      hint: t('grants.preset.writeOutput.hint'),
      ttlSec: 0,
      steps: [{ cap: 'write_roots', scopeKind: 'dir' }],
    },
    {
      id: 'net',
      label: t('grants.preset.net.label'),
      hint: t('grants.preset.net.hint'),
      ttlSec: 0,
      steps: [{ cap: 'network', scopeKind: 'none' }],
    },
    {
      id: 'localhost',
      label: t('grants.preset.localhost.label'),
      hint: t('grants.preset.localhost.hint'),
      ttlSec: 0,
      steps: [
        { cap: 'network', scopeKind: 'none' },
        { cap: 'net_hosts', scopeKind: 'hosts', hosts: LOCAL_HOSTS },
      ],
    },
  ];
}

/** 预设 id → 预设（每次现取，跟随语言）。 */
export function presetById(): ReadonlyMap<string, GrantPreset> {
  return new Map(presets().map((p) => [p.id, p]));
}

/** 预设涉及的能力位（去重，保持步骤顺序）。 */
export function presetCaps(preset: GrantPreset): GrantCap[] {
  const out: GrantCap[] = [];
  for (const s of preset.steps) if (!out.includes(s.cap)) out.push(s.cap);
  return out;
}

/**
 * 某项能力在本预设下的有效期：`0`（永久）原样返回，否则与服务端上限取小
 * （上限缺失/非法 = 不收敛）。W773：永久不该被上限截断，所以先短路 0。
 */
export function presetTtlSec(preset: GrantPreset, capMaxTtl: number): number {
  if (preset.ttlSec <= 0) return 0;
  if (!Number.isFinite(capMaxTtl) || capMaxTtl <= 0) return preset.ttlSec;
  return Math.min(preset.ttlSec, capMaxTtl);
}

/** 生效快照的只读视图（由调用方从 GrantEntry 折算，便于纯断言）。 */
export interface ActiveCapView {
  cap: string;
  /** 站点类能力的生效站点集（布尔类留空）。 */
  hosts?: readonly string[];
}

/**
 * 预设的「等效授权已生效」判定：
 *   · 每个步骤的 cap 都必须已生效；
 *   · 站点类步骤还要求生效站点集**覆盖**该步骤的默认站点（少一个就不算等效）；
 *   · 目录类步骤的目标目录由用户在弹窗里现选，未选之前无法比对 → 只要求 cap 已生效。
 */
export function presetSatisfied(
  preset: GrantPreset,
  active: readonly ActiveCapView[],
): boolean {
  return preset.steps.every((step) => {
    const hit = active.find((a) => a.cap === step.cap);
    if (!hit) return false;
    if (step.scopeKind !== 'hosts') return true;
    const have = hit.hosts ?? [];
    const want = step.hosts ?? [];
    return want.every((h) => have.includes(h));
  });
}
