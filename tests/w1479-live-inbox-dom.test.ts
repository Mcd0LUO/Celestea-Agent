// @vitest-environment jsdom
/**
 * W1479 — the LIVE injection lane rides on the `status` frame.
 *
 * WHY THIS FILE EXISTS: injection had its own `inbox` SSE event, but the server's
 * bus asserts the frozen contract list on every emit and that list never contained
 * it — so the listener was dead code and a worker receipt / system injection only
 * appeared after a refresh (via the transcript restore path). Measured before the
 * fix: firing the exact frame the backend sends produced ZERO inbox blocks.
 *
 * The frame shape below is copied from `session-publisher.ts`: a `status` frame
 * with `phase: progress`, a `placement`, and the `inbox` object.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const doc = (globalThis as unknown as { document: any }).document;

const HTML =
  '<div id="app"><div id="layout"><main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle><circle class="sl-ring-prog"></circle></svg></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">—</span><span class="sl-cache" id="slCache">—</span>' +
  '<span class="sl-steps" id="slSteps">—</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea>' +
  '<div class="input-side"><button id="btnMode" class="btn btn-soft btn-mini hidden">插话</button>' +
  '<button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

const LIVE = "test/w1479-live-inbox";

type Listener = (e: { data: string }) => void;
class FakeES {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  seq = 0;
  private listeners = new Map<string, Listener[]>();
  constructor() { lastES = this; }
  addEventListener(name: string, fn: Listener): void {
    const l = this.listeners.get(name) || [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  close(): void {}
  fire(name: string, payload: Record<string, unknown>): void {
    const env = { v: 2, session: LIVE, turn: 1, seq: this.seq++, payload };
    for (const fn of this.listeners.get(name) || []) fn({ data: JSON.stringify(env) });
  }
  subscribed(): string[] {
    return [...this.listeners.keys()].sort();
  }
}
let lastES: FakeES | null = null;

const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300, status, json: async () => payload,
});
const flush = async (n = 16): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  lastES = null;
  doc.body.innerHTML = HTML;
  vi.resetModules();
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("fetch", async () => reply(200, { ok: true, questions: [], messages: [] }));
});

/** The exact frame `session-publisher.ts` publishes for a drained injection. */
function injectedFrame(placement: string, summary: string): Record<string, unknown> {
  return {
    phase: "progress",
    placement,
    message: { kind: "receipt", from: "W1479", lane: "next-turn", summary },
    statusline: {},
  };
}

/** Boot the real chat wiring over the fake EventSource, with the pane ACTIVE. */
async function boot(): Promise<void> {
  // The pane must exist and be active: `ctxFor(p)` routes by the envelope's
  // session, and a frame for an unknown session renders nowhere (by design).
  const V = (await import(at("ui/viewctx.ts"))) as {
    initViewCtx(): void;
    ensurePane(id: string, kind?: string, title?: string): unknown;
    activatePane(id: string, kind?: string, title?: string): unknown;
  };
  V.initViewCtx();
  V.ensurePane(LIVE, "session", "甲会话");
  V.activatePane(LIVE, "session", "甲会话");
  const chat = (await import(at("chat.ts"))) as { connectSse(): void };
  chat.connectSse();
  await flush();
}

function inboxTexts(): string[] {
  return Array.from(doc.querySelectorAll(".msg.inbox")).map((n: any) => (n.textContent || "").trim());
}

describe("W1479: live injection renders from the status lane", () => {
  it("renders an inbox block when placement is context", async () => {
    await boot();
    lastES?.fire("status", injectedFrame("context", "worker 回执正文"));
    await flush();
    expect(inboxTexts().join("|")).toContain("worker 回执正文");
  });

  it("stays quiet while the message is only queued or steering", async () => {
    await boot();
    lastES?.fire("status", injectedFrame("queued", "还没进历史"));
    lastES?.fire("status", injectedFrame("steering", "也没进历史"));
    await flush();
    // Only `context` means "now part of the model-visible history". A queued
    // note is the send path's job (ui/send.ts), not this lane's.
    expect(inboxTexts()).toEqual([]);
  });

  it("never subscribes to a name the server cannot emit", async () => {
    await boot();
    const subs = lastES?.subscribed() ?? [];
    expect(subs).not.toContain("context");
    expect(subs).not.toContain("inbox");
  });
});
