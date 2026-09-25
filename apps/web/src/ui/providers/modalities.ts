// ============================================================================
// ui/providers/modalities.ts — 模型「输入 / 输出类型」多选组（W1536）
// ----------------------------------------------------------------------------
// 用户需求：编辑模型时要能选它支持文字/图片等哪些输入、哪些输出。
//
// 语义（与 contracts/data-files/providers.schema.json + W804 设计一致）：
//   · **缺省 = 乐观默认**（输入 [text, image] / 输出 [text]），此时 providers.json
//     里**不写**这两个键（absent）；
//   · 用户改动任一项 ⇒ 该键变为**显式配置**并写盘 —— 显式配置是「关掉图片入口」
//     的唯一途径（消费者：apps/web/src/ui/attachments.ts 的 modelAllowsImages）。
//   因此这里刻意不用「看起来一样」来判等：乐观默认态与显式勾选同值也**不是**同一件事。
//   · **空集被禁止**：后端 store/providers.ts 的 modalityList() 把空数组归一成
//     absent（⇒ 又回到乐观默认）。允许清空会让「全不勾」静默变回默认，故直接拦住。
//
// 交互：与既有推理强度档位片同构 —— 点击只切 class + aria-pressed + Set，
// 不重建 DOM（铁律 4），点完通知内联面板重算 max-height。
// ============================================================================
import { el } from '../../utils/dom';
import { t } from '../../i18n';

/** 可识别的类型（展示顺序即数组顺序）。 */
export const INPUT_MODALITIES: readonly string[] = ['text', 'image', 'audio'];
export const OUTPUT_MODALITIES: readonly string[] = ['text', 'image', 'audio'];

/** 各类型的乐观默认（与 schema 的 default 同值）。 */
export const INPUT_DEFAULT: readonly string[] = ['text', 'image'];
export const OUTPUT_DEFAULT: readonly string[] = ['text'];

export interface ModalityGroup {
  root: HTMLElement;
  /** 回填：absent（undefined）= 乐观默认态；显式数组 = 配置态。 */
  set(values: readonly string[] | undefined): void;
  /** 写回载荷：undefined = 保持缺省（乐观）；数组 = 显式配置（非空）。 */
  values(): string[] | undefined;
}

/**
 * 建一组多选片。
 * @param label    左侧行标签（已 t() 过的用户文案）
 * @param options  可点类型
 * @param defaults 乐观默认集合（absent 时的显示态）
 * @param onLayout 内容高度变化回调（内联面板重算 max-height）
 */
export function addModalityGroup(
  label: string,
  options: readonly string[],
  defaults: readonly string[],
  onLayout?: (() => void) | undefined,
): ModalityGroup {
  // DOM 结构：root（横跨高级区两列）> [行标签, body(类型片 + 说明)]。
  // 标签必须自己占一列，否则会被当成第 7/8 个网格项与隔壁行错位（真机实测）。
  const root = el('div', 'prov-modalities');
  const body = el('div', 'prov-modality-body');
  const chips = el('div', 'prov-modality-chips');
  const note = el('span', 'prov-modality-note');
  const selected = new Set<string>();
  const buttons = new Map<string, HTMLButtonElement>();
  /** 乐观默认态（未写盘）：与显式同值也必须区分，见文件头。 */
  let optimistic = true;

  const setNote = (text: string): void => {
    note.textContent = text;
    note.hidden = text === '';
  };

  const sync = (): void => {
    for (const [value, b] of buttons) {
      const on = selected.has(value);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    root.classList.toggle('is-default', optimistic);
    setNote(
      optimistic
        ? t('settings.providers.modalityOptimistic', { list: defaults.join(' / ') })
        : t('settings.providers.modalityExplicit'),
    );
  };

  /** 建一枚类型片；同值已存在则忽略（存量非标准类型补片时也走这里）。 */
  const addChip = (value: string): void => {
    if (value === '' || buttons.has(value)) return;
    const b = el('button', 'prov-modality-chip', value) as HTMLButtonElement;
    b.type = 'button';
    b.dataset.modality = value;
    b.addEventListener('click', () => {
      if (selected.has(value) && selected.size <= 1) {
        setNote(t('settings.providers.modalityAtLeastOne')); // 空集无法落盘，直接拦住
        onLayout?.();
        return;
      }
      // 首次点击即脱离乐观默认：此后写盘的就是用户勾的集合本身。
      optimistic = false;
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      sync();
      onLayout?.();
    });
    buttons.set(value, b);
    chips.appendChild(b);
  };

  for (const value of options) addChip(value);

  root.appendChild(el('span', 'prov-adv-label', label));
  body.appendChild(chips);
  body.appendChild(note);
  root.appendChild(body);
  return {
    root,
    set(values: readonly string[] | undefined): void {
      optimistic = values === undefined;
      selected.clear();
      for (const v of values ?? defaults) {
        // 存量/未来的非标准类型（如 video）：补一枚片，保证「看得见、能改、往返不丢」，
        // 与 EffortChips 对 xhigh 等非固定档位的处理同构。
        addChip(v);
        selected.add(v);
      }
      sync();
    },
    values(): string[] | undefined {
      return optimistic ? undefined : [...selected];
    },
  };
}
