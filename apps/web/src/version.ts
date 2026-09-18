// ============================================================================
// version.ts — 前端构建版本标识（W887：构建期注入，不再手写）：
//   真源 = git tag（scripts/version.mjs 在 vite 构建期算好，经 vite.config.ts
//   的 define 注入）。本文件只读注入值；构建未注入时（裸 vite）回落 'dev'，
//   绝不会渲染成 undefined。防漂移门禁见 tests/w887-version.test.ts：
//   本文件不得再出现形如 x.y.z 的版本字面量。
// ============================================================================

declare const __APP_VERSION__: string;
declare const __APP_COMMITS__: number;
declare const __APP_SHA__: string;
declare const __APP_DIRTY__: boolean;
declare const __BUILD_TIME__: string;

/** 注入值存在则用，否则回落（裸 vite / 未 define 时的兜底）。 */
function injected<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** 版本号（去 v 前缀）；未注入时 'dev'。 */
export const APP_VERSION: string = injected(typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined, 'dev');

/** 距最近 tag 的提交数；恰好落在 tag 上为 0。 */
export const APP_COMMITS: number = injected(typeof __APP_COMMITS__ === 'number' ? __APP_COMMITS__ : undefined, 0);

/** 短 sha（例如 00de6ab）；拿不到时为空串。 */
export const APP_SHA: string = injected(typeof __APP_SHA__ === 'string' ? __APP_SHA__ : undefined, '');

/** 工作区是否有未提交改动。 */
export const APP_DIRTY: boolean = injected(typeof __APP_DIRTY__ === 'boolean' ? __APP_DIRTY__ : undefined, false);

/** 构建时间（ISO 时间）；未注入时 'dev'。 */
export const BUILD_TIME: string = injected(typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : undefined, 'dev');

/** hover 里的全量 describe（恰好落在 tag 上 = vX.Y.Z）。 */
export function describeLabel(): string {
  const distance = APP_COMMITS > 0 ? '-' + APP_COMMITS + '-g' + APP_SHA : '';
  return 'v' + APP_VERSION + distance;
}

/** 左上角短标签：Studio v + 版本（有提交数时追加 +N；dirty 加 *）。 */
export function versionLabel(): string {
  const distance = APP_COMMITS > 0 ? '+' + APP_COMMITS : '';
  return 'Studio v' + APP_VERSION + distance + (APP_DIRTY ? '*' : '');
}
