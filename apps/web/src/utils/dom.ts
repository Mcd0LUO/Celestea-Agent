// ============================================================================
// DOM helpers + formatting utilities
// ============================================================================

/** querySelector with element type; null when absent. */
export function $<T extends Element = Element>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

/** querySelectorAll, returned as an array. */
export function $$<T extends Element = Element>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

/** querySelector that throws when the anchor element is missing. */
export function need<T extends Element = Element>(sel: string, root: ParentNode = document): T {
  const n = $<T>(sel, root);
  if (!n) throw new Error('missing element: ' + sel);
  return n;
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-escape an arbitrary value. */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);
}

/** Create an element with optional class list and plain-text content. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: unknown,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** mm:ss from a seconds value. */
export function fmtTime(sec: number): string {
  const t = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

/** hh:mm:ss of now. */
export function fmtNow(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

const fmtDigits = (v: number, digits: number) => {
  const s = v.toFixed(digits);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** Compact number: 1234 -> '1.2K', 1000000 -> '1M'; '—' for empty/invalid. */
export function fmtCompact(n: number | null | undefined, digits = 1): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return fmtDigits(n / 1e9, digits) + 'B';
  if (abs >= 1e6) return fmtDigits(n / 1e6, digits) + 'M';
  if (abs >= 1e3) return fmtDigits(n / 1e3, digits) + 'K';
  return String(Math.round(n));
}
