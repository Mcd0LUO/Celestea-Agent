// ============================================================================
// SSE client — typed wrappers around the /api/events stream.
// Event names preserved: status/text/thinking/tool/tool_result/done.
// 责任边界：仅解析/分发事件，不做状态归并（归并在 chat.ts）。
// Each event: {"turn":N,"seq":M,"payload":{...}, ...}
// ============================================================================
import type {
  CompactPayload,
  ConnState,
  ContextPayload,
  DonePayload,
  InboxPayload,
  SseEnvelope,
  SseEventName,
  StatusPayload,
  TextPayload,
  ThinkingPayload,
  ToolPayload,
  ToolResultPayload,
} from './types';

export interface SseHandlerMap {
  status: (p: StatusPayload) => void;
  text: (p: TextPayload) => void;
  thinking: (p: ThinkingPayload) => void;
  tool: (p: ToolPayload) => void;
  tool_result: (p: ToolResultPayload) => void;
  done: (p: DonePayload) => void;
  context: (p: ContextPayload) => void;
  compact: (p: CompactPayload) => void;
  /** W515：Agent Inbox / worker 回执（系统注入，与普通用户消息分类展示）。 */
  inbox: (p: InboxPayload) => void;
}

export type SseHandler<K extends SseEventName> = SseHandlerMap[K];

/**
 * W263: the envelope carries the turn/seq framing while the payload carries the
 * event body ({"turn":N,"seq":M,"payload":{...}}).
 * W514: the envelope may also carry {v:2, session} — merged in as well so every
 * handler can route the frame to the right session view (absent = legacy). Handlers read fields off ONE
 * flat object (chat.ts reads p.turn / p.phase / p.delta), so merge the envelope
 * fields into the payload WITHOUT dropping any payload field. Non-object
 * payloads (defensive) are passed through untouched.
 */
function withEnvelope(payload: unknown, env: SseEnvelope): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const out = { ...(payload as Record<string, unknown>) };
  if (env.turn !== undefined && out.turn === undefined) out.turn = env.turn;
  if (env.seq !== undefined) out.seq = env.seq;
  // W514：信封 v2 的会话路由字段（旧后端缺省 → 前端回落单会话行为）
  if (env.v !== undefined) out.v = env.v;
  if (env.session !== undefined && env.session !== null && out.session === undefined) {
    out.session = env.session;
  }
  return out;
}

const EVENT_NAMES: readonly SseEventName[] = [
  'status',
  'text',
  'thinking',
  'tool',
  'tool_result',
  'done',
  'context',
  'compact',
  'inbox',
];

export class SseClient {
  private es: EventSource | null = null;
  private handlers = new Map<SseEventName, Set<(p: unknown) => void>>();
  private connCbs = new Set<(state: ConnState) => void>();

  constructor(readonly url = '/api/events') {}

  on<K extends SseEventName>(name: K, handler: SseHandler<K>): void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (p: unknown) => void);
  }

  onConn(cb: (state: ConnState) => void): void {
    this.connCbs.add(cb);
  }

  connect(): void {
    this.close();
    const es = new EventSource(this.url);
    this.es = es;
    es.onopen = () => this.emitConn('online');
    es.onerror = () => this.emitConn('down');
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (e: MessageEvent<string>) => {
        try {
          const env = JSON.parse(e.data) as SseEnvelope;
          const payload = env.payload !== undefined ? env.payload : env;
          this.emit(name, withEnvelope(payload, env));
        } catch (err) {
          console.warn('[sse] failed to parse', name, err);
        }
      });
    }
  }

  close(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  private emit(name: SseEventName, payload: unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) {
      try {
        (h as (p: unknown) => void)(payload);
      } catch (err) {
        console.warn('[sse] handler failed for', name, err);
      }
    }
  }

  private emitConn(state: ConnState): void {
    for (const cb of this.connCbs) {
      try {
        cb(state);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}
