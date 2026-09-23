// ============================================================================
// statusline/dock.ts — W1462：**胶囊之外**贴底信息行的渲染收口。
//
// 背景：用户要求「会话名 · 空闲 · tok/s · 第几轮 放到消息框胶囊外的底部平铺，灰色不显眼」。
// tok/s（#slTps）/ 缓存（#slCache）/ 步数（#slSteps）随之从 #statusline 搬进 #statusbar，
// 于是出现两个只有这里才知道的事实，必须**同一个模块**持有，否则迟早对不上：
//   ① 这三个节点的宿主不再是 #statusline ⇒ 取节点不能再用 this.el 作用域
//      （真实事故：作用域没放开 → need() 抛 missing element → 整页白屏）；
//   ② /api/status 不可用时的降对比（.sl-stale）要打到**实际宿主**上，
//      否则这三项在 stale 态看起来「是活的」。
//
// 本模块只做「取节点 + 写值 + 降对比」，不持有轮询/快照（那仍在 statusline.ts）。
// ============================================================================
import { fixed1 } from './icons';
import { renderCacheCell } from './ring';
import { createTpsSamples, pushTpsSamples, tpsDisplay, type TpsSamples } from './tps';
import { t } from '../i18n';
import type { StatusSnapshot } from '../types';

/** 贴底信息行宿主（#statusbar）；老夹具没有该节点时为 null（安静降级，不 throw）。 */
function dockHost(): HTMLElement | null {
  return document.getElementById('statusbar');
}

export class DockCells {
  /** W789：吞吐的近期采样缓冲（按会话隔离，跨切换保留）。 */
  private readonly tpsCache = new Map<string, TpsSamples>();

  /** 三个数值格的宿主；缺一即抛（id 是运行时真源，不允许静默缺失）。 */
  private readonly tpsEl = needCell('slTps');
  private readonly cacheEl = needCell('slCache');
  private readonly stepsEl = needCell('slSteps');

  /** 写一轮快照：tok/s（含近期均值回退）、缓存命中、步数。 */
  render(snapshot: StatusSnapshot, session: string): void {
    // W789：吞吐 —— 有效采样原样显示；服务端给 0/缺省（会话 inactive）时显示最近
    // N 次采样的均值并带 `≈` 前缀，不再从「42.5 tok/s」直接跳成「0.0 tok/s」。
    const samples = pushTpsSamples(this.samplesFor(session), snapshot.tokens_per_sec);
    this.tpsCache.set(session, samples);
    const tps = tpsDisplay(samples, snapshot.tokens_per_sec, snapshot.busy === true, fixed1);
    this.tpsEl.textContent = tps.text;
    this.tpsEl.title = tps.title;
    this.tpsEl.setAttribute('aria-label', t('statusline.tpsAria', { text: tps.text }));

    // W263 缓存命中率：只改文本（铁律 1/2/5——不重建 DOM，不重渲染背景）
    renderCacheCell(this.cacheEl, snapshot.usage);

    const steps = snapshot.steps;
    this.stepsEl.textContent = typeof steps === 'number' && steps >= 1 ? t('statusline.steps', { n: steps }) : t('statusline.stepsNone');
    this.stepsEl.setAttribute('aria-label', this.stepsEl.textContent);
  }

  /**
   * /api/status 不可用：整条降低对比。宿主 = 贴底信息行（这三项已不在 #statusline）。
   * on=false 时复位。宿主缺失（老夹具）⇒ 安静 no-op。
   */
  setStale(on: boolean): void {
    dockHost()?.classList.toggle('sl-stale', on);
  }

  /** W789：本会话的吞吐采样缓冲（首次访问即建，按会话隔离）。 */
  private samplesFor(id: string): TpsSamples {
    const cur = this.tpsCache.get(id);
    if (cur) return cur;
    const fresh = createTpsSamples();
    this.tpsCache.set(id, fresh);
    return fresh;
  }
}

/** 取一个贴底信息行里的数值格（document 作用域 —— 它们不在 #statusline 内）。 */
function needCell(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error('missing element: #' + id);
  return n;
}
