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
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
