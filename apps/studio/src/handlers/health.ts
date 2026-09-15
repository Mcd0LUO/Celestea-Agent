/**
 * Health / status / tools — `src/main.rs:860-869`, `src/api.rs:40-83`.
 *
 * All three are always 200 with no error branch. `bind` is the CONSTANT
 * `DEFAULT_BIND`: it deliberately does not follow STUDIO_BIND.
 *
 * W513: `GET /api/status` reads ONE session's trackers — `?session=<id>`, or the
 * active session when the query is absent — and reports that session's `busy`
 * slot alongside the (unchanged) 7 statusline fields.
 *
 * W729: `/api/status` adds `mode` (the queried session's mode) and
 * `/api/health` advertises `capabilities.session_mode = true` (P0: the mode is
 * fixed at creation, so the capability is a read-only announcement).
 *
 * W516: `/api/health` advertises `capabilities.grants = true` (the frontend
 * hides the permission panel when it is not exactly `true`, so the retired Rust
 * backend cannot show a panel that does nothing), and `/api/status` adds
 * `grants_active` — the CAP NAMES in force for that session, never the paths
 * (an operator can see which session is widened without leaking a filesystem
 * layout into a status poll).
 *
 * W785 (E-P1, capability 3 ②): `/api/status` adds `cost` — the session's
 * engine-side cost estimate read from the append-only usage ledger (§3.2.4). The
 * key is a PURE ADDITION and is present ONLY when the adapter has a ledger, so a
 * host with the ledger switched off answers exactly the pre-W785 body and an old
 * client never receives a `null` it would have to interpret.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import type { LedgerCostBlock } from "@celestea/runtime";
import { emptyRecoveryView } from "../runtime/recovery-view.js";
import type { FallbackStatusView } from "../runtime/fallback-host.js";
import { activeSession, modeOfSession, type Deps } from "./common.js";
import { baseUrlOf } from "./config-shape.js";
import { effectiveGrantsOf, grantsActiveCaps } from "../runtime/engine-grants.js";
import { nowSec } from "../store/grants-service.js";

export function registerHealth(app: Hono, deps: Deps, table: RouteTable): string[] {
  const health = table.get("get_health");
  app.on(health.method, health.honoPath, (c) =>
    c.json({
      ok: true,
      name: deps.config.name,
      model: deps.runtime.profile().model,
      base_url: baseUrlOf(deps),
      bind: deps.config.bind,
      // W725: `context: true` gates the context-ring entry point; a client
      // that does not see exactly `true` degrades to no context viewer.
      // W729: `session_mode: true` gates the (P1) mode selector; a client that
      // does not see exactly `true` must not offer to set a session mode.
      capabilities: { grants: true, context: true, session_mode: true },
    }),
  );

  const status = table.get("get_status");
  app.on(status.method, status.honoPath, (c) => {
    const asked = c.req.query("session");
    const session = asked === undefined || asked === "" ? activeSession(deps) : asked;
    const line = deps.runtime.statusline(session);
    return c.json({
      ...line,
      session,
      // W729: the mode of the QUERIED session (absent = standard, K8).
      mode: modeOfSession(deps, session),
      busy: deps.runtime.isBusy(session),
      grants_active: activeGrantCaps(deps, session),
      ...costField(deps, session),
      // E §1.3 P1 ② (W787): the session's checkpoint view. A PURE ADDITION, always
      // present (an adapter without checkpointing answers the empty block), so a
      // client can rely on the key existing without inventing a default.
      recovery: recoveryBlockOf(deps, session),
      // E §4.2.3 #4 (W785): `model` stays the CONFIGURED value; these two are
      // the only place a downgrade shows. Pure additions, always present.
      effective_model: fallbackView(deps, session)?.effective_model ?? line.model,
      fallback: fallbackView(deps, session) ?? {
        active: false,
        chain: [],
        effective_model: null,
        last_reason: null,
        targets: [],
        problems: [],
      },
    });
  });

  const tools = table.get("get_tools");
  app.on(tools.method, tools.honoPath, (c) => c.json({ tools: deps.runtime.tools() }));

  return [health.id, status.id, tools.id];
}

/** E §4.2.3 #4 (W785): the fallback view of this session (null = not armed). */
function fallbackView(deps: Deps, session: string | null): FallbackStatusView | null {
  return deps.runtime.fallbackView?.(session) ?? null;
}

/** E §1.3 P1 ②: the `recovery` block of the queried session (never a new endpoint). */
function recoveryBlockOf(deps: Deps, session: string | null): Record<string, unknown> {
  return { ...(deps.runtime.recoveryView?.(session) ?? emptyRecoveryView(session)) };
}

/**
 * W785: the optional `cost` key (see the header). `{}` = no ledger / no estimate,
 * which keeps the field truly optional instead of a `cost: null` placeholder.
 */
function costField(deps: Deps, session: string | null): { cost?: LedgerCostBlock } {
  const cost = deps.runtime.costBlock?.(session);
  return cost === undefined || cost === null ? {} : { cost };
}

/** Cap names in force for the session (never paths) — §5.7. */
function activeGrantCaps(deps: Deps, session: string | null): string[] {
  const resolved = session === null ? null : deps.sessions.resolve(session);
  if (resolved === null || !resolved.ok) return [];
  const dir = resolved.value.dir;
  return grantsActiveCaps(effectiveGrantsOf(dir, deps.grants.env, nowSec(deps.grants)).grants);
}
