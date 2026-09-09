/**
 * Secret redaction for golden fixtures.
 *
 * HARD REQUIREMENT (P0): no exported fixture may contain an api key / token in
 * cleartext. Redaction is applied to every byte the exporter writes and the
 * result is verified afterwards (see RedactionReport.leaksAfter).
 */

export interface RedactionRule {
  id: string;
  re: RegExp;
  replace: string;
}

export interface RedactionReport {
  replacements: number;
  byRule: Record<string, number>;
  secretsRegistered: number;
  /** Credentials discovered in credential contexts and propagated globally. */
  secretsDiscovered?: number;
  leaksAfter: string[];
}

const PLACEHOLDER = "<REDACTED>";

/** Token shapes that are secrets regardless of where they came from. */
export const DEFAULT_RULES: RedactionRule[] = [
  // NOTE: no leading \b on the token rules. Session logs embed JSON escapes as
  // literal text ("...\nsk-<key>..."), so a preceding "n" is a word character
  // and a \b boundary would silently skip a real key. Over-redaction is the
  // safe direction here.
  { id: "openai-sk", re: /sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, replace: PLACEHOLDER },
  { id: "npm-token", re: /npm_[A-Za-z0-9]{30,}/g, replace: PLACEHOLDER },
  { id: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: PLACEHOLDER },
  { id: "bearer", re: /(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, replace: "$1 " + PLACEHOLDER },
  { id: "authorization-header", re: /("(?:authorization|x-api-key|api[_-]?key)"\s*:\s*")([^"\\]{8,})(")/gi, replace: "$1" + PLACEHOLDER + "$3" },
  { id: "env-assignment", re: /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)("?)([^\s"'\\]{8,})\2/g, replace: "$1$2" + PLACEHOLDER + "$2" },
  { id: "aws-key", re: /AKIA[0-9A-Z]{16}/g, replace: PLACEHOLDER },
  // Cookie / Set-Cookie header values (a live session cookie is a credential).
  { id: "cookie-header", re: /((?:set-)?cookie\s*:\s*)([^\r\n"'\\]{8,})/gi, replace: "$1" + PLACEHOLDER },
  // Service-issued bearer tokens such as `dsh-auth-<token>`.
  { id: "service-auth-token", re: /-auth-[A-Za-z0-9_-]{12,}/g, replace: "-auth-" + PLACEHOLDER },
  // Any `...token=<value>` / `...key=<value>` / `...secret=<value>` assignment
  // with a token-shaped (12+ char) value. Prose like `?token=...` stays intact.
  { id: "credential-assignment", re: /(\b[A-Za-z0-9_]*(?:token|secret|passwd|password|apikey|api_key|auth)[A-Za-z0-9_]*\s*[=:]\s*)([A-Za-z0-9_\-.]{12,})/gi, replace: "$1" + PLACEHOLDER },
  // NOTE: no generic `_authToken=<value>` rule on purpose. Session logs contain
  // sed regex prose such as `s/(_authToken=)[A-Za-z0-9._-]+/.../`; the real
  // npm token is caught by the npm-token rule and by the registered-secret pass
  // (collectKnownSecrets reads ~/.npmrc).
];

export interface Redactor {
  redact(text: string): string;
  report(): RedactionReport;
  /** Secrets discovered in credential contexts while redacting (propagated globally). */
  dynamicSecrets(): string[];
  /** Throws when a registered secret or a generic token shape survives. */
  assertClean(text: string, where: string): void;
}

/**
 * Credential contexts. Any token-shaped (16+ char) substring found inside one
 * of these regions is registered as a dynamic secret and then redacted
 * EVERYWHERE — so an alias such as `T=<token>` (a shell variable holding a
 * cookie value) cannot survive just because its own context is not
 * credential-shaped.
 */
const CREDENTIAL_CONTEXTS: readonly RegExp[] = [
  /(?:set-)?cookie\s*:\s*([^\r\n"'\\]{8,})/gi,
  /authorization\s*:\s*([^\r\n"'\\]{8,})/gi,
  /bearer\s+([A-Za-z0-9._~+/=-]{8,})/gi,
  /\b[A-Za-z0-9_]*(?:token|secret|password|passwd|apikey|api_key|auth)[A-Za-z0-9_]*\s*[=:]\s*("?)([A-Za-z0-9_\-.+/=]{8,})\1/gi,
  /(sk-[A-Za-z0-9_-]{16,})/g,
  /(-auth-[A-Za-z0-9_-]{12,})/g,
  /(npm_[A-Za-z0-9]{30,})/g,
];
const TOKENISH = /[A-Za-z0-9_\-.+/=]{16,}/g;

export function createRedactor(knownSecrets: readonly string[], extraRules: readonly RedactionRule[] = []): Redactor {
  const rules = [...extraRules, ...DEFAULT_RULES];
  const byRule: Record<string, number> = {};
  let replacements = 0;

  // Exact registered secrets first (longest first so overlapping values are safe).
  const secrets = [...new Set(knownSecrets.filter((s) => typeof s === "string" && s.length >= 8))].sort(
    (a, b) => b.length - a.length,
  );

  const dynamic = new Set<string>();

  /** Discover credential-shaped values in the text and register them globally. */
  function discover(text: string): void {
    for (const re of CREDENTIAL_CONTEXTS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        for (let g = 1; g < m.length; g++) {
          const region = m[g];
          if (typeof region !== "string") continue;
          TOKENISH.lastIndex = 0;
          for (const tok of region.matchAll(TOKENISH)) {
            const v = tok[0];
            if (v.length >= 16 && !v.includes(PLACEHOLDER)) dynamic.add(v);
          }
        }
      }
    }
  }

  function redact(text: string): string {
    discover(text);
    let out = text;
    const allSecrets = [...new Set([...secrets, ...dynamic])].sort((a, b) => b.length - a.length);
    for (const secret of allSecrets) {
      if (!out.includes(secret)) continue;
      const parts = out.split(secret);
      const hits = parts.length - 1;
      if (hits > 0) {
        replacements += hits;
        byRule["registered-secret"] = (byRule["registered-secret"] ?? 0) + hits;
        out = parts.join(PLACEHOLDER);
      }
    }
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, (...args: unknown[]) => {
        replacements += 1;
        byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
        // args = [match, g1, g2, ..., offset, string]; $1..$n are the groups.
        const groups = args.slice(1, -2) as Array<string | undefined>;
        let replacement = rule.replace;
        // Descending so $1 cannot clobber the prefix of $10.
        for (let i = groups.length; i >= 1; i--) {
          replacement = replacement.split(`$${i}`).join(groups[i - 1] ?? "");
        }
        return replacement;
      });
    }
    return out;
  }

  function leaksAfter(text: string): string[] {
    // A placeholder is by definition not a leak. Replace it with a SPACE (not
    // an empty string) so removing it cannot glue neighbouring text into a
    // fake match for value-shaped rules like `KEY=<value>`.
    const probe = text.split(PLACEHOLDER).join(" ");
    const leaks: string[] = [];
    for (const secret of secrets) if (probe.includes(secret)) leaks.push("registered-secret");
    for (const secret of dynamic) if (probe.includes(secret)) leaks.push("discovered-secret");
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      if (rule.re.test(probe)) leaks.push(rule.id);
      rule.re.lastIndex = 0;
    }
    return [...new Set(leaks)];
  }

  return {
    redact,
    report(): RedactionReport {
      return { replacements, byRule, secretsRegistered: secrets.length, secretsDiscovered: dynamic.size, leaksAfter: [] };
    },
    dynamicSecrets(): string[] {
      return [...dynamic];
    },
    assertClean(text: string, where: string): void {
      const leaks = leaksAfter(text);
      if (leaks.length > 0) {
        throw new Error(`secret leak in ${where}: ${leaks.join(", ")}`);
      }
    },
  };
}

/**
 * Collect candidate secrets from read-only sources (providers.json keys, an
 * npm auth token, environment values). Never logs them.
 */
export function collectKnownSecrets(input: { providersJson?: unknown; npmrc?: string; env?: NodeJS.ProcessEnv }): string[] {
  const out: string[] = [];
  const providers = input.providersJson;
  if (providers !== null && typeof providers === "object" && "providers" in providers) {
    const list = (providers as { providers?: unknown }).providers;
    if (Array.isArray(list)) {
      for (const p of list) {
        if (p !== null && typeof p === "object" && "api_key" in p) {
          const key = (p as { api_key?: unknown }).api_key;
          if (typeof key === "string" && key.trim().length >= 8) out.push(key);
        }
      }
    }
  }
  if (input.npmrc) {
    for (const m of input.npmrc.matchAll(/_authToken\s*=\s*(\S+)/g)) {
      const tok = m[1];
      if (tok && tok.length >= 8) out.push(tok);
    }
  }
  const env = input.env ?? {};
  for (const name of ["CELESTEA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"]) {
    const v = env[name];
    if (typeof v === "string" && v.trim().length >= 8) out.push(v.trim());
  }
  return out;
}
