/**
 * W892 — shared test helpers for platform-sensitive GRANT rules.
 *
 * Kept in its own module (not in `grants.test.ts`) so that file stays inside the
 * 400-line module cap rather than the cap being loosened.
 */
import { existsSync } from 'node:fs';

/**
 * A real, existing `$HOME` that is NOT an ancestor of `dataDir`.
 *
 * WHY: `rejectRoot` checks "covers the studio data directory" BEFORE "is $HOME".
 * On Linux the data dir (/tmp/...) never lies inside $HOME, so an entry equal to
 * $HOME reaches the `$HOME` rule. On Windows the data dir IS under
 * %USERPROFILE%\\AppData\\Local\\Temp, so the FIRST rule fires and the warning
 * says "studio data directory" instead. BOTH reject — the entry is refused either
 * way — so a test asserting the `$HOME` wording must use a home that is not on the
 * data dir's ancestor chain. `makeSibling` creates an existing sibling directory.
 */
export function independentHome(
  dataDir: string,
  home: string,
  makeSibling: (name: string) => string,
  contains: (child: string, root: string) => boolean,
): string {
  if (home !== '' && existsSync(home) && !contains(dataDir, home)) return home;
  return makeSibling('home');
}
