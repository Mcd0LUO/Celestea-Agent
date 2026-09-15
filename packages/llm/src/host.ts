/**
 * Host extraction for the fallback ledger columns (`base_url_host`).
 *
 * Kept in its own module so the fallback decorator can name the host of a
 * target's base_url without importing the HTTP transport, and so the rule lives
 * in exactly one place (the runtime's `ledger-llm.ts` mirrors it for the same
 * column — both are "the host, or null when it is not a URL").
 */

/** Host of a base_url (`api.deepseek.com`), or null when it is not a URL. */
export function hostOf(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl === "") return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
