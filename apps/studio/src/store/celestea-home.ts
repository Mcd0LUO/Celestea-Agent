/**
 * Store-side view of CELESTEA_HOME (W880).
 *
 * The resolver lives in `@celestea/core` because `@celestea/tools` (the run_code
 * broker + the sandbox that must mount the program directory) needs the SAME
 * order, and the dependency gate forbids `packages/tools` -> `apps/studio`.
 * This module is the single import point for the store layer and re-exports the
 * pure functions; the session/archive/trash/prompt candidate lists live next to
 * them in `session-id.ts`.
 */

export {
  CELESTEA_ARCHIVE_DIR,
  CELESTEA_DATA_DIR,
  CELESTEA_HOME_ENV,
  CELESTEA_PROMPTS_FILE,
  CELESTEA_RUN_CODE_DIR,
  CELESTEA_SESSIONS_DIR,
  CELESTEA_TRASH_DIR,
  CELESTEA_WORKSPACES_DIR,
  celesteaHome,
  workspaceFolderName,
  workspaceHome,
  workspaceSubdir,
} from "@celestea/core";
export type { CelesteaHomeInput } from "@celestea/core";

