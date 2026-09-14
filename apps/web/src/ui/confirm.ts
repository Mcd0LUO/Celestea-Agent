// ============================================================================
// ui/confirm.ts — 破坏性操作二次确认弹窗（沿用 .modal-scrim/.modal-card 体系）：
//   默认焦点在「取消」；Esc / 点击遮罩 = 取消；确认后 resolve(true)。
//   第 26 轮（W256）：Esc 走 utils/overlays 层级栈（不再自建 document 监听，
//   避免与设置页/其他弹窗的监听重复触发，一次 Esc 只关栈顶一层）。
//   W701：新增两项**可选**能力，供提权通道的二次确认使用：
//     - requireText：必须逐字输入确认词才可点确认（打断「确认疲劳」）；
//     - snapshot：**原样**展示服务端返回的结果快照（绝不改写措辞）。
//   两者缺省时行为与旧版逐字一致，既有调用方不受影响。
// ============================================================================
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';

export interface ConfirmOpts {
  title?: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
  focus?: 'ok' | 'cancel';
  /**
   * 需要逐字输入的确认词（如「允许」）。缺省/空串 = 只需点击确认。
   * 该词必须是调用方的**固定常量**，绝不接受任何模型或工具输出。
   */
  requireText?: string;
  /** 逐字输入提示行（缺省时用确认词自身拼一句固定文案）。 */
  requireHint?: string;
  /** 服务端返回的结果快照：原样放入等宽块，调用方不得改写。 */
  snapshot?: string;
  /** 快照块的说明标签。 */
  snapshotLabel?: string;
  /** 补充说明（如生效时机），以弱化样式显示在正文下方。 */
  note?: string;
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = el('div', 'modal-scrim');
    const card = el('div', 'modal-card confirm-card');
    if (opts.title) card.appendChild(el('div', 'modal-card-title', opts.title));
    const msg = el('div', 'confirm-message');
    msg.textContent = opts.message;
    card.appendChild(msg);

    if (opts.note) card.appendChild(el('div', 'confirm-note', opts.note));

    if (opts.snapshot) {
      card.appendChild(el('div', 'confirm-snapshot-label', opts.snapshotLabel ?? '生效结果'));
      const pre = el('pre', 'confirm-snapshot');
      pre.textContent = opts.snapshot;
      card.appendChild(pre);
    }

    const requireText = (opts.requireText ?? '').trim();
    let wordInput: HTMLInputElement | null = null;
    if (requireText !== '') {
      const row = el('div', 'confirm-word-row');
      const label = document.createElement('label');
      label.textContent = opts.requireHint ?? '请输入「' + requireText + '」以确认';
      const input = el('input', 'cfg-input') as HTMLInputElement;
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      row.appendChild(label);
      row.appendChild(input);
      card.appendChild(row);
      card.appendChild(el('div', 'confirm-word-hint', '逐字输入后「确认」才会可用'));
      wordInput = input;
    }

    const actions = el('div', 'modal-card-actions');
    const ok = el('button', 'btn ' + (opts.danger ? 'btn-danger' : 'btn-accent'), opts.okLabel ?? '确认') as HTMLButtonElement;
    ok.type = 'button';
    const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
    cancel.type = 'button';

    let done = false;
    let overlay: OverlayHandle | null = null;
    const settle = (v: boolean) => {
      if (done) return;
      done = true;
      if (overlay) {
        popOverlay(overlay);
        overlay = null;
      }
      scrim.remove();
      resolve(v);
    };

    if (wordInput) {
      ok.disabled = true;
      wordInput.addEventListener('input', () => {
        ok.disabled = wordInput.value.trim() !== requireText;
      });
      wordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !ok.disabled) {
          e.preventDefault();
          settle(true);
        }
      });
    }

    ok.addEventListener('click', () => {
      if (wordInput && wordInput.value.trim() !== requireText) return;
      settle(true);
    });
    cancel.addEventListener('click', () => settle(false));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) settle(false);
    });

    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    scrim.appendChild(card);
    document.body.appendChild(scrim);
    // 压栈：Esc 只关栈顶一层（确认框在设置页之上时先关它）
    overlay = pushOverlay(() => settle(false));
    // 默认焦点：「取消」；需输入确认词时先落在输入框（不预填、不代填）
    if (wordInput) wordInput.focus();
    else (opts.focus === 'ok' ? ok : cancel).focus();
  });
}
