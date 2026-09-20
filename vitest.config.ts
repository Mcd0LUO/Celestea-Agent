import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  "@celestea/core": r("./packages/core/src/index.ts"),
  "@celestea/session": r("./packages/session/src/index.ts"),
  "@celestea/llm": r("./packages/llm/src/index.ts"),
  "@celestea/tools": r("./packages/tools/src/index.ts"),
  "@celestea/agent-loop": r("./packages/agent-loop/src/index.ts"),
  "@celestea/workers": r("./packages/workers/src/index.ts"),
  "@celestea/runtime": r("./packages/runtime/src/index.ts"),
  "@celestea/studio": r("./apps/studio/src/index.ts"),
};

/**
 * W847 (test isolation): the ONLY test files that make live HTTP calls to the one
 * running backend (default 127.0.0.1:3777, overridable via CELESTEA_E2E_BASE).
 * Verified by grep: every other test uses an in-process app/harness.
 *
 * They mutate the server's ONE global active_session, so if two of them run at the
 * same time the slower one restores an active that the faster one already deleted
 * (404) and the "active_session must be null" assertion is clobbered by the other
 * file's activate. Run them one at a time; keep everything else parallel.
 *
 * W862 (explicit opt-in — a real incident): running the root `pnpm check` used to hit
 * the LIVE 3777 service, and the multimodal file's deliberate IMAGE_UNSUPPORTED case
 * (a text-only test model fed an image) broadcast a bogus downgrade notice into the
 * user's Studio window. Therefore the default gate must NEVER touch the online service:
 * the real-backend suite only runs when CELESTEA_E2E=1 is set explicitly.
 *
 * - Opted in: the three files run here, serial (fileParallelism=false), assertions intact.
 * - Not opted in: this project collects no files; the three files are instead collected
 *   by the `unit` project and end as a VISIBLE skip (never silently disappear), each
 *   printing the opt-in command. A missing/empty project is not an error as long as the
 *   run has tests, and the in-file `describe.skipIf` gate is the belt-and-braces backstop
 *   so no code path — probe included — can reach 3777 without the switch.
 */
const E2E = process.env.CELESTEA_E2E === "1";
const REAL_BACKEND = [
  "tests/archive-panel-real-backend.test.ts",
  "tests/multimodal-attachments-real-backend.test.ts",
  "tests/session-gone-real-backend.test.ts",
];
/** 未选入时的占位：文件不存在 ⇒ real-backend project 零文件（选入才装载真实套件）。 */
const REAL_BACKEND_OFF = ["tests/__real-backend-disabled-until-CELESTEA_E2E__.test.ts"];

export default defineConfig({
  test: {
    // W839 (R3 B8 / W818-P2-1): the weak-reference release case needs --expose-gc.
    // Vitest 5 removed poolOptions; execArgv is a top-level (and inherited) option.
    execArgv: ["--expose-gc"],
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          setupFiles: [r("./vitest.setup.ts")],
          // W895：前端（apps/web）此前**零单测**，只靠 tsc + tools/check-*.mjs。
          // 增强缝是行为逻辑（注册/注销/幂等/回滚），静态门禁证明不了 —— 给它一个测试面。
          // DOM 用例在文件头用 `// @vitest-environment jsdom` 单独切环境。
          include: ["packages/**/*.test.ts", "apps/studio/**/*.test.ts", "apps/cli/**/*.test.ts", "apps/web/**/*.test.ts", "tests/**/*.test.ts"],
          // 未选入 E2E 时把三个真实后端文件收在这里（它们自我 skip 并打印选入口令），
          // 于是默认跑看到的是**可见的 skip**；选入后才交还给 real-backend project。
          exclude: ["**/node_modules/**", "**/dist/**", ...(E2E ? REAL_BACKEND : [])],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "real-backend",
          setupFiles: [r("./vitest.setup.ts")],
          // W862：只有显式选入（CELESTEA_E2E=1）才装载这三个文件；默认零文件，
          // 文件在 unit project 里可见跳过（见上方 REAL_BACKEND 注释）。
          include: E2E ? [...REAL_BACKEND] : [...REAL_BACKEND_OFF],
          // One live server, one active_session: fileParallelism=false runs the
          // three files one at a time (everything else keeps the parallel pool).
          pool: "forks",
          fileParallelism: false,
          testTimeout: 120_000,
        },
      },
    ],
  },
});
