/**
 * Prompt template rules (`src/prompts.rs:126-165,472-560`).
 *
 * `{{name}}` is the ONLY syntax: the name is trimmed, there are no aliases and
 * no escaping. Validation and rendering share one scanner so a template can
 * never validate under one rule and render under another.
 */

/** `PROMPT_MAX_LEN`. */
export const PROMPT_MAX_LEN = 8192;
/** `ORDER_FALLBACK`: a section that is new to a scope lands after the builtins. */
export const ORDER_FALLBACK = 2000;

/** The whitelist; anything else is `undefined prompt variable '{{name}}'`. */
export const PROMPT_VARS = [
  "model",
  "provider",
  "base_url",
  "workspace",
  "workspace_dir",
  "session",
  "tools",
  "context_window",
  "max_output_tokens",
  "date",
] as const;

export type PromptVar = (typeof PROMPT_VARS)[number];
export type PromptVars = Partial<Record<PromptVar, string>>;

export interface TemplateError {
  error: string;
}

interface Token {
  literal: string;
  name?: string;
}

/** Split a template into literals and `{{var}}` slots (never throws). */
function scan(template: string): { tokens: Token[]; unclosed: boolean } {
  const tokens: Token[] = [];
  let rest = template;
  for (;;) {
    const open = rest.indexOf("{{");
    if (open < 0) {
      tokens.push({ literal: rest });
      return { tokens, unclosed: false };
    }
    const close = rest.indexOf("}}", open + 2);
    if (close < 0) {
      tokens.push({ literal: rest.slice(0, open) });
      return { tokens, unclosed: true };
    }
    tokens.push({ literal: rest.slice(0, open) });
    tokens.push({ literal: "", name: rest.slice(open + 2, close).trim() });
    rest = rest.slice(close + 2);
  }
}

/** Byte length of the UTF-8 encoding (the cap is in BYTES, not chars). */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Validate one template against the cap, the whitelist and closure. */
export function validateTemplate(template: string): TemplateError | null {
  const bytes = byteLength(template);
  if (bytes > PROMPT_MAX_LEN) return { error: `template exceeds the ${PROMPT_MAX_LEN} byte cap (${bytes} bytes)` };
  const { tokens, unclosed } = scan(template);
  if (unclosed) return { error: "unclosed '{{' in template" };
  for (const t of tokens) {
    if (t.name === undefined) continue;
    if (!(PROMPT_VARS as readonly string[]).includes(t.name)) {
      return { error: `undefined prompt variable '{{${t.name}}}'` };
    }
  }
  return null;
}

/** Render `{{var}}` with the given values; a missing value renders empty. */
export function renderTemplate(template: string, vars: PromptVars): string {
  const { tokens } = scan(template);
  let out = "";
  for (const t of tokens) {
    if (t.name === undefined) {
      out += t.literal;
      continue;
    }
    out += vars[t.name as PromptVar] ?? "";
  }
  return out;
}

/** Truncate to the byte cap on a char boundary (Rust `truncate_prompt`). */
export function truncateToCap(text: string): string {
  if (byteLength(text) <= PROMPT_MAX_LEN) return text;
  let acc = "";
  for (const ch of text) {
    if (byteLength(acc + ch) > PROMPT_MAX_LEN) break;
    acc += ch;
  }
  return acc;
}
