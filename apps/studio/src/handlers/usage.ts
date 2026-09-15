/**
 * `GET /api/usage/ledger` — the aggregate view of the usage ledger (E §3.2.4, W785 P1 ①).
 *
 * The endpoint is a thin, honest SHAPE over the engine seam: the runtime adapter
 * owns the ledger file and the folding (`queryLedger`), this handler only reads
 * the query string, rejects a malformed one, and forwards. There is no host-side
 * aggregation and no cache, so "what the endpoint says" and "what the ledger
 * holds" cannot drift.
 *
 * Two `ok:false` answers are NOT client errors and stay HTTP 200, because the
 * request was understood and the answer is "there is no ledger here":
 *   - `usage ledger unavailable` — the adapter has no ledger capability at all
 *     (an embedded/fake adapter; the `/api/health` style of degradation);
 *   - `usage ledger disabled`     — the real adapter, `CELESTEA_USAGE_LEDGER=off`.
 * The `error` field is registered optional in `contracts/endpoints.json`, which is
 * exactly this case.
 *
 * A MALFORMED query is a 422 like every other handler (`field '<name>' must be …`,
 * `handlers/common.ts` style): `since`/`until` are SECONDS and must be integers
 * (`ts` of a ledger row), `group_by` must be one of session|turn|model|day.
 */

import type { Context, Hono } from "hono";
import type { LedgerGroupBy, LedgerQuery } from "@celestea/runtime";
import { LEDGER_GROUP_BY_VALUES, DEFAULT_LEDGER_GROUP_BY } from "@celestea/runtime";
import { errText } from "../store/result.js";
import type { RouteTable } from "../routes.js";
import { failJson, type Deps } from "./common.js";

/** Parse outcome: either the query, or the 422 message it failed with. */
type QueryRead = { ok: true; value: LedgerQuery } | { ok: false; error: string };

/** An integer query param: absent/empty = null, malformed = the 422 message. */
type IntRead = { ok: true; value: number | null } | { ok: false; error: string };

/** `since`/`until` are epoch SECONDS (the `ts` of a row), never ISO strings. */
function intQuery(c: Context, name: string): IntRead {
  const raw = (c.req.query(name) ?? "").trim();
  if (raw === "") return { ok: true, value: null };
  if (!/^-?\d+$/.test(raw)) return { ok: false, error: `field '${name}' must be an integer` };
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `field '${name}' must be an integer` };
  return { ok: true, value };
}

/** The whole query string; an empty value is the same as an absent one. */
function readQuery(c: Context): QueryRead {
  const session = (c.req.query("session") ?? "").trim();
  const groupBy = (c.req.query("group_by") ?? "").trim();
  if (groupBy !== "" && !LEDGER_GROUP_BY_VALUES.includes(groupBy as LedgerGroupBy)) {
    return { ok: false, error: `field 'group_by' must be one of ${LEDGER_GROUP_BY_VALUES.join(", ")}` };
  }
  const since = intQuery(c, "since");
  if (!since.ok) return { ok: false, error: since.error };
  const until = intQuery(c, "until");
  if (!until.ok) return { ok: false, error: until.error };
  const q: LedgerQuery = { group_by: groupBy === "" ? DEFAULT_LEDGER_GROUP_BY : (groupBy as LedgerGroupBy) };
  if (session !== "") q.session = session;
  if (since.value !== null) q.since = since.value;
  if (until.value !== null) q.until = until.value;
  return { ok: true, value: q };
}

/** The one aggregate endpoint, in contract order. */
export function registerUsage(app: Hono, deps: Deps, table: RouteTable): string[] {
  const route = table.get("get_usage_ledger");
  app.on(route.method, route.honoPath, (c) => {
    const read = readQuery(c);
    if (!read.ok) return failJson(c, 422, read.error);
    const view = deps.runtime.usageLedger;
    if (view === undefined) return c.json({ ok: false, error: "usage ledger unavailable" });
    try {
      return c.json(view.call(deps.runtime, read.value));
    } catch (e) {
      return failJson(c, 500, errText(e));
    }
  });
  return [route.id];
}
