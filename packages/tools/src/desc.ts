/**
 * The `desc` UI-label parameter (W779 T1).
 *
 * EVERY tool takes one optional `desc` string: a one-line label describing what
 * this particular call is doing, which the UI shows on the tool card. It is
 * pure presentation:
 *   - no executor reads it (nothing but the specs mentions `desc`), so a call
 *     behaves exactly the same with or without it;
 *   - the schema declares it as a plain optional `string` — deliberately NO
 *     `maxLength`, because the 80-character budget is a display concern and the
 *     dispatch validator is a frozen subset (`schema.ts`); a long label must
 *     never turn a working call into `toolargs: code=schema`.
 *
 * The text is shared so the 7 builtin specs and `contracts/tools.json` cannot
 * drift word by word; `tests/contract-parity.test.ts` compares them all.
 */

/** The one-line contract text of the `desc` parameter. */
export const DESC_DESCRIPTION =
  "Optional one-line label (max 80 chars) describing what this call is doing; shown on the tool card in the UI. Keep it short.";

/** A fresh `desc` property schema (never share the object: specs are values). */
export function descParam(): Record<string, unknown> {
  return { type: "string", description: DESC_DESCRIPTION };
}
