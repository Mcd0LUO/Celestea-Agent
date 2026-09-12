/**
 * (b) The token ESTIMATOR and (c) the trim PASS.
 *
 * `estimateTokens` is UTF-8 bytes / 4 (W220) — the number the trim budget is
 * decided with and the number the statusline reports when no provider usage
 * frame exists. Two rows make its口径 measurable instead of assumed: the
 * measured chars/token and bytes/token for ASCII and for CJK. CJK is 3 bytes per
 * character, so `bytes/4` spends 0.75 tokens per character where a real
 * BPE tokenizer spends ~1 — the estimator UNDER-counts CJK by roughly a quarter
 * (the row records the ratios; the report draws the conclusion).
 *
 * `trimContext` is the pass that decides what survives when the derived history
 * exceeds the window budget. The rows replay REAL projected messages (sliced
 * from the 10k-event fixture, so the user/assistant alternation the cut
 * boundaries depend on is genuine) at growing sizes, and the log-log growth
 * exponent is reported: the pass scans candidate cut positions and re-estimates
 * the whole suffix per candidate, so it is quadratic in the history size.
 */

import { estimateMessagesTokens, estimateTokens, trimContext } from "@celestea/agent-loop";
import { assistantText, userMessage, type Message } from "@celestea/core";
import { caseOf, growthExponent, timeValue, type BenchCase } from "./timing.js";
import type { Fixture } from "./fixtures.js";

/** Payload sizes: same CHARACTER count for both scripts, so ratios compare. */
const TEXT_CHARS = 4_000;
const MESSAGE_COUNT = 200;
const MESSAGE_CHARS = 200;
/** Over-budget trim: a 2,000-token window (the fixture history is far larger). */
const TRIM_WINDOW = 2_000;
const TRIM_SYSTEM_TOKENS = 40;
const TRIM_THRESHOLD = 0.8;
const TRIM_KEEP_RECENT = 10;
/** History sizes for the trim rows (message counts sliced from the fixture). */
const TRIM_SIZES = [1_000, 2_000, 4_000, 5_000] as const;

const ASCII_SENTENCE = "The quick brown fox jumps over the lazy dog near the river bank. ";
const CJK_SENTENCE = "引擎性能基准测试套件测量上下文快照与状态行的每次开销。";

function scripted(text: string, chars: number): string {
  return text.repeat(Math.ceil(chars / text.length)).slice(0, chars);
}

function ratios(text: string): Record<string, number> {
  const tokens = estimateTokens(text);
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    chars: text.length,
    bytes,
    tokens,
    chars_per_token: Math.round((text.length / tokens) * 1_000) / 1_000,
    bytes_per_token: Math.round((bytes / tokens) * 1_000) / 1_000,
  };
}

function scriptMessages(sentence: string): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const text = scripted(sentence, MESSAGE_CHARS);
    out.push(i % 2 === 0 ? userMessage(text) : assistantText(text));
  }
  return out;
}

/** (b) The estimator rows: ASCII vs CJK, single string and message list. */
export function tokenCases(): BenchCase[] {
  const ascii = scripted(ASCII_SENTENCE, TEXT_CHARS);
  const cjk = scripted(CJK_SENTENCE, TEXT_CHARS);
  const asciiMessages = scriptMessages(ASCII_SENTENCE);
  const cjkMessages = scriptMessages(CJK_SENTENCE);
  return [
    caseOf("estimateTokens() ASCII", `${TEXT_CHARS.toLocaleString("en-US")} chars`, timeValue(() => estimateTokens(ascii)), "UTF-8 bytes / 4, rounded up", ratios(ascii)),
    caseOf("estimateTokens() CJK", `${TEXT_CHARS.toLocaleString("en-US")} chars`, timeValue(() => estimateTokens(cjk)), "same estimator on 3-byte characters: chars/token > 1 means it under-counts", ratios(cjk)),
    caseOf("estimateMessagesTokens() ASCII", `${MESSAGE_COUNT} messages`, timeValue(() => estimateMessagesTokens(asciiMessages)), "content + per-message overhead", { ...ratios(asciiMessages.map((m) => textOf(m)).join("")), messages: MESSAGE_COUNT, tokens: estimateMessagesTokens(asciiMessages) }),
    caseOf("estimateMessagesTokens() CJK", `${MESSAGE_COUNT} messages`, timeValue(() => estimateMessagesTokens(cjkMessages)), "same list in CJK", { ...ratios(cjkMessages.map((m) => textOf(m)).join("")), messages: MESSAGE_COUNT, tokens: estimateMessagesTokens(cjkMessages) }),
  ];
}

function textOf(message: Message): string {
  return message.content.map((c) => (c.type === "text" ? c.content : "")).join("");
}

/** (c) The trim pass over REAL projected history, at growing message counts. */
export function trimCases(fixture: Fixture): BenchCase[] {
  const history = fixture.log.deriveMessages();
  const rows: BenchCase[] = [];
  const points: Array<{ x: number; y: number }> = [];
  for (const size of TRIM_SIZES) {
    const slice = history.slice(0, size);
    if (slice.length < size) continue;
    const timing = timeValue(() => trimContext(slice, TRIM_SYSTEM_TOKENS, TRIM_WINDOW, TRIM_THRESHOLD, TRIM_KEEP_RECENT).messages.length, { rounds: 3 });
    points.push({ x: size, y: timing.median_ms });
    rows.push(caseOf("trimContext() [over budget]", `${size.toLocaleString("en-US")} messages`, timing, "real projected history, window=2,000 tokens: on every statusline tick of an over-budget session", { messages: size, kept: TRIM_KEEP_RECENT }));
  }
  const exponent = growthExponent(points);
  const largest = rows[rows.length - 1];
  if (largest !== undefined) {
    largest.extra = { ...largest.extra, growth_exponent_loglog: exponent };
  }
  const whole = timeValue(() => trimContext(history, TRIM_SYSTEM_TOKENS, 0, TRIM_THRESHOLD, TRIM_KEEP_RECENT).messages.length);
  rows.push(caseOf("trimContext() [disabled]", `${history.length.toLocaleString("en-US")} messages`, whole, "window=0 disables trimming: the O(n) estimate only — the cheap regime", { messages: history.length }));
  return rows;
}
