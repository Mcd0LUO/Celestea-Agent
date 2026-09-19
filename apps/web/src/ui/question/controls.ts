// ============================================================================
// ui/question/controls.ts — W784 提问卡片的**控件层**（题干 / 选项 / 自由输入）。
//
// 只做 DOM 与事件，判定全在 ./format 的纯函数里；草稿（picks）与控件清单由卡片
// 本体借进来（PickHost），因此这一层不持有状态、可被单独读懂。
// 单选/多选靠 input.type 区分，答案一律回传 **label**（§3.2 约定 1：不按位置推断）。
// ============================================================================
import { el } from '../../utils/dom';
import type { QuestionItem, QuestionOption } from '../../types';
import { pickOf, togglePick, withCustom, type QuestionPick } from './format';
import { t } from '../../i18n';

/** 作答草稿宿主：卡片把 picks / controls 借给控件层。 */
export interface PickHost {
  /** 卡片 id：把同一题的 radio 归到同一个 name 组（否则跨题互斥）。 */
  id: string;
  picks: Record<string, QuestionPick>;
  controls: HTMLInputElement[];
  /** 用户一动手就清掉上一次提示（未答完 / 提交失败）。 */
  onEdit: () => void;
}

/** 一个选项行：label 是身份，description 只是一句权衡说明。 */
function buildOption(
  host: PickHost,
  q: QuestionItem,
  opt: QuestionOption,
  approveLabel: string | undefined,
): HTMLElement {
  const row = el('label', 'q-opt');
  if (approveLabel !== undefined && approveLabel === opt.label) row.classList.add('is-approve');
  const input = el('input', 'q-opt-input') as HTMLInputElement;
  input.type = q.multi_select === true ? 'checkbox' : 'radio';
  input.name = 'q-' + host.id + '-' + q.id;
  input.value = opt.label;
  const text = el('span', 'q-opt-text');
  text.appendChild(el('span', 'q-opt-label', opt.label));
  if (opt.description !== undefined && opt.description !== '') {
    text.appendChild(el('span', 'q-opt-desc', opt.description));
  }
  row.appendChild(input);
  row.appendChild(text);
  input.addEventListener('change', () => {
    host.picks[q.id] = togglePick(pickOf(host.picks, q.id), opt.label, q.multi_select === true);
    host.onEdit();
  });
  host.controls.push(input);
  return row;
}

/** 一个问题块：题干 + 可选说明 + 选项（0 个 = 纯自由输入）+ 自由输入行。 */
export function buildQuestionBlock(host: PickHost, q: QuestionItem): HTMLElement {
  const box = el('div', 'q-item');
  box.appendChild(el('div', 'q-question', q.question));
  if (q.detail !== undefined && q.detail !== '') {
    box.appendChild(el('div', 'q-detail', q.detail));
  }
  const options = q.options ?? [];
  if (options.length > 0) {
    const list = el('div', 'q-options');
    const approve = q.intent?.approve;
    for (const opt of options) list.appendChild(buildOption(host, q, opt, approve));
    box.appendChild(list);
  }
  const input = el('input', 'q-custom-input') as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = options.length > 0 ? t('chat.question.customPlaceholder') : t('chat.question.customRequired');
  input.addEventListener('input', () => {
    host.picks[q.id] = withCustom(pickOf(host.picks, q.id), input.value);
    host.onEdit();
  });
  host.controls.push(input);
  const row = el('div', 'q-custom');
  row.appendChild(input);
  box.appendChild(row);
  return box;
}
