// ============================================================================
// ui/inputbar/button-labels.ts — W1512：输入栏按钮的**文案与两态渲染**（零业务）
// ----------------------------------------------------------------------------
// 为什么单独成模块：W1512 把「发送」与「终止」合并成同一控件的两态后，文案渲染从
// 一个分支变成两个状态源（busy x inputMode x submitMode），塞回 inputbar.ts 会让它
// 超过前端模块体积门禁（400 行，按原始行数计）。这里只做「给定状态 → 写 DOM」的
// 纯映射，不持有业务状态，便于直接单测。
//
// 纪律（FRONTEND-RULES 铁律 4/5）：只改 class 与文案，**绝不增删节点** —— 这是
// W847「发送前后 .input-side 宽度逐像素一致」不变量的前提。
// ============================================================================
import { t } from '../../i18n';

/** 与 inputbar 共享的两种状态（避免循环依赖，此处只声明形状）。 */
export type ButtonInputMode = 'idle' | 'interject' | 'worker';
export type ButtonSubmitMode = 'steer' | 'queue';

/** 空闲态的发送文案（worker / 插话 / 排队 / 普通发送四选一）。 */
function idleText(mode: ButtonInputMode, lane: ButtonSubmitMode): string {
  if (mode === 'worker') return t('chat.input.send');
  if (mode === 'interject') return lane === 'steer' ? t('chat.input.interject') : t('chat.input.queue');
  return t('chat.input.send');
}

/** 空闲态的发送标题（与文案同源，含快捷键提示）。 */
function idleTitle(mode: ButtonInputMode, lane: ButtonSubmitMode): string {
  if (mode === 'worker') return t('chat.input.sendWorkerTitle');
  if (mode === 'interject') return lane === 'steer' ? t('chat.input.steerTitle') : t('chat.input.queueTitle');
  return t('chat.input.sendTitle');
}

/**
 * W1512：渲染发送/终止两态按钮。
 *
 * 运行中（busy）：.running + 终止文案/标题，并**每次进入都重新解禁** —— 上一次点击
 * 终止时按钮被置为 disabled（防重复取消），若不解禁，下一轮就点不动了。
 * 空闲：去掉 .running，回到发送文案。
 */
export function paintSendButton(
  btn: HTMLButtonElement,
  busy: boolean,
  mode: ButtonInputMode,
  lane: ButtonSubmitMode,
): void {
  btn.classList.toggle('running', busy);
  btn.disabled = false;
  // W1513：按钮只剩图标，**不再写可见文字** —— 语义全部由 title / aria-label 承载
  // （无障碍名必须跟着两态与语言变，这是去掉文字后唯一的语义出口）。
  // 旧夹具若仍有 #btnSendLabel，只在它存在时写，让既有文案断言继续有效。
  const title = busy ? t('chat.input.stopTitle') : idleTitle(mode, lane);
  const label = btn.querySelector<HTMLElement>('#btnSendLabel');
  if (label) label.textContent = busy ? t('chat.input.stop') : idleText(mode, lane);
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

/** 车道切换键（#btnMode）的文案与状态。 */
export function paintModeButton(btn: HTMLButtonElement, lane: ButtonSubmitMode): void {
  const text = lane === 'steer' ? t('chat.input.interject') : t('chat.input.queue');
  const label = btn.querySelector<HTMLElement>('.sl-mode-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
  btn.title = lane === 'steer' ? t('chat.input.modeSteerTitle') : t('chat.input.modeQueueTitle');
  btn.classList.toggle('queue', lane === 'queue');
}
