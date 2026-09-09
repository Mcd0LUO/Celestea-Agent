/** HTTP error contract helpers (the {ok:false,error} envelope). */

import type { ErrorEnvelope } from "./types.js";

export class StudioError extends Error {
  readonly status: number;
  readonly detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "StudioError";
    this.status = status;
    this.detail = detail;
  }

  toEnvelope(): ErrorEnvelope {
    return { ok: false, error: this.message };
  }
}

/** Shared session-id resolution errors (src/workspaces.rs:611-652). */
export const SessionIdErrors = {
  malformed: (id: string): StudioError =>
    new StudioError(400, `invalid session id '${id}': expected '<workspace>/<session>'`),
  unknownWorkspace: (name: string): StudioError => new StudioError(404, `unknown workspace '${name}'`),
  invalid: (id: string): StudioError => new StudioError(400, `invalid session id '${id}'`),
  unknownSession: (id: string): StudioError => new StudioError(404, `unknown session '${id}'`),
  busy: (what: string): StudioError => new StudioError(409, `turn in progress; ${what} applies between turns`),
} as const;
