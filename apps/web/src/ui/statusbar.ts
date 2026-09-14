// ============================================================================
// ui/statusbar.ts — 底部状态栏（单一职责）：连接/阶段文本、turn/step、耗时计时。
// 不感知 turn 生命周期——由 chat.ts 在合适时机调用本模块。
// ============================================================================
import { S } from '../state';
import { fmtTime, need } from '../utils/dom';

const StatusText = need<HTMLElement>('#statusText');
const StatusDot = need<HTMLElement>('#statusDot');
const StatusTurn = need<HTMLElement>('#statusTurn');
const StatusStep = need<HTMLElement>('#statusStep');
const StatusTime = need<HTMLElement>('#statusTime');

export function setStatus(text: string, cls?: string): void {
  StatusText.textContent = text;
  StatusDot.className = 'dot' + (cls ? ' ' + cls : '');
}

export function setStatusTurn(n: number | null): void {
  StatusTurn.textContent = typeof n === 'number' && n >= 1 ? '第 ' + n + ' 轮' : '第 — 轮';
}

export function setStatusStep(n: number | string | null): void {
  StatusStep.textContent = '第 ' + (n && String(n) !== '' ? String(n) : '—') + ' 步';
}

function tickTimer(): void {
  if (!S.streaming) return;
  StatusTime.textContent = fmtTime((Date.now() - S.t0) / 1000);
}

/** 启动（或重置）耗时计时：t0 取当前时刻。 */
export function startElapsedTimer(): void {
  S.t0 = Date.now();
  stopElapsedTimer();
  S.msgTimer = window.setInterval(tickTimer, 500);
  tickTimer();
}

export function stopElapsedTimer(): void {
  if (S.msgTimer !== null) {
    window.clearInterval(S.msgTimer);
    S.msgTimer = null;
  }
}

/**
 * W263：结束一轮计时 —— 停表并**保留最终耗时**（不再归零成 00:00）；
 * 下一轮 startElapsedTimer() 才重置。tickTimer 依赖 S.streaming，
 * 所以这里直接写最后一帧。
 */
export function finishElapsedTimer(): void {
  stopElapsedTimer();
  if (S.t0 > 0) StatusTime.textContent = fmtTime((Date.now() - S.t0) / 1000);
}

// ---- 一次性操作提示（W259 /compact） --------------------------------------------

let flashTimer: number | null = null;

/** 取消尚未到期的短暂提示（新一轮开始时调用，避免覆盖 turn 状态）。 */
export function cancelStatusFlash(): void {
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }
}

/**
 * 短暂提示：立即写入状态栏，ms 后自动恢复连接态文案（W259 /compact 三态提示）。
 * 期间若进入 turn（S.streaming），恢复动作自动让位，不覆盖运行状态。
 */
export function flashStatus(text: string, cls: string, ms = 6000): void {
  cancelStatusFlash();
  setStatus(text, cls);
  flashTimer = window.setTimeout(() => {
    flashTimer = null;
    if (S.streaming) return; // turn 正在跑：状态栏归 turn 生命周期管
    if (S.conn === 'online') setStatus('就绪 · 在线', 'ok');
    else if (S.conn === 'down') setStatus('重连中…', 'err');
  }, ms);
}
