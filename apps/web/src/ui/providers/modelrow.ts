// ============================================================================
// ui/providers/modelrow.ts — 单模型行（含「高级」区与推理强度档位片）
//   （W748 从 ui/providers.ts 拆出；纯搬运，DOM/类名/文案/事件未改）。
// ============================================================================
import { el } from '../../utils/dom';
import type { EditorRefs, EffortChips } from './types';

/**
 * 推理强度固定档位（W258 任务 3）：与后端 available.efforts 一致。
 * W261：「+」按钮可再追加自定义档位（如 xhigh/ultra），后端 reasoning_efforts 为自由字符串。
 */
const EFFORT_TIERS: readonly string[] = ['low', 'high', 'max'];

export function addModelRow(e: EditorRefs, id = '', name = ''): void {
  const li = el('div', 'prov-model-row');
  const rid = el('input', 'cfg-input') as HTMLInputElement;
  rid.placeholder = '模型 id';
  rid.value = id;
  const rname = el('input', 'cfg-input') as HTMLInputElement;
  rname.placeholder = '显示名';
  rname.value = name;
  const det = document.createElement('details');
  det.className = 'prov-model-adv';
  const sum = document.createElement('summary');
  sum.textContent = '高级（推理强度 / 上下文 / 最大输出）';
  det.appendChild(sum);
  const adv = el('div', 'prov-model-adv-body');
  // W258 任务 3：推理强度改为可点击档位片（多选）；点击只切 class + aria-pressed，
  // 不重建 DOM（铁律 4/8），点完通知内联面板重算 max-height。
  // W261：固定片右侧加「+」按钮 → 行内输入框新增自定义档位（如 xhigh）；
  // 自定义片与固定片同 class、同切换行为，values() 一并返回。
  const selected = new Set<string>();
  /** 归一化 key：忽略大小写与所有空白，仅用于去重（展示值保留用户输入）。 */
  const effortKey = (v: string): string => v.replace(/\s+/g, '').toLowerCase();
  /** 归一化 key → 档位片（Map 插入顺序 = 展示顺序）。 */
  const chipByKey = new Map<string, HTMLButtonElement>();
  const chipsRoot = el('div', 'prov-effort-chips');
  // 「+」按钮与内联输入框：永远排在所有档位片之后；新增片一律插到「+」左侧
  const plusBtn = el('button', 'btn-mini', '+') as HTMLButtonElement;
  plusBtn.type = 'button';
  plusBtn.title = '添加自定义推理档位（如 xhigh）';
  const tierInput = el('input', 'cfg-input') as HTMLInputElement;
  tierInput.placeholder = '自定义档位名（如 xhigh）';
  tierInput.hidden = true;
  // 尺寸用内联样式：本任务提交范围仅本文件，不改 settings.css（避免全宽输入框撑满一行）
  tierInput.style.width = '170px';
  tierInput.style.flex = '0 0 auto';
  // 重复档位提示：行内小字（复用既有 cfg-hint 样式），不占用表单状态区
  const dupHint = el('span', 'cfg-hint');
  dupHint.hidden = true;
  chipsRoot.appendChild(plusBtn);
  chipsRoot.appendChild(tierInput);
  chipsRoot.appendChild(dupHint);

  /** 只切 class / aria-pressed 与选中集，不重建节点（铁律 4）。 */
  const setChipOn = (b: HTMLButtonElement, on: boolean): void => {
    const v = b.dataset.effort ?? '';
    if (on) selected.add(v);
    else selected.delete(v);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  };

  /** 建一枚档位片并插到「+」左侧；同名（忽略大小写/空白）已存在则忽略。 */
  const addChip = (value: string, on = false): void => {
    const key = effortKey(value);
    if (key === '' || chipByKey.has(key)) return;
    const b = el('button', 'prov-effort-chip', value) as HTMLButtonElement;
    b.type = 'button';
    b.dataset.effort = value;
    b.addEventListener('click', () => {
      setChipOn(b, !selected.has(b.dataset.effort ?? ''));
      e.onLayout?.();
    });
    chipByKey.set(key, b);
    chipsRoot.insertBefore(b, plusBtn);
    setChipOn(b, on);
  };

  const setHint = (text: string): void => {
    dupHint.textContent = text;
    dupHint.hidden = text === '';
  };

  /** 收起内联输入框：commit=true（Enter/失焦）按内容新增；false（Esc）不添加。 */
  const closeTierInput = (commit: boolean): void => {
    if (tierInput.hidden) return;
    const raw = tierInput.value;
    tierInput.value = '';
    tierInput.hidden = true; // 先收起：随后的 blur 由本函数的 hidden 守卫吞掉
    plusBtn.hidden = false;
    if (commit) {
      const value = raw.trim();
      if (value !== '') {
        if (chipByKey.has(effortKey(value))) {
          setHint('档位已存在：' + value); // 轻微提示，不重复添加
        } else {
          setHint('');
          addChip(value, true); // 新增片默认选中
        }
      }
    }
    e.onLayout?.(); // 高度变化：通知内联面板重算 max-height（铁律 5）
  };

  plusBtn.addEventListener('click', () => {
    if (!tierInput.hidden) return;
    setHint('');
    tierInput.value = '';
    tierInput.hidden = false;
    plusBtn.hidden = true;
    e.onLayout?.();
    tierInput.focus();
  });
  tierInput.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      closeTierInput(true);
    } else if (ev.key === 'Escape') {
      // 只收起输入框，不冒泡到全局浮层 Esc 栈（避免顺手把弹窗也关掉）
      ev.preventDefault();
      ev.stopPropagation();
      closeTierInput(false);
    }
  });
  tierInput.addEventListener('blur', () => closeTierInput(true));

  for (const tier of EFFORT_TIERS) addChip(tier);
  const chips: EffortChips = {
    root: chipsRoot,
    set(values: readonly string[]): void {
      // 归一化去重后回填：非标准档位（存量 xhigh / 历史 medium 等）补片保留，
      // 补出的片同样插在「+」左侧，绝不被吞掉。
      const want = new Map<string, string>(); // key → 展示值
      for (const raw of values) {
        const v = raw.trim();
        if (v === '') continue;
        const k = effortKey(v);
        if (!want.has(k)) want.set(k, v);
      }
      for (const [k, v] of want) if (!chipByKey.has(k)) addChip(v);
      selected.clear();
      for (const [k, b] of chipByKey) setChipOn(b, want.has(k));
    },
    values(): string[] {
      const out: string[] = [];
      for (const t of EFFORT_TIERS) {
        const v = chipByKey.get(effortKey(t))?.dataset.effort;
        if (v !== undefined && selected.has(v)) out.push(v);
      }
      for (const b of chipByKey.values()) {
        const v = b.dataset.effort ?? '';
        if (v !== '' && !EFFORT_TIERS.includes(v) && selected.has(v)) out.push(v);
      }
      return out;
    },
  };
  const ctx = el('input', 'cfg-input') as HTMLInputElement;
  ctx.type = 'text';
  ctx.min = '0';
  ctx.placeholder = '上下文窗口（如 1000000 / 1m / 128k）';
  const maxOut = el('input', 'cfg-input') as HTMLInputElement;
  maxOut.type = 'text';
  maxOut.min = '0';
  maxOut.placeholder = '最大输出 tokens（如 8192 / 8k）';
  adv.appendChild(el('label', 'prov-adv-label', '推理强度'));
  adv.appendChild(chipsRoot);
  adv.appendChild(el('label', 'prov-adv-label', '模型上下文'));
  adv.appendChild(ctx);
  adv.appendChild(el('label', 'prov-adv-label', '最大输出 tokens'));
  adv.appendChild(maxOut);
  det.appendChild(adv);
  // 高级区展开/收起会改变内容高度：通知内联面板重算 max-height
  det.addEventListener('toggle', () => e.onLayout?.());
  const del = el('button', 'btn-mini danger', '移除') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => {
    li.remove();
    e.rows = e.rows.filter((r) => r.li !== li);
    e.onLayout?.();
  });
  li.appendChild(rid);
  li.appendChild(rname);
  li.appendChild(det);
  li.appendChild(del);
  e.modelsBox.appendChild(li);
  e.rows.push({ id: rid, name: rname, efforts: chips, ctx, maxOut, li });
  e.onLayout?.();
}
