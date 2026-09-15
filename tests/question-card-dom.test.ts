// @vitest-environment jsdom
/**
 * W784 · the question CARD in a REAL DOM (jsdom), not just the pure functions.
 *
 * The card is the user's only way to answer a parked question, and neither the
 * authoring worker nor the reviewer could open a browser (this host has none).
 * This file therefore loads the card by URL — the same cross-repo pattern as
 * tests/model-icon.test.ts — and drives real DOM events against jsdom.
 *
 * Still NOT covered here: CSS layout/visuals (jsdom applies no stylesheet).
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface El {
  textContent: string | null;
  dataset: Record<string, string>;
  disabled: boolean;
  value: string;
  checked: boolean;
  type: string;
  name: string;
  hidden: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  isConnected: boolean;
  parentElement: El | null;
  classList: { add(c: string): void };
  append(...nodes: El[]): void;
  appendChild(n: El): void;
  replaceChildren(): void;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
  addEventListener(type: string, fn: () => void): void;
  dispatchEvent(e: unknown): boolean;
}
interface Dom {
  createElement(tag: string): El;
  body: { append(...n: El[]): void; replaceChildren(): void };
}
interface CardModule {
  renderQuestionCard(ctx: unknown, raw: unknown): unknown;
  renderHistoryQuestionCard(ctx: unknown, row: unknown, into?: El): unknown;
}

const CARD_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web/src/ui/question/card.ts"),
).href;
const card = (await import(/* @vite-ignore */ CARD_URL)) as CardModule;
const dom = (globalThis as unknown as { document: Dom }).document;
const Ev = (globalThis as unknown as { Event: new (t: string) => unknown }).Event;

const FRAME = {
  session: "ws/s1",
  id: "q-1",
  expires_at: Date.now() + 300_000,
  timeout_ms: 300_000,
  questions: [
    {
      id: "mode",
      question: "选哪个方案？",
      header: "确认",
      detail: "两个方案都能用，A 更快。",
      options: [
        { label: "方案 A（推荐）", description: "更快" },
        { label: "方案 B", description: "更稳" },
      ],
    },
  ],
};

interface Pane { id: string; el: El; hint: El; streaming: boolean; stickBottom: boolean }
function makePane(id = "sample-ws/s1"): Pane {
  const el = dom.createElement("div");
  const hint = dom.createElement("div");
  dom.body.append(el, hint);
  return { id, el, hint, streaming: false, stickBottom: false };
}
const sel = (p: Pane, s: string): El | null => p.el.querySelector(s);
const all = (p: Pane, s: string): El[] => [...p.el.querySelectorAll(s)];
const click = (n: El | null): void => void n?.dispatchEvent(new Ev("click"));

let calls: Array<{ url: string; body: string }>;
let status = 200;
let payload: unknown = {};

beforeEach(() => {
  calls = [];
  status = 200;
  payload = { ok: true, id: "q-1", session: "ws/s1", timed_out: false };
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: init?.body === undefined ? "" : String(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.body.replaceChildren();
});

describe("W784 question card in a real DOM", () => {
  it("renders header / question / detail / option labels+descriptions and a countdown", () => {
    const pane = makePane();
    card.renderQuestionCard(pane, FRAME);
    expect(sel(pane, ".q-card")).not.toBeNull();
    expect(sel(pane, ".q-title")?.textContent).toBe("确认");
    expect(sel(pane, ".q-question")?.textContent).toBe("选哪个方案？");
    expect(sel(pane, ".q-detail")?.textContent).toBe("两个方案都能用，A 更快。");
    // 「（推荐）」is presentation only: the label stays verbatim (never an index).
    expect(all(pane, ".q-opt-label").map((e) => e.textContent)).toEqual(["方案 A（推荐）", "方案 B"]);
    expect(all(pane, ".q-opt-desc").map((e) => e.textContent)).toEqual(["更快", "更稳"]);
    expect(sel(pane, ".q-timer")?.textContent).toMatch(/剩 \d+:\d\d/);
    expect(sel(pane, ".q-submit")?.disabled).toBe(false);
    expect(all(pane, ".q-opt-input").every((r) => r.type === "radio" && r.name === "q-q-1-mode")).toBe(true);
  });

  it("refuses an incomplete submit in place, without sending anything", async () => {
    const pane = makePane();
    card.renderQuestionCard(pane, FRAME);
    click(sel(pane, ".q-submit"));
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(0);
    expect(sel(pane, ".q-hint")?.textContent).toContain("没作答");
  });

  it("POSTs {answers:[{id,selected:[label],custom}],session} and lands in done", async () => {
    const pane = makePane();
    card.renderQuestionCard(pane, FRAME);
    const b = all(pane, ".q-opt-input").find((r) => r.value === "方案 B");
    expect(b).toBeDefined();
    if (b) { b.checked = true; b.dispatchEvent(new Ev("change")); }
    const custom = sel(pane, ".q-custom-input");
    if (custom) { custom.value = "补充一句：先按 B 做"; custom.dispatchEvent(new Ev("input")); }
    click(sel(pane, ".q-submit"));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]?.url).toBe("/api/questions/q-1/answer");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      answers: [{ id: "mode", selected: ["方案 B"], custom: "补充一句：先按 B 做" }],
      session: "sample-ws/s1",
    });
    expect(sel(pane, ".q-card")?.dataset.state).toBe("done");
    expect(sel(pane, ".q-result")?.textContent).toContain("方案 B");
    expect(sel(pane, ".q-submit")?.disabled).toBe(true);
  });

  it("maps a 404 (already settled) to the closed terminal instead of an error to retry", async () => {
    status = 404;
    payload = { ok: false, error: "unknown or already settled question" };
    const pane = makePane();
    card.renderQuestionCard(pane, { ...FRAME, id: "q-404" });
    const first = all(pane, ".q-opt-input")[0];
    if (first) { first.checked = true; first.dispatchEvent(new Ev("change")); }
    click(sel(pane, ".q-submit"));
    await new Promise((r) => setTimeout(r, 10));
    expect(sel(pane, ".q-card")?.dataset.state).toBe("closed");
  });
});

describe("W784 question card history terminals", () => {
  const host = (): El => { const d = dom.createElement("div"); dom.body.append(d); return d; };
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: "q-9", questions: FRAME.questions, settled: false, timedOut: false, answerText: "", ...extra });

  it("an unanswered question (interrupted turn) is a cannot-answer terminal", () => {
    const into = host();
    card.renderHistoryQuestionCard(makePane(), row({ id: "q-9" }), into);
    expect(into.querySelector(".q-card")?.dataset.state).toBe("expired");
    expect(into.querySelector(".q-result")?.textContent).toContain("无法再作答");
  });

  it("an answered question echoes the chosen label", () => {
    const into = host();
    card.renderHistoryQuestionCard(makePane(), row({ id: "q-10", settled: true, answerText: "方案 A（推荐）" }), into);
    expect(into.querySelector(".q-card")?.dataset.state).toBe("done");
    expect(into.querySelector(".q-result")?.textContent).toContain("方案 A（推荐）");
  });

  it("a timed-out question is a settled expired terminal", () => {
    const into = host();
    card.renderHistoryQuestionCard(makePane(), row({ id: "q-11", settled: true, timedOut: true }), into);
    expect(into.querySelector(".q-card")?.dataset.state).toBe("expired");
  });
});
