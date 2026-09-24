// @vitest-environment jsdom
/**
 * W1479 — the streaming UI must be announced to a screen reader.
 *
 * WHY: the app had ZERO live regions (`aria-live` / `role=status` / `role=alert`
 * all measured 0 across apps/web/src), so a screen-reader user got no feedback at
 * all while a turn ran. DSH's answer is deliberately NOT per-token: it keeps an
 * 8-line `.visuallyHidden` node and announces STAGE transitions only, because
 * announcing every delta is unusable. These cases pin the same discipline.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const doc = (globalThis as unknown as { document: any }).document;

/** The real statusbar markup, trimmed to the nodes the module reads. */
const HTML =
  '<div id="statusbar">' +
  '<span class="dot" id="statusDot"></span>' +
  '<span id="statusText"></span>' +
  '<span id="statusTurn"></span>' +
  '<span id="statusTime"></span>' +
  '<div id="statusLive" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>' +
  '</div>';

beforeEach(() => {
  doc.body.innerHTML = HTML;
  vi.resetModules();
});

async function statusbar(): Promise<{ setStatus(t: string, c?: string): void }> {
  return (await import(at("ui/statusbar.ts"))) as { setStatus(t: string, c?: string): void };
}

describe("W1479: the live region", () => {
  it("announces the stage text a sighted user sees", async () => {
    const sb = await statusbar();
    sb.setStatus("运行中…", "busy");
    expect(doc.getElementById("statusLive")!.textContent).toBe("运行中…");
  });

  it("does not repeat itself when the same stage is written twice", async () => {
    const sb = await statusbar();
    const live = doc.getElementById("statusLive")!;
    // Counting DOM writes, not the final value: both implementations END on the
    // same text, so only the NUMBER of mutations separates them. (An earlier
    // version of this case asserted the final value and was vacuous — the
    // mutation control caught it.)
    let writes = 0;
    // Reached through globalThis: the DOM lib in this repo's tsconfig does not
    // declare MutationObserver, but jsdom (the runtime) does provide it.
    const MO = (globalThis as unknown as { MutationObserver: new (cb: () => void) => { observe(n: unknown, o: unknown): void; disconnect(): void } }).MutationObserver;
    const obs = new MO(() => {
      writes += 1;
    });
    obs.observe(live, { childList: true, characterData: true, subtree: true });
    sb.setStatus("运行中…", "busy");
    // MutationObserver callbacks are MICROTASKS: drain before reading the count.
    await Promise.resolve();
    await Promise.resolve();
    const afterFirst = writes;
    sb.setStatus("运行中…", "busy");
    await Promise.resolve();
    await Promise.resolve();
    obs.disconnect();
    expect(afterFirst).toBeGreaterThan(0);
    expect(writes).toBe(afterFirst);
  });

  it("clears silently on an empty status instead of announcing nothing", async () => {
    const sb = await statusbar();
    sb.setStatus("运行中…", "busy");
    sb.setStatus("", "ok");
    expect(doc.getElementById("statusLive")!.textContent).toBe("");
  });

  it("keeps the live region out of the visual tree without hiding it from AT", () => {
    // `display:none` / `visibility:hidden` would remove it from the accessibility
    // tree and silence aria-live entirely — the class must clip instead.
    const css = readFileSync(join(WEB, "src", "styles", "base.css"), "utf8");
    const block = /\.sr-only\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toContain("clip-path");
    expect(block).not.toContain("display: none");
    expect(block).not.toContain("visibility: hidden");
  });
});
