/**
 * Studio process entry (CLI entry point: console output is allowed here).
 *
 * Source default port is 3778 (so a throwaway instance can run next to the
 * production one on 3777); production sets STUDIO_TS_PORT=3777 via
 * scripts/run-studio-ts.sh. Nothing here touches production data files unless
 * the caller points the path env vars at them.
 *
 * H: the bootstrap itself (banner + W742 graceful teardown) lives in
 * `server.ts` so the `celestea` CLI drives the SAME code; this file only pins
 * the historical source-checkout defaults and installs the signal handlers.
 */

import { verifyContractsAtStartup } from "@celestea/core";
import { startStudioServer } from "./server.js";

const port = Number.parseInt(process.env["STUDIO_TS_PORT"] ?? "3778", 10);
const hostname = process.env["STUDIO_TS_BIND"] ?? "127.0.0.1";

/**
 * W807 -- explicit contract gate. The frozen-count contract files are read and
 * validated ONCE here, before the port is bound, and the validated snapshot is
 * cached for the whole process lifetime. A drifted contracts/*.json refuses the
 * boot loudly (file / expected / actual) instead of booting into a later 500.
 */
try {
  verifyContractsAtStartup();
} catch (e) {
  console.error("[celestea-studio-ts] FATAL: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

const server = startStudioServer({ port, hostname });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop(signal);
  });
}
