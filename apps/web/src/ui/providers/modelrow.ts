// ============================================================================
// ui/providers/modelrow.ts — 单模型行（含「高级」区与推理强度档位片）
//   W748 从 ui/providers.ts 拆出；W9107 改推理强度交互（见下）。
// ----------------------------------------------------------------------------
// W9107（用户口径）：出现的档位片**一律是选中态**，不再有「不勾选」态 ——
//   · 「+」新增片 = 自动选中（同名去重逻辑照旧）；
//   · 每片右上角「×」= **销毁该片**（不是取消勾选）；固定三档也能删，删完可用「+」加回；
//   · 回填语义：未配置（undefined）⇒ 三片全选（乐观默认）；显式数组 ⇒ 就是那几片
//     （空数组 ⇒ 一片不留）。**后端契约未动**：reasoning_efforts 为空数组仍是
//     「该模型不支持推理」（apps/studio/src/handlers/config.ts 的 isReasoningCapable）。
// ============================================================================
import { el } from '../../utils/dom';
import type { EditorRefs, EffortChips } from './types';
import { addModalityGroup, INPUT_DEFAULT, INPUT_MODALITIES, OUTPUT_DEFAULT, OUTPUT_MODALITIES } from './modalities';
import { syncModelDividers } from './divider';
import { t } from '../../i18n';

/**
 * 推理强度固定档位（W258 任务 3）：与后端 available.efforts 一致。
 * W261：「+」按钮可再追加自定义档位（如 xhigh/ultra），后端 reasoning_efforts 为自由字符串。
 */
const EFFORT_TIERS: readonly string[] = ['low', 'high', 'max'];

export function addModelRow(e: EditorRefs, id = '', name = ''): void {
  const li = el('div', 'prov-model-row');
  const rid = el('input', 'cfg-input') as HTMLInputElement;
  rid.placeholder = t('settings.providers.modelId');
  rid.value = id;
  const rname = el('input', 'cfg-input') as HTMLInputElement;
  rname.placeholder = t('settings.providers.modelDisplayName');
  rname.value = name;
  const det = document.createElement('details');
  det.className = 'prov-model-adv';
  const sum = document.createElement('summary');
  sum.textContent = t('settings.providers.advanced');
  det.appendChild(sum);
  const adv = el('div', 'prov-model-adv-body');
  // W258 任务 3 / W9107：档位片集合。出现即选中；「×」销毁；「+」新增并选中。
  // 点完通知内联面板重算 max-height（铁律 5），不重建 DOM（铁律 4）。
  const selected = new Set<string>();
  /** 归一化 key：忽略大小写与所有空白，仅用于去重（展示值保留用户输入）。 */
  const effortKey = (v: string): string => v.replace(/\s+/g, '').toLowerCase();
  /** 归一化 key → 档位片（Map 插入顺序 = 展示顺序）。 */
  const chipByKey = new Map<string, HTMLButtonElement>();
  const chipsRoot = el('div', 'prov-effort-chips');
  // 「+」按钮与内联输入框：永远排在所有档位片之后；新增片一律插到「+」左侧
  const plusBtn = el('button', 'btn-mini', '+') as HTMLButtonElement;
  plusBtn.type = 'button';
  plusBtn.title = t('settings.providers.addEffortTier');
  const tierInput = el('input', 'cfg-input') as HTMLInputElement;
  tierInput.placeholder = t('settings.providers.customTierPlaceholder');
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

  /** 销毁一枚档位片（「×」与「显式配置」回填共用）。 */
  const removeChip = (key: string): void => {
    const chip = chipByKey.get(key);
    if (!chip) return;
    chipByKey.delete(key);
    selected.delete(chip.dataset.effort ?? '');
    chip.remove();
  };

  /** 建一枚档位片并插到「+」左侧；同名（忽略大小写/空白）已存在则忽略。出现即选中。 */
  const addChip = (value: string): void => {
    const key = effortKey(value);
    if (key === '' || chipByKey.has(key)) return;
    const b = el('button', 'prov-effort-chip') as HTMLButtonElement;
    b.type = 'button';
    b.dataset.effort = value;
    // 片内结构：档位名 + 右上角「×」（无包裹：无边框无底色，hover 才显形/显色）。
    // 片本体**不再**是开关 —— 点击不改状态，改集合只有「×」（删）与「+」（加）两条路，
    // 于是「出现的片一律选中」不可能被点坏（用户口径：删掉不勾选的状态）。
    const label = el('span', 'prov-effort-label', value);
    const kill = el('button', 'prov-effort-kill', '×') as HTMLButtonElement;
    kill.type = 'button';
    kill.setAttribute('aria-label', t('settings.providers.removeEffortTier', { tier: value }));
    kill.addEventListener('click', (ev: MouseEvent) => {
      // 不冒泡到片本体 / 行本体（行本体点击会展开收起面板）
      ev.stopPropagation();
      removeChip(key);
      e.onLayout?.();
    });
    b.appendChild(label);
    b.appendChild(kill);
    chipByKey.set(key, b);
    chipsRoot.insertBefore(b, plusBtn);
    setChipOn(b, true);
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
          setHint(t('settings.providers.tierExists', { tier: value })); // 轻微提示，不重复添加
        } else {
          setHint('');
          addChip(value); // 新增片一律选中
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
    set(values: readonly string[] | undefined): void {
      // undefined（未配置）⇒ 三片全选；数组 ⇒ 就是这几片（空数组 = 一片不留）。
      // 存量非标准档位（xhigh / 历史 medium 等）照旧补片保留，绝不被吞掉。
      const want = new Map<string, string>(); // key → 展示值
      for (const raw of values ?? EFFORT_TIERS) {
        const v = raw.trim();
        if (v === '') continue;
        const k = effortKey(v);
        if (!want.has(k)) want.set(k, v);
      }
      // 显式配置态：清掉不在集合里的片（否则「×」删掉的档位保存往返会复活）。
      // 缺省态不清：默认三片必须都在（乐观默认）。
      if (values !== undefined) for (const k of [...chipByKey.keys()]) if (!want.has(k)) removeChip(k);
      for (const [k, v] of want) if (!chipByKey.has(k)) addChip(v);
      selected.clear();
      for (const [k, b] of chipByKey) setChipOn(b, want.has(k));
    },
    values(): string[] {
      // 展示顺序（= DOM 顺序）返回选中档位。
      const out: string[] = [];
      for (const b of chipByKey.values()) {
        const v = b.dataset.effort ?? '';
        if (v !== '' && selected.has(v)) out.push(v);
      }
      return out;
    },
  };
  const ctx = el('input', 'cfg-input') as HTMLInputElement;
  ctx.type = 'text';
  ctx.min = '0';
  ctx.placeholder = t('settings.providers.contextPlaceholder');
  const maxOut = el('input', 'cfg-input') as HTMLInputElement;
  maxOut.type = 'text';
  maxOut.min = '0';
  maxOut.placeholder = t('settings.providers.maxOutPlaceholder');
  adv.appendChild(el('label', 'prov-adv-label', t('settings.providers.reasoningEffort')));
  adv.appendChild(chipsRoot);
  adv.appendChild(el('label', 'prov-adv-label', t('settings.providers.modelContext')));
  adv.appendChild(ctx);
  adv.appendChild(el('label', 'prov-adv-label', t('settings.field.maxOutputTokens')));
  adv.appendChild(maxOut);
  // W1536：输入 / 输出类型多选（用户点名要的「是否支持文字图片」）。
  // 语义：缺省 = 乐观默认（不写盘）；点一下即变显式配置并写盘。
  const inputModalities = addModalityGroup(
    t('settings.providers.inputModalities'),
    INPUT_MODALITIES,
    INPUT_DEFAULT,
    () => e.onLayout?.(),
  );
  inputModalities.set(undefined); // 新建模型行 = 乐观默认态
  adv.appendChild(inputModalities.root);
  const outputModalities = addModalityGroup(
    t('settings.providers.outputModalities'),
    OUTPUT_MODALITIES,
    OUTPUT_DEFAULT,
    () => e.onLayout?.(),
  );
  outputModalities.set(undefined);
  adv.appendChild(outputModalities.root);
  det.appendChild(adv);
  // 高级区展开/收起会改变内容高度：通知内联面板重算 max-height
  det.addEventListener('toggle', () => e.onLayout?.());
  const del = el('button', 'btn-mini danger', t('settings.action.remove')) as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => {
    li.remove();
    e.rows = e.rows.filter((r) => r.li !== li);
    syncModelDividers(e.modelsBox); // 行没了：分界线跟着重排（末尾不再有线）
    e.onLayout?.();
  });
  li.appendChild(rid);
  li.appendChild(rname);
  li.appendChild(det);
  li.appendChild(del);
  e.modelsBox.appendChild(li);
  e.rows.push({ id: rid, name: rname, efforts: chips, ctx, maxOut, inputModalities, outputModalities, li });
  syncModelDividers(e.modelsBox); // 新行与上一行之间补一条分界线
  e.onLayout?.();
}
