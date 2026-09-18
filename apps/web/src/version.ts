// ============================================================================
// version.ts — 前端构建版本标识（W887：构建期注入，不再手写）：
//   真源 = git tag。scripts/version.mjs 在 vite 构建期算好，经 vite.config.ts
//   注入 index.html 的 window.__CELESTEA_BUILD__（**不进 JS bundle**：墙钟
//   buildTime 进 JS 会让同提交的两次构建字节不同、产物体积棘轮变成随机门禁）。
//   本文件只从该全局读元数据；读不到（裸 vite / 非浏览器 / 未注入）一律回落
//   'dev'/0/''/false，绝不会是 undefined。防漂移门禁见
//   tests/w887-version.test.ts 与 apps/web/tools/check-version.mjs：
//   本文件不得再出现形如 x.y.z 的版本字面量。
// ============================================================================

/** The metadata payload injected by vite.config.ts. */
interface BuildMeta {
  version?: string;
  commits?: number;
  sha?: string;
  dirty?: boolean;
  buildTime?: string;
}

// W887: the ?? fallbacks ARE the degradation ('dev'/0/''/false) — absent or
// undefined metadata can never render as undefined.
const B: BuildMeta = (globalThis as unknown as { __CELESTEA_BUILD__?: BuildMeta }).__CELESTEA_BUILD__ ?? {};

/** 版本号（去 v 前缀）；未注入时 'dev'。 */
export const APP_VERSION: string = B.version ?? 'dev';

/** 距最近 tag 的提交数；恰好落在 tag 上为 0。 */
export const APP_COMMITS: number = B.commits ?? 0;

/** 短 sha（例如 00de6ab）；拿不到时为空串。 */
export const APP_SHA: string = B.sha ?? '';

/** 工作区是否有未提交改动。 */
export const APP_DIRTY: boolean = B.dirty ?? false;

/** 构建时间（ISO 时间）；未注入时 'dev'。 */
export const BUILD_TIME: string = B.buildTime ?? 'dev';

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
