// ============================================================================
// statusline/tps.ts — W789：吞吐（tok/s）的「近期均值」。
//
//   问题：会话 inactive（本轮结束 / 未运行）后服务端把 tokens_per_sec 归零或省略，
//   逐字显示会让状态栏从「42.5 tok/s」直接跳成「0.0 tok/s」——读起来像吞吐掉了。
//   做法：只把 **> 0** 的采样记进小环形缓冲（最近 TPS_WINDOW 次）；当前采样无效时
//   显示这几次的均值，并带 `≈` 前缀与 title 说明 —— 诚实：这是近期均值，不是瞬时值。
//
//   纯函数、零 DOM、零 import：采样与文案都在这里算，statusline.ts 只负责写回元素。
//   （格式化函数由调用方传入，单一真源仍是 statusline/icons.ts 的 fixed1。）
// ============================================================================

/** 环形缓冲容量：保留最近 N 次 > 0 的采样。 */
export const TPS_WINDOW = 8;

/** 采样缓冲：不可变值对象（push 返回新对象，便于断言、回放与按会话重置）。 */
export interface TpsSamples {
  readonly values: readonly number[];
  readonly capacity: number;
}

/** 新建空缓冲（容量非法时回落 TPS_WINDOW）。 */
export function createTpsSamples(capacity: number = TPS_WINDOW): TpsSamples {
  const cap = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : TPS_WINDOW;
  return { values: [], capacity: cap };
}

/** 有效采样 = 有限且 > 0（0 / 负数 / NaN / Infinity / 缺失都不算）。 */
export function isTpsSample(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** 记入一次采样：有效值进环形缓冲（超出容量丢最旧），无效值原样返回（不动缓冲）。 */
export function pushTpsSamples(state: TpsSamples, value: unknown): TpsSamples {
  if (!isTpsSample(value)) return state;
  const kept =
    state.values.length >= state.capacity
      ? state.values.slice(state.values.length - state.capacity + 1)
      : state.values.slice();
  kept.push(value);
  return { values: kept, capacity: state.capacity };
}

/** 近期均值；缓冲为空 → null（调用方据此显示占位符，而不是假的 0.0）。 */
export function meanTps(state: TpsSamples): number | null {
  if (state.values.length === 0) return null;
  let sum = 0;
  for (const v of state.values) sum += v;
  return sum / state.values.length;
}

/** 状态栏吞吐单元格的显示模型。 */
export interface TpsDisplay {
  /** 单元格文案（含单位）。 */
  text: string;
  /** 悬停说明（区分「当前采样」与「近期均值」）。 */
  title: string;
  /** true = 显示的是近期均值（文案带 `≈`），需要调用方给可区分标识。 */
  approximate: boolean;
  /** 当前参与均值计算的采样条数。 */
  samples: number;
}

/**
 * 吞吐单元格文案：
 *   · 当前采样有效 → 原样显示（与 W302 以来的行为逐字一致，title 保持空）；
 *   · 无效但缓冲有历史 → `≈ x.x tok/s` + 说明（inactive 时不再显示 0.0）；
 *   · 完全没采过 → `— tok/s` 占位符。
 */
export function tpsDisplay(
  state: TpsSamples,
  current: unknown,
  busy: boolean,
  format: (v: number) => string,
): TpsDisplay {
  if (isTpsSample(current)) {
    return { text: format(current) + ' tok/s', title: '', approximate: false, samples: state.values.length };
  }
  const mean = meanTps(state);
  if (mean === null) {
    return { text: '— tok/s', title: '', approximate: false, samples: 0 };
  }
  const why = busy ? '本轮暂无新采样' : '会话当前未运行';
  return {
    text: '≈ ' + format(mean) + ' tok/s',
    title: why + ' · 显示最近 ' + state.values.length + ' 次采样的均值',
    approximate: true,
    samples: state.values.length,
  };
}
