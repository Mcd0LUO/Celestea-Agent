/**
 * `celestea web` (H) — start the studio and (by default) open the browser.
 *
 * The HTTP server itself is `startStudioServer` from `@celestea/studio`, so
 * this command owns only: the data-root paths, the startup banner (sandbox +
 * first-run guidance), the browser hand-off, and the signal wiring.
 */

import { verifyContractsAtStartup } from "@celestea/core";
import { isLoopbackBind, loadStudioConfig, startStudioServer, type StudioServerHandle, type StudioServerOptions } from "@celestea/studio";
import type { WebOptions } from "./args.js";
import { openBrowser } from "./open-browser.js";
import { cliPaths, firstRunGuidance } from "./paths.js";
import { sandboxStartupNote } from "./sandbox-note.js";

export interface RunWebDeps {
  env?: NodeJS.ProcessEnv;
  /** Injected server start (tests); default: the real `startStudioServer`. */
  start?: (options: StudioServerOptions) => StudioServerHandle;
  /** Injected opener (tests); default: the real `openBrowser`. */
  open?: typeof openBrowser;
  /** Injected contract gate (tests); default: the real one. */
  verify?: () => void;
  /** Injected signal registrar (tests); default: `process.on`. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

export interface RunWebResult {
  handle: StudioServerHandle;
  url: string;
  guidance: string[];
}

/** Start the server; returns the handle plus the lines already printed. */
export function runWeb(options: WebOptions, deps: RunWebDeps = {}): RunWebResult {
  const env = deps.env ?? process.env;
  const paths = cliPaths(env);
  const verify = deps.verify ?? verifyContractsAtStartup;
  verify();

  const config = loadStudioConfig({
    env,
    paths: { workspacesFile: paths.workspacesFile, providersFile: paths.providersFile, promptsFile: paths.promptsFile },
    // H-security: --token wins; else CELESTEA_AUTH_TOKEN. A non-loopback bind
    // with neither is refused inside startStudioServer (never a silent hole).
    ...(options.token === undefined ? {} : { authToken: options.token }),
  });
  const start = deps.start ?? startStudioServer;
  const handle = start({ port: options.port, hostname: options.bind, config, env });
  const url = `http://${options.bind === "0.0.0.0" ? "127.0.0.1" : options.bind}:${handle.port}/`;

  console.log("[celestea] data root: " + paths.home);
  console.log("[celestea] " + sandboxStartupNote({ env }));
  if (config.authToken !== null) {
    console.log("[celestea] api token: required on every /api/* request except /api/health");
    // Never echo the secret: print the bootstrap URL with a placeholder.
    const shown = options.bind === "0.0.0.0" || options.bind === "::" ? "127.0.0.1" : options.bind;
    console.log(`[celestea] browser: open http://${shown}:${handle.port}/auth/token?token=<your-token> once to sign in`);
    if (!isLoopbackBind(options.bind)) {
      console.log("[celestea] WARNING: non-loopback + plain HTTP — the token and its cookie travel in cleartext; put TLS (nginx) in front for anything beyond a trusted network");
    }
  }
  // The composed engine injects the providers.json key into this env in memory;
  // reading the env AFTER start therefore reflects both sources, without ever
  // printing the secret.
  const hasApiKey = (env[config.apiKeyEnv] ?? "").trim() !== "";
  const guidance = firstRunGuidance(paths, hasApiKey);
  for (const line of guidance) console.log("[celestea] " + line);

  if (options.open) {
    const opened = (deps.open ?? openBrowser)(url);
    console.log(opened.opened ? `[celestea] opened ${url}` : `[celestea] could not open a browser (${opened.reason}); open ${url}`);
  } else {
    console.log("[celestea] open " + url);
  }

  const onSignal = deps.onSignal ?? ((signal, handler) => void process.on(signal, handler));
  for (const signal of ["SIGINT", "SIGTERM"] as const) onSignal(signal, () => void handle.stop(signal));
  return { handle, url, guidance };
}
