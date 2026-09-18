// ============================================================================
// ui/permissions/store.ts — W9 权限预设的**唯一缓存**（设置页列表 + statusline 档位菜单共用）。
//
//   · 数据只在 GET /api/permissions/presets 回来后写入；界面从不猜默认档；
//   · 乐观更新（新建/编辑/删除）先改这里再渲染，失败用 snapshot()/restore() 回滚；
//   · 变更经 window 事件广播（PERMISSIONS_CHANGED）：pane 列表与 statusline 菜单
//     各自订阅，互不直接 import（避免循环依赖，也避免「一处改了两处不同步」）。
// ============================================================================
import { api } from '../../api';
import type { PermissionPreset } from '../../types/permission';

export interface PresetsSnapshot {
  builtin: PermissionPreset[];
  custom: PermissionPreset[];
  /** 运行时封顶档位 id（GET 的 max；'' = 未知）。 */
  max: string;
}

/** 预设集合变化事件（列表/菜单订阅；乐观改动与回滚都会派发）。 */
export const PERMISSIONS_CHANGED = 'studio:permissions-changed';

let cache: PresetsSnapshot | null = null;
let inflight: Promise<PresetsSnapshot> | null = null;

function clone(p: PermissionPreset): PermissionPreset {
  return { ...p, writeRoots: [...p.writeRoots], toolDeny: [...p.toolDeny] };
}

function copyOf(snap: PresetsSnapshot): PresetsSnapshot {
  return { builtin: snap.builtin.map(clone), custom: snap.custom.map(clone), max: snap.max };
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PERMISSIONS_CHANGED));
}

/** 当前快照的副本（null = 尚未成功取回）。 */
export function snapshot(): PresetsSnapshot | null {
  return cache === null ? null : copyOf(cache);
}

/** 回滚到先前快照（actions 失败路径专用）。 */
export function restore(snap: PresetsSnapshot | null): void {
  cache = snap === null ? null : copyOf(snap);
  notify();
}

/** 内置 + 自定义（statusline 菜单一次列全）。 */
export function allPresets(): PermissionPreset[] {
  return cache === null ? [] : [...cache.builtin, ...cache.custom].map(clone);
}

export function findPreset(id: string): PermissionPreset | null {
  if (cache === null) return null;
  const found = [...cache.builtin, ...cache.custom].find((p) => p.id === id);
  return found === undefined ? null : clone(found);
}

/** 显示名：未知 id 原样返回（不编造、不隐藏）。 */
export function labelOf(id: string): string {
  const p = findPreset(id);
  return p === null ? id : p.label || id;
}

export function isBuiltin(id: string): boolean {
  return cache !== null && cache.builtin.some((p) => p.id === id);
}

/** 乐观写入：同 id 替换，否则追加（新建与编辑共用）。 */
export function upsertCustom(preset: PermissionPreset): void {
  if (cache === null) cache = { builtin: [], custom: [], max: '' };
  const next = cache.custom.filter((p) => p.id !== preset.id);
  next.push(clone(preset));
  cache = { ...cache, custom: next };
  notify();
}

/** 乐观移除（删除失败由 restore 补回）。 */
export function removeCustom(id: string): void {
  if (cache === null) return;
  cache = { ...cache, custom: cache.custom.filter((p) => p.id !== id) };
  notify();
}

/** 取回预设清单（force = 强制刷新；并发去重）。失败原样抛出，调用方决定文案。 */
export async function ensurePresets(force = false): Promise<PresetsSnapshot> {
  if (!force && cache !== null) return copyOf(cache);
  if (inflight !== null) return inflight;
  inflight = api
    .permissionPresets()
    .then((r) => {
      cache = {
        builtin: r.builtin ?? [],
        custom: r.custom ?? [],
        max: typeof r.max === 'string' ? r.max : '',
      };
      notify();
      return copyOf(cache);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
