/** Read-only HTTP helpers with a hard timeout. */

export interface ProbeResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  error: string | null;
  ms: number;
}

export async function probe(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const url = base.replace(/\/$/, "") + path;
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { ok: res.ok, status: res.status, headers, text, json, error: null, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, headers: {}, text: "", json: null, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Headers only (for infinite streams like SSE); the body is aborted. */
export async function probeHeaders(
  base: string,
  path: string,
  timeoutMs = 4000,
): Promise<{ status: number; headers: Record<string, string>; error: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(base.replace(/\/$/, "") + path, { headers: { accept: "text/event-stream" }, signal: ac.signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, error: null };
  } catch (e) {
    return { status: 0, headers: {}, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}
