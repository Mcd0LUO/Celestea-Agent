// ============================================================================
// ui/permissions/copy.ts — W9 权限预设的纯文案/语义映射（零 DOM、零网络）。
//
//   纪律：面向用户的字符串一律是**固定常量**；路径与工具名只作为数据填入固定句式。
//   免沙箱必须**如实**说明：preset.unsandboxed 只是「声明」，是否真正放开由部署侧
//   环境开关决定（服务端语义 unsandboxedAvailable）——UI 不假装它一定生效。
// ============================================================================
import type { PermissionPreset } from '../../types/permission';
import { t } from '../../i18n';

/** 免沙箱的如实说明（与后端 unsandboxedAvailable 同义）。 */
/** 免沙箱的如实说明（函数：语言切换后必须跟着变）。 */
export function unsandboxedNoteText(): string {
  return t('settings.permissions.unsandboxedNote');
}

/** 自定义预设 id 的形状（与服务端 parsePreset 的正则逐字一致）。 */
export const PRESET_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** 已知工具名的中文语义标签；未知工具名原样显示（数据，不翻译）。 */
export function toolDenyLabel(name: string): string {
  return name === 'write_file' ? t('settings.permissions.toolNoWrite') : t('settings.permissions.toolDisabled', { name });
}

export interface PresetChip {
  text: string;
  /** on = 放宽项；off = 关闭项；deny = 工具禁用项。 */
  tone: 'on' | 'off' | 'deny';
}

/** 一张卡片的语义标签（六个维度都如实呈现，含「关」的一面）。 */
export function presetChips(p: PermissionPreset): PresetChip[] {
  const chips: PresetChip[] = [
    { text: t(p.network ? 'settings.permissions.networkOn' : 'settings.permissions.networkOff'), tone: p.network ? 'on' : 'off' },
    {
      text: t(p.workspaceWritable ? 'settings.permissions.workspaceOn' : 'settings.permissions.workspaceOff'),
      tone: p.workspaceWritable ? 'on' : 'off',
    },
    {
      text: t(p.toolRootsWritable ? 'settings.permissions.toolRootOn' : 'settings.permissions.toolRootOff'),
      tone: p.toolRootsWritable ? 'on' : 'off',
    },
    {
      text: t(p.allPaths ? 'settings.permissions.allPathsOn' : 'settings.permissions.allPathsOff'),
      tone: p.allPaths ? 'on' : 'off',
    },
  ];
  const roots = p.writeRoots.length;
  chips.push({
    text: roots === 0 ? t('settings.permissions.noExtraRoots') : t('settings.permissions.extraRoots', { n: roots }),
    tone: roots === 0 ? 'off' : 'on',
  });
  chips.push({ text: t(p.unsandboxed ? 'settings.permissions.unsandboxedOn' : 'settings.permissions.unsandboxedOff'), tone: p.unsandboxed ? 'on' : 'off' });
  if (p.toolDeny.length === 0) chips.push({ text: t('settings.permissions.noToolDeny'), tone: 'off' });
  else for (const name of p.toolDeny) chips.push({ text: toolDenyLabel(name), tone: 'deny' });
  return chips;
}

/** 运行时封顶的如实展示（max 是 get presets 的真源；'' = 服务未给出）。 */
export function maxNote(max: string): string {
  return max === '' ? '' : t('settings.permissions.maxNote', { max });
}

/** 档位的静态风险说明（菜单里一行，不是阻塞确认框；默认档不弹任何确认）。 */
export function riskNote(p: PermissionPreset | null | undefined): string {
  if (p === null || p === undefined) return '';
  const parts: string[] = [];
  if (p.network) parts.push(t('settings.permissions.riskNetwork'));
  if (p.allPaths) parts.push(t('settings.permissions.riskAllPaths'));
  if (p.unsandboxed) parts.push(unsandboxedNoteText());
  return parts.join(' · ');
}

/** 卡片底部的免沙箱说明（不声明免沙箱时为空串）。 */
export function unsandboxedNote(p: PermissionPreset): string {
  return p.unsandboxed ? unsandboxedNoteText() : '';
}
