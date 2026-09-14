// ============================================================================
// ui/inputbar.ts — 输入栏（单一职责）：textarea 自动增高、Enter 发送、
// 发送/取消按钮状态。业务逻辑通过回调交给 chat.ts。
//
// W514 多会话 / 插话契约：
//   - 运行中**不再禁用发送**：Enter/发送 = 注入运行中的轮次（不新开轮）；
//   - readonly 模式（worker 会话视图）：发送禁用，仅查看；
//   - 发送/取消/停止按钮的显隐真源仍是 setBusy（当前聚焦会话的运行态）。
//
// W515 提交两态（对齐 DSH Agent Inbox 的两条车道）：
//   - Enter / 发送按钮 = 当前车道（默认 steer=插话，next-step 最近 step 边界送达）；
//   - Ctrl/Cmd+Enter = 另一条车道（queue=排队，next-turn 本轮结束后独立投递）；
//   - 输入栏右侧「插话/排队」小切换：只用鼠标也能选车道，文案与占位符随之变化。
// ============================================================================
import { need } from '../utils/dom';

/**
 * 提交车道：
 *   steer —— next-step：注入运行中轮次的最近 step 边界（插话）
 *   queue —— next-turn：本轮结束后作为下一回合独立投递（排队）
 */
export type SubmitMode = 'steer' | 'queue';

export interface InputBarHandlers {
  /** 发送；text 为原始输入内容（trim/校验由调用方负责），mode = 提交车道。 */
  send(text: string, mode: SubmitMode): void;
  cancel(): void;
}

export type InputMode = 'idle' | 'interject' | 'readonly';

const MAX_HEIGHT = 240;
const PLACEHOLDER_IDLE = '输入消息，Enter 发送，Shift+Enter 换行';
const PLACEHOLDER_STEER = '运行中 · Enter 插话（下一步送达）· Ctrl/Cmd+Enter 排队（下一回合送达）';
const PLACEHOLDER_QUEUE = '运行中 · Enter 排队（本轮结束后送达）· Ctrl/Cmd+Enter 插话（下一步送达）';
const PLACEHOLDER_READONLY = 'Worker 会话 · 只读查看';

let bar: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let modeBtn: HTMLButtonElement | null = null;

/** 当前提交车道（运行中生效；空闲发送一律开新轮）。默认插话（= W514 行为）。 */
let submitMode: SubmitMode = 'steer';
/** 当前输入栏模式（文案/按钮重绘用）。 */
let inputMode: InputMode = 'idle';

export function getSubmitMode(): SubmitMode {
  return submitMode;
}

export function setSubmitMode(mode: SubmitMode): void {
  submitMode = mode;
  renderSubmitUi();
}

/** 两条车道互切（小切换按钮 / Ctrl+Enter 之外的入口）。 */
export function toggleSubmitMode(): void {
  setSubmitMode(submitMode === 'steer' ? 'queue' : 'steer');
}

/** 车道相关 UI 重绘（切换按钮 / 占位符 / 发送按钮文案）——只改文案与 class。 */
function renderSubmitUi(): void {
  if (modeBtn) {
    modeBtn.textContent = submitMode === 'steer' ? '插话' : '排队';
    modeBtn.title =
      submitMode === 'steer'
        ? '当前：插话（Enter）· 下一步送达 · 点击改为排队'
        : '当前：排队（Enter）· 本轮结束后送达 · 点击改为插话';
    modeBtn.classList.toggle('queue', submitMode === 'queue');
  }
  if (inputEl && inputMode === 'interject') {
    inputEl.placeholder = submitMode === 'steer' ? PLACEHOLDER_STEER : PLACEHOLDER_QUEUE;
  }
  if (sendBtn) {
    sendBtn.disabled = inputMode === 'readonly';
    sendBtn.textContent =
      inputMode === 'readonly' ? '只读' : inputMode === 'interject' ? (submitMode === 'steer' ? '插话' : '排队') : '发送';
    sendBtn.title =
      inputMode === 'readonly'
        ? 'Worker 会话为只读视图'
        : inputMode === 'interject'
          ? submitMode === 'steer'
            ? '插话（Enter）：注入运行中的轮次，下一步送达'
            : '排队（Enter）：本轮结束后作为下一回合送达'
          : '发送（Enter）';
  }
}

export function initInputBar(h: InputBarHandlers): void {
  const input = need<HTMLTextAreaElement>('#input');
  inputEl = input;
  bar = need<HTMLElement>('#inputbar');
  sendBtn = need<HTMLButtonElement>('#btnSend');
  cancelBtn = need<HTMLButtonElement>('#btnCancel');
  // W302：statusline 上的「停止」方形按钮（与 #btnCancel 共用同一个取消回调）
  const stopEl = need<HTMLButtonElement>('#slStop');
  stopBtn = stopEl;
  modeBtn = document.getElementById('btnMode') as HTMLButtonElement | null;

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
  };

  sendBtn.addEventListener('click', () => h.send(input.value, submitMode));
  cancelBtn.addEventListener('click', () => h.cancel());
  modeBtn?.addEventListener('click', () => toggleSubmitMode());
  stopEl.addEventListener('click', () => {
    if (stopEl.disabled) return;
    stopEl.disabled = true;
    h.cancel();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    // Ctrl/Cmd+Enter = 另一条车道（两态都要可直达，不必先切按钮）
    const lane: SubmitMode = e.ctrlKey || e.metaKey
      ? submitMode === 'steer'
        ? 'queue'
        : 'steer'
      : submitMode;
    h.send(input.value, lane);
  });
  input.addEventListener('input', autoGrow);
  renderSubmitUi();
  window.setTimeout(autoGrow, 0);
}

/** 发送成功后清空输入框并复位高度。 */
export function clearInput(): void {
  const input = inputEl ?? need<HTMLTextAreaElement>('#input');
  input.value = '';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
}

/** 当前输入框内容（切换会话时保存草稿用）。 */
export function inputValue(): string {
  return inputEl ? inputEl.value : '';
}

/** 写回输入框内容（切换会话恢复草稿 / 插话失败还原）。 */
export function setInputValue(v: string): void {
  const input = inputEl ?? need<HTMLTextAreaElement>('#input');
  input.value = v;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
}

/**
 * 切换 取消/停止 按钮状态（= 当前聚焦会话是否运行中）。
 * W514：**发送按钮不随 busy 禁用**（运行中发送走插话/排队路径）。
 */
export function setBusy(busy: boolean): void {
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !busy);
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !busy);
    stopBtn.disabled = !busy;
  }
}

/** 输入栏模式（空闲 / 插话·排队 / 只读）——只切 class 与文案，不重建 DOM。 */
export function setInputMode(mode: InputMode): void {
  inputMode = mode;
  const input = inputEl;
  if (bar) {
    bar.classList.toggle('interject', mode === 'interject');
    bar.classList.toggle('readonly', mode === 'readonly');
  }
  if (modeBtn) modeBtn.classList.toggle('hidden', mode !== 'interject');
  if (input) {
    input.placeholder =
      mode === 'readonly'
        ? PLACEHOLDER_READONLY
        : mode === 'interject'
          ? submitMode === 'steer'
            ? PLACEHOLDER_STEER
            : PLACEHOLDER_QUEUE
          : PLACEHOLDER_IDLE;
    input.readOnly = false; // 只读视图仍允许打字（草稿保留），发送被禁用
  }
  renderSubmitUi();
}
