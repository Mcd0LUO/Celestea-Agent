import { defineConfig } from 'vite';

/**
 * Celestea Studio frontend build.
 * Output: frontend/dist/{index.html, assets/*.js, assets/*.css}
 * The backend serves frontend/dist/ as its static root (shared contract).
 */
export default defineConfig({
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
