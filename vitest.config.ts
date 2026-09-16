import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@celestea/core": r("./packages/core/src/index.ts"),
      "@celestea/session": r("./packages/session/src/index.ts"),
      "@celestea/llm": r("./packages/llm/src/index.ts"),
      "@celestea/tools": r("./packages/tools/src/index.ts"),
      "@celestea/agent-loop": r("./packages/agent-loop/src/index.ts"),
      "@celestea/workers": r("./packages/workers/src/index.ts"),
      "@celestea/runtime": r("./packages/runtime/src/index.ts"),
      "@celestea/studio": r("./apps/studio/src/index.ts"),
    },
  },
  test: {
    // W781：apps/web（前端）有独立构建与门禁，不进后端 vitest。
    include: ["packages/**/*.test.ts", "apps/studio/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
    // W839 (R3 B8 / W818-P2-1): the weak-reference release case must be able to
    // force a collection. The fork pool inherits this flag, so globalThis.gc
    // exists there and the case observes real collection instead of skipping.
    poolOptions: {
      forks: { execArgv: ["--expose-gc"] },
    },
  },
});
