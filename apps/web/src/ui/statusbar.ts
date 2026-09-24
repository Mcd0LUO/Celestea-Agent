// ============================================================================
// ui/statusbar.ts — 底部状态栏（单一职责）：连接/阶段文本、turn、耗时计时。
// 不感知 turn 生命周期——由 chat.ts 在合适时机调用本模块。
// ============================================================================
import { S } from '../state';
import { fmtTime, need } from '../utils/dom';
import { t } from '../i18n';

const StatusText = need<HTMLElement>('#statusText');
const StatusDot = need<HTMLElement>('#statusDot');
const StatusTurn = need<HTMLElement>('#statusTurn');
const StatusTime = need<HTMLElement>('#statusTime');
/**
 * W1479：live region 节点。用可选查询而非 need()：它是**无障碍增强**，不是
 * 状态栏的功能依赖——缺了它顶多不播报，绝不该让整个状态栏（乃至 app）崩掉。
 * 真实页面里 index.html 一定有这个节点；测试夹具没带它时静默降级。
 */
const StatusLive = document.getElementById('statusLive');

/**
 * W1479：上次播报过的文本。`setStatus` 有 33 个调用点，且同一阶段文本会被重复写入
 * （切会话、重连、重画状态栏都会走到），若每次都写 live region，读屏会把同一句
 * 反复念出来。只在**文本真的变了**时播报。
 */
let announced = '';

/** 播报一句阶段文本（`''` = 清空，不播报）。节点缺失时静默降级。 */
function announce(text: string): void {
  if (StatusLive === null || text === announced) return;
  announced = text;
  // 先清空再写：部分读屏只对「内容发生变化」的节点播报，同值重写会被忽略。
  StatusLive.textContent = '';
  if (text !== '') StatusLive.textContent = text;
}

export function setStatus(text: string, cls?: string): void {
  StatusText.textContent = text;
  StatusDot.className = 'dot' + (cls ? ' ' + cls : '');
  // 视觉状态栏与读屏播报同源：能看见的阶段文本，读屏也应当听得到。
  announce(text);
}

export function setStatusTurn(n: number | null): void {
  StatusTurn.textContent = typeof n === 'number' && n >= 1 ? t('shell.status.turn', { n }) : t('shell.status.turnNone');
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
    if (S.conn === 'online') setStatus(t('shell.status.online'), 'ok');
    else if (S.conn === 'down') setStatus(t('shell.status.reconnecting'), 'err');
  }, ms);
}
