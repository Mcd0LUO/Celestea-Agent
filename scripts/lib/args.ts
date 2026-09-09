/** Minimal flag parser (no dependency). */
export interface Args {
  flags: Map<string, string | true>;
  positional: string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { flags, positional };
}

export function str(args: Args, key: string, fallback: string): string {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : fallback;
}

export function num(args: Args, key: string, fallback: number): number {
  const v = args.flags.get(key);
  if (typeof v !== "string") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) ? n : fallback;
}

export function bool(args: Args, key: string): boolean {
  return args.flags.get(key) === true;
}
