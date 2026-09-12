/**
 * W747 compat shim — this module moved to the runtime's host layer:
 * `packages/runtime/src/host/engine-session.ts` (exported as `@celestea/runtime`).
 *
 * The file is kept (and its export list is unchanged) so every existing
 * `./engine-session.js` / `../runtime/engine-session.js` import keeps working:
 * a caller migrates by deleting its import, not by editing the engine.
 */

export {
  PROCESS_CHECKPOINT_IDENTITY,
  SESSION_LOG_ID,
  SESSION_LOG_NAME,
  bindingFor,
  closeLog,
  memoryBindingFor,
  openSessionLog,
  workerSessionPrefix,
  type CheckpointWiring,
  type SessionTarget,
} from "@celestea/runtime";
