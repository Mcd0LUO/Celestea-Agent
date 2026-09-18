import { defineConfig } from 'vite';
import { computeVersion } from '../../scripts/version.mjs';

/**
 * Celestea Studio frontend build.
 * Output: frontend/dist/{index.html, assets/*.js, assets/*.css}
 * The backend serves frontend/dist/ as its static root (shared contract).
 *
 * W887：版本在构建期由 scripts/version.mjs（真源 = git tag）派生，经 define 注入，
 * 不再有手写的版本常量。注入值同时进 /api/health.version（同一个脚本）。
 */
const version = computeVersion();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version.version),
    __APP_COMMITS__: JSON.stringify(version.commitsSinceTag ?? 0),
    __APP_SHA__: JSON.stringify(version.sha),
    __APP_DIRTY__: JSON.stringify(version.dirty),
    __BUILD_TIME__: JSON.stringify(version.buildTime),
  },
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
