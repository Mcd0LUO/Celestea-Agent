/**
 * Context seam — port of `crates/core/src/context.rs`.
 *
 * A shared, token-keyed service container. Plugins provide services into it;
 * consumers resolve services out of it. A parent chain lets an agent carry a
 * scoped Context layered over the global one.
 *
 * Rust keys services by `TypeId::of::<T>()`; TypeScript has no TypeId, so the
 * key is an explicit token: a well-known string (see `*_SERVICE` constants), a
 * symbol, or a class constructor used by identity. Same semantics otherwise:
 * a later `provide` of the same token replaces the earlier one, and `get` falls
 * back to the parent scope.
 */

/** What can key a service slot. */
export type ServiceToken<T> = string | symbol | (abstract new (...args: never[]) => T);

function tokenKey(token: ServiceToken<unknown>): unknown {
  return typeof token === "string" ? `service:${token}` : token;
}

export class Context {
  private readonly services = new Map<unknown, unknown>();
  private readonly parent: Context | null;

  constructor(parent: Context | null = null) {
    this.parent = parent;
  }

  /** A fresh root context (Rust `Context::new`). */
  static root(): Context {
    return new Context(null);
  }

  /** Register a service; a later registration of the same token replaces it. */
  provide<T>(token: ServiceToken<T>, service: T): void {
    this.services.set(tokenKey(token), service);
  }

  /** Resolve a service by token, falling back to the parent scope. */
  get<T>(token: ServiceToken<T>): T | undefined {
    if (this.services.has(tokenKey(token))) return this.services.get(tokenKey(token)) as T;
    return this.parent?.get(token) ?? undefined;
  }

  /** Resolve or throw: for call sites where a missing service is a bug. */
  require<T>(token: ServiceToken<T>): T {
    const svc = this.get(token);
    if (svc === undefined) throw new Error(`service not provided: ${String(token)}`);
    return svc;
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.get(token) !== undefined;
  }

  /** Create a child scope that falls back to this context (one per agent). */
  scoped(): Context {
    return new Context(this);
  }

  /** The tokens provided in THIS scope (parent services excluded). */
  localTokens(): unknown[] {
    return [...this.services.keys()];
  }
}
