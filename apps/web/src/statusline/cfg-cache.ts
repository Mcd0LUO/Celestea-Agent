// ============================================================================
// statusline/cfg-cache.ts — W778：配置（GET /api/config）复用缓存。
//
//   背景：/api/config 实测 0.7-1.5ms，但每次打开模型/档位选择器都要等一次网络
//   往返，期间先渲染「加载清单中…」——观感上是「每次打开都要加载一会」。
//   本模块把最近一次 ConfigInfo 记忆在模块级：
//     · 缓存命中 → 调用方**同步**渲染清单（零等待），随后后台 revalidate 校验一次；
//     · 缓存缺失（冷启动）→ 行为与今天逐字一致：等首次拉取，再渲染。
//   失效：配置保存成功后各处已派发 `studio:config-saved`（picker / 状态栏挂起重试 /
//   设置页保存），这里注册**一次**监听（幂等）把缓存作废，下次读取重新拉取。
//
//   铁律：本模块只管数据，不碰 DOM；渲染侧仍走「离屏构建 + 单次替换」（铁律 1）。
// ============================================================================
import { api } from '../api';
import type { ConfigInfo } from '../types';

/** 最近一次成功读取到的配置；null = 无缓存（冷启动）。 */
let cached: ConfigInfo | null = null;
/** 进行中的首次拉取：并发调用合并成一次请求（避免连点弹出两次请求）。 */
let inflight: Promise<ConfigInfo> | null = null;
/** 失效监听是否已注册（幂等）。 */
let bound = false;

/** 注册一次 `studio:config-saved` 失效监听；重复调用无副作用。 */
function bindOnce(): void {
  if (bound) return;
  bound = true;
  window.addEventListener('studio:config-saved', invalidateConfig);
}

/** 同步取缓存：非 null 才能同步渲染首屏（缓存命中的判据）。 */
export function peekConfig(): ConfigInfo | null {
  return cached;
}

/** 作废缓存（保存成功后由事件触发；也可显式调用）。 */
export function invalidateConfig(): void {
  cached = null;
}

/**
 * 取配置：有缓存直接返回；否则拉一次并写入缓存。
 * 并发调用合并成同一次请求（inflight 去重）。
 */
export async function loadConfigCached(): Promise<ConfigInfo> {
  bindOnce();
  if (cached !== null) return cached;
  if (inflight !== null) return inflight;
  const p = api
    .config()
    .then((cfg) => {
      cached = cfg;
      return cfg;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = p;
  return p;
}

/** 总是拉取并更新缓存（后台校验 / 显式「重新载入」）。 */
export async function revalidateConfig(): Promise<ConfigInfo> {
  bindOnce();
  const cfg = await api.config();
  cached = cfg;
  return cfg;
}
