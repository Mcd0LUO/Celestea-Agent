/**
 * W892 — the MECHANISM behind the `.mts` program extension.
 *
 * `run_code` writes its assembled program into `<CELESTEA_HOME>/.../run-code`. If
 * any ANCESTOR directory holds a `package.json` with no `"type"` field, Node
 * treats a `.ts` file there as ambiguous and prints:
 *
 *   [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///... is not
 *   specified and it doesn't parse as CommonJS. Reparsing as ES module...
 *
 * That warning goes to stderr, which the broker CAPTURES as the program's stderr
 * and renders — so byte-exact assertions saw it and users got noise. On Windows
 * this is the normal case (the temp dir is under %USERPROFILE%).
 *
 * The fix is the extension: `.mts` is unconditionally an ES module, so Node never
 * has to guess and never warns. This file pins that mechanism directly (same
 * fixture shape as Windows, runnable on Linux), so a regression is caught here
 * rather than only on the Windows CI runner.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WARNING = "MODULE_TYPELESS_PACKAGE_JSON";

describe("W892 MODULE_TYPELESS_PACKAGE_JSON and the program extension", () => {
  it("a .ts under a typeless package.json warns; a .mts never does", () => {
    const dir = mkdtempSync(join(tmpdir(), "w892-typeless-"));
    try {
      // The ancestor package.json with no "type" is the whole point.
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ancestor" }));
      const source = 'import { readFileSync } from "node:fs";\nconsole.log("ok");\n';
      writeFileSync(join(dir, "p.ts"), source);
      writeFileSync(join(dir, "p.mts"), source);
      const run = (file: string): { out: string; err: string } => {
        const r = spawnSync(process.execPath, [join(dir, file)], { encoding: "utf8" });
        return { out: r.stdout ?? "", err: r.stderr ?? "" };
      };
      const ts = run("p.ts");
      const mts = run("p.mts");
      expect(ts.out.trim()).toBe("ok");
      expect(ts.err, "a .ts under a typeless package.json must warn").toContain(WARNING);
      expect(mts.out.trim()).toBe("ok");
      expect(mts.err, "a .mts must never warn").not.toContain(WARNING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the warning is on STDERR (which the broker captures), not stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "w892-stream-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ancestor" }));
      writeFileSync(join(dir, "p.ts"), 'import "node:fs";\n');
      const r = spawnSync(process.execPath, [join(dir, "p.ts")], { encoding: "utf8" });
      expect(r.stdout ?? "").not.toContain(WARNING);
      expect(r.stderr ?? "", "stderr is what run_code renders for the user").toContain(WARNING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
