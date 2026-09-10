/**
 * Runtime-owned errors. Machine-readable first: callers branch on `status`
 * (HTTP-shaped, via core's `StudioError`) or on `kind`, never on prose
 * (ARCHITECTURE.md §6.2).
 */

import { StudioError } from "@celestea/core";

/**
 * A second `runTurn` while one is in flight. The engine has a single
 * concurrency slot per Runtime generation (Rust `AppState::busy`): a turn is
 * either running or not, and a conflicting start is a 409, never a queue.
 */
export class TurnBusyError extends StudioError {
  readonly kind = "turn_busy";

  constructor(what = "cancel/rebind/config") {
    super(409, `turn in progress; ${what} applies between turns`);
    this.name = "TurnBusyError";
  }
}

/** The generation was shut down / released: its handles must not be used again. */
export class RuntimeReleasedError extends StudioError {
  readonly kind = "runtime_released";

  constructor(what = "the runtime generation was shut down or released") {
    super(410, `runtime released: ${what}`);
    this.name = "RuntimeReleasedError";
  }
}

/** Composition failed: a required seam was never provided by any plugin. */
export class ComposeError extends Error {
  readonly kind = "compose";

  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}
