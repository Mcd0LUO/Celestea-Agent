/**
 * Host-side field validation shared by several endpoints.
 *
 * The Rust host validates before it hands anything to the engine, and the
 * error strings are contract text (`contracts/endpoints.json` errors[]), so
 * they live here verbatim instead of being re-typed per handler.
 */

/** Model ids are deliberately lax: `[A-Za-z0-9._-:/@]`, at most 128 chars. */
const MODEL_CHARS = /^[A-Za-z0-9._\-:/@]*$/;
export const MODEL_MAX_LEN = 128;

export function validateModelName(model: string): string | null {
  if (model.length > MODEL_MAX_LEN) return `invalid model name: '${model}' exceeds ${MODEL_MAX_LEN} characters`;
  for (const ch of model) {
    if (!MODEL_CHARS.test(ch)) {
      return `invalid model name '${model}': character ${JSON.stringify(ch)} is not allowed (only [A-Za-z0-9._-:/@]; no spaces, brackets or control characters)`;
    }
  }
  return null;
}

const PROMPT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function validatePromptId(id: string): string | null {
  return PROMPT_ID.test(id) ? null : "prompt id must be 1-128 chars of [A-Za-z0-9._-]";
}

export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** `parse_effort`: "" / "off" (case-insensitive) clears the effort. */
export function parseEffort(raw: string | null | undefined): string | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === "" || v.toLowerCase() === "off") return null;
  return v;
}
