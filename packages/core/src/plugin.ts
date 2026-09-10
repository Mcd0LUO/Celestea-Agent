/**
 * Plugin seam — port of `crates/core/src/plugin.rs`.
 *
 * Everything in the harness is a plugin: the model adapter, the session log,
 * the tool registry, even the agent loop. A plugin mounts itself by providing
 * services (and event listeners) into a [Context]; the composition root decides
 * which plugins exist, `core` never hardcodes a concrete implementation.
 */

import type { Context } from "./context.js";

export interface Plugin {
  /** Stable plugin name (Rust defaults to `type_name`; explicit here). */
  name(): string;
  /** Provide services / listen on the context. */
  mount(ctx: Context): void;
}

/** Ergonomic constructor for a plugin whose name is a string literal. */
export function definePlugin(name: string, mount: (ctx: Context) => void): Plugin {
  return { name: () => name, mount };
}

/** Mount every plugin in registration order (later plugins patch earlier ones). */
export function mountPlugins(ctx: Context, plugins: readonly Plugin[]): Context {
  for (const p of plugins) p.mount(ctx);
  return ctx;
}

/** The names of the mounted plugins, in mount order. */
export function pluginNames(plugins: readonly Plugin[]): string[] {
  return plugins.map((p) => p.name());
}

/**
 * `NamedRegistry<T>` — named, ordered, replaceable rows: the "patch"
 * primitive. A later row with the same name shadows an earlier one
 * (`get` scans backwards), while `iter` still reports every row.
 */
export class NamedRegistry<T> {
  private readonly rows: Array<{ name: string; value: T }> = [];

  insert(name: string, value: T): void {
    this.rows.push({ name, value });
  }

  /** Last registration wins. */
  get(name: string): T | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row !== undefined && row.name === name) return row.value;
    }
    return undefined;
  }

  /** Every row, in registration order (shadowed rows included). */
  entries(): Array<{ name: string; value: T }> {
    return this.rows.map((r) => ({ ...r }));
  }

  get size(): number {
    return this.rows.length;
  }
}
