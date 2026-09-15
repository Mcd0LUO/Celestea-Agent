/**
 * The two fallback VIEWS the host layer promises (E §4.2.3 #2/#4, W785).
 *
 * They live in their own leaf module on purpose: `runtime-adapter.ts` (the seam)
 * must be able to name them, and importing them from `fallback-host.ts` closed a
 * cycle (`runtime-adapter -> fallback-host -> llm-assembly -> runtime-adapter`,
 * caught by `no-circular`). A leaf with no imports of its own keeps the seam a
 * leaf too.
 */

/** The `status` frame the host publishes when a hand-over happens (§4.2.3 #2). */
export interface FallbackFrame {
  phase: "fallback";
  from: string | null;
  to: string;
  reason: string;
  attempt: number;
  effective_model: string;
}

/** The `fallback` block of `/api/status` (§4.2.3 #4). */
export interface FallbackStatusView {
  active: boolean;
  chain: string[];
  effective_model: string | null;
  last_reason: string | null;
  targets: Array<{ name: string; model: string; available: boolean; cooling: boolean }>;
  problems: string[];
}
