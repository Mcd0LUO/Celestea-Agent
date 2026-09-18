// ============================================================================
// statusline/picker-list.ts — W870：模型 / 推理档位**清单渲染**（离屏构建 + 单次
//   替换，铁律 1）。从 ./picker.ts 拆出，纯搬运（DOM 结构、类名、文案、事件均未改）；
//   拆出的原因是 picker.ts 触到前端模块体积门禁的 400 行上限，而 W870 的会话级模型
//   切换必须在同一文件里长出分支。
//
//   与 ./picker.ts 的分工：本模块只画（含 W870 的「本会话已固定模型」说明行），
//   点击行为经 ./picker-shared.ts 的 ListHooks 交回调用方；因此本模块**不** import
//   ./picker.ts，也就没有环。
// ============================================================================
import { el } from '../utils/dom';
import type { ConfigInfo, ModelInfo } from '../types';
import { modelIconEl } from './icons';
import { EFFORT_OPTIONS, OTHER_GROUP, type ListHooks, type ModelPick, type PickerHost, type SwitchKind } from './picker-shared';

/**
 * 渲染清单（离屏构建 + 单次替换，铁律 1）。
 * `cfg` 可以来自配置缓存（同步首屏）或一次真实拉取，渲染结果与来源无关。
 */
export function renderList(body: HTMLElement, kind: SwitchKind, cfg: ConfigInfo, host: PickerHost, hooks: ListHooks): void {
  if (kind === 'effort') {
    renderEffortList(body, cfg.reasoning_effort ?? '', hooks);
    return;
  }
  renderModelList(body, cfg, host, hooks);
}

/**
 * 推理档位清单（W795 抽出）：候选全是静态常量 + 一个「当前」值 ⇒ 不依赖任何请求，
 * 冷启动也能同一帧画出来（乐观渲染），所以它与模型清单分成两个渲染器。
 */
export function renderEffortList(body: HTMLElement, current: string, hooks: ListHooks): void {
  const off = document.createElement('div');
  const options = [...EFFORT_OPTIONS];
  const cur = current;
  if (cur && !options.some((o) => o.value === cur)) {
    options.push({ value: cur, label: cur + '（当前）' });
  }
  for (const o of options) {
    off.appendChild(optButton(o.label, o.value ?? '', cur, () => hooks.apply({ reasoning_effort: o.value })));
  }
  body.replaceChildren(...off.childNodes);
}

export function renderModelList(body: HTMLElement, cfg: ConfigInfo, host: PickerHost, hooks: ListHooks): void {
  const off = document.createElement('div');

  // ---- model：按提供商分组的树状清单（W262） ----
  const models = Array.isArray(cfg.available?.models) ? cfg.available.models : [];
  const cur = cfg.model ?? host.snapshotModel;
  if (!models.length) {
    // 清单缺失 → 内联文本输入降级
    const row = el('div', 'sl-popup-textrow');
    const input = el('input', 'sl-popup-input') as HTMLInputElement;
    input.placeholder = '模型名称';
    input.value = cur;
    row.appendChild(input);
    const applyBtn = el('button', 'btn btn-accent btn-mini', '应用') as HTMLButtonElement;
    applyBtn.addEventListener('click', () => {
      const v = input.value.trim();
      // W870：手工输入也是**切模型**，所以同样走 hooks.pick（会话级 / 全局由宿主决定）
      // —— 若走 hooks.apply 就会退回全局 POST /api/config，在带覆盖的会话上正是那个 bug。
      if (v !== '' && v !== cur) hooks.pick({ model: v, providerId: '' });
    });
    row.appendChild(applyBtn);
    off.appendChild(row);
    off.appendChild(el('div', 'sl-popup-note', '请输入模型名称'));
    appendFixedNote(off, host);
    body.replaceChildren(...off.childNodes);
    return;
  }
  const known = models.some((m) => m.id === cur);
  if (cur && !known) {
    // 当前模型不在清单里（自定义端点）→ 置顶一行，仍可点回
    off.appendChild(optButton(cur + '（当前）', cur, cur, () => hooks.apply({ model: cur })));
    const sep = el('div', 'sl-popup-sep');
    sep.textContent = '候选模型';
    off.appendChild(sep);
  }
  // W750：当前生效项 = 后端标注的 active 行（同模型 + 同端点）。旧服务没有该
  // 字段时退回「按模型 id 匹配」；两者都没有 → 没有选中态，也不虚标。
  const activeRow = models.find((m) => m.active === true) ?? null;
  const sameId = models.find((m) => m.id === cur) ?? null;
  const currentProviderId = (activeRow?.provider_id ?? '').trim();
  const isCurrent = (m: ModelInfo): boolean =>
    activeRow !== null ? m.active === true : sameId !== null && m === sameId;
  // 树状一级 = provider 显示名（后端已保证模型名未定义时取 id）。
  // W750：同一 provider id 的记录聚成一组（显示名可能重复/被改，用 id 做键），
  // 缺 provider 字段的记录（静态兜底目录 / 旧数据）归入「其他」组。
  const groups: { pid: string; name: string; list: ModelInfo[] }[] = [];
  const byPid = new Map<string, { pid: string; name: string; list: ModelInfo[] }>();
  for (const m of models) {
    const pid = (m.provider_id ?? '').trim();
    const name = (m.provider ?? '').trim() || (pid !== '' ? pid : OTHER_GROUP);
    const key = pid !== '' ? pid : name;
    let group = byPid.get(key);
    if (!group) {
      group = { pid, name, list: [] };
      byPid.set(key, group);
      groups.push(group);
    }
    group.list.push(m);
  }
  appendFixedNote(off, host);
  for (const group of groups) {
    off.appendChild(groupRow(group.name, group.pid, group.list.some(isCurrent)));
    for (const m of group.list) {
      const pick: ModelPick = {
        model: m.id,
        // 显示名不是 id：只有拿到稳定 id 且与当前 provider 不同才需要先切 provider。
        providerId: (() => {
          const pid = (m.provider_id ?? '').trim();
          return pid !== '' && pid !== currentProviderId ? pid : '';
        })(),
      };
      off.appendChild(optButton(m.name || m.id, m.id, isCurrent(m) ? m.id : '', () => hooks.pick(pick), true));
    }
  }
  body.replaceChildren(...off.childNodes);
}

/**
 * W870：该会话**有**自己的 `session.json.model` 时如实说一行。
 *
 * 为什么必须有：徽标的 model 来自会话实例的 profile（全局 base + 会话覆盖），
 * 所以这样的会话**本来就不跟**全局默认走。用户点开选择器时若不说明，就会把
 * 「切了全局、这个会话却没变」当成又一个 bug（那正是 W870 报案的另一半）。
 * 只在有聚焦会话且确实带覆盖时出现 —— 无覆盖的会话零改动、零噪音。
 */
function appendFixedNote(off: HTMLElement, host: PickerHost): void {
  if (!host.sessionModelFixed || host.sessionId === '') return;
  off.appendChild(el('div', 'sl-popup-note', '本会话已固定模型：切换只改本会话，不跟随全局默认'));
}

/**
 * W778：缓存清单与后台校验结果是否一致（不一致才允许原地替换）。
 * 只比对本渲染器真正用到的字段：档位看 reasoning_effort，模型看当前模型 + 清单。
 */
export function listChanged(kind: SwitchKind, a: ConfigInfo, b: ConfigInfo): boolean {
  if (kind === 'effort') return (a.reasoning_effort ?? '') !== (b.reasoning_effort ?? '');
  return (
    (a.model ?? '') !== (b.model ?? '') ||
    JSON.stringify(a.available?.models ?? []) !== JSON.stringify(b.available?.models ?? [])
  );
}

/**
 * W262：树状分组标题行 —— 提供商显示名，不可点击（无 button/无监听）。
 * W750：组内含当前生效项时标一个「当前」；display name 与稳定 id 不同名时
 * 把 id 一并淡显，免得两个 provider 显示名相似时看不出切的是哪一个。
 */
function groupRow(provider: string, providerId: string, cur: boolean): HTMLElement {
  const row = el('div', 'sl-group' + (cur ? ' cur' : ''));
  row.appendChild(el('span', 'sl-group-name', provider));
  if (providerId !== '' && providerId !== provider) {
    row.appendChild(el('span', 'sl-group-id', providerId));
  }
  if (cur) row.appendChild(el('span', 'sl-group-tag', '当前'));
  return row;
}

/** 模型/档位一行；`sub=true` = 树状缩进一级（provider 组下的模型行）。 */
function optButton(
  label: string,
  value: string,
  current: string,
  onPick: () => void,
  sub = false,
): HTMLElement {
  const cls =
    'sl-opt' +
    (sub ? ' sub' : '') +
    (value !== '' && value === current ? ' current' : '');
  const b = el('button', cls) as HTMLButtonElement;
  // W750：模型行前置家族图标（未识别 → 不加节点，不占位）。
  const icon = modelIconEl(value);
  if (icon !== null) b.appendChild(icon);
  b.appendChild(el('span', 'sl-opt-name', label));
  if (value !== '') b.appendChild(el('span', 'sl-opt-val', value));
  if (value !== '' && value === current) b.appendChild(el('span', 'sl-opt-tag', '当前'));
  b.addEventListener('click', onPick);
  return b;
}
