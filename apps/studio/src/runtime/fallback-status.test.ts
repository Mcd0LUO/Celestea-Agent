/**
 * E §4.4 D5, HTTP half: `GET /api/status` must report BOTH the configured model
 * (`.model`, whose meaning is frozen) and the model actually serving
 * (`.effective_model`), plus the `fallback` block — the two fields are asserted
 * independently, which is the point: a silent downgrade must be impossible to
 * hide behind a status poll (§4.2.3 #4).
 *
 * The adapter is stubbed at the seam the handler reads, so this file tests the
 * HTTP contract and nothing else.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { EngineProfile, RuntimeAdapter } from "../runtime-adapter.js";
import { createFakeRuntimeAdapter } from "../fake-runtime-adapter.js";
import { makeHarness, type StudioHarness } from "../harness.test-util.js";
import type { FallbackStatusView } from "./fallback-host.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** Wrap the fake adapter with just enough of the W785 seam (one optional method). */
function withFallbackView(base: RuntimeAdapter, view: FallbackStatusView): RuntimeAdapter {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "fallbackView") return (): FallbackStatusView => view;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as RuntimeAdapter;
}

describe("D5 — /api/status carries the effective model", () => {
  it("keeps `model` as the configured value and adds effective_model + fallback", async () => {
    const runtime = withFallbackView(createFakeRuntimeAdapter({ profile: { model: "cfg-model" } }), {
      active: true,
      chain: ["primary", "backup"],
      effective_model: "model-b",
      last_reason: "http_503",
      targets: [
        { name: "primary", model: "model-a", available: true, cooling: false },
        { name: "backup", model: "model-b", available: true, cooling: false },
      ],
      problems: [],
    });
    const h = makeHarness({ runtime });
    harnesses.push(h);
    const profile: EngineProfile = h.runtime.profile();

    const res = await h.app.request("/api/status?session=sample-ws%2Fs1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Two INDEPENDENT assertions (D5): configured value vs model in force.
    expect(body["model"]).toBe(profile.model);
    expect(body["effective_model"]).toBe("model-b");
    expect(body["fallback"]).toMatchObject({ active: true, chain: ["primary", "backup"], last_reason: "http_503" });
  });

  it("reports effective_model = model and fallback.active = false when not armed", async () => {
    const h = makeHarness();
    harnesses.push(h);
    const res = await h.app.request("/api/status?session=sample-ws%2Fs1");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["model"]).toBe(h.runtime.profile().model);
    expect(body["effective_model"]).toBe(h.runtime.profile().model);
    expect(body["fallback"]).toMatchObject({ active: false });
  });
});
