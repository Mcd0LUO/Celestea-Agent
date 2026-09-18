/**
 * F4 slice 1 -- AX snapshot unit tests (pure, no browser).
 *
 * The two properties that matter: a stable ref per interactive node, and an
 * EXPLICIT hard limit -- a silently clipped tree would let the model act on a
 * page it cannot fully see.
 */

import { describe, expect, it } from "vitest";

import { buildAxSnapshot, collectBoxes, quadToBox, type SnapshotOptions } from "./snapshot.js";
import type { AxNode, BoundingBox } from "./types.js";

/** Build one AX node (CDP shape). */
function ax(role: string, name: string, backend?: number, extra: Partial<AxNode> = {}): AxNode {
  const node: AxNode = { role: { type: "role", value: role }, name: { type: "computedString", value: name } };
  if (backend !== undefined) node.backendDOMNodeId = backend;
  return { ...node, ...extra };
}

const BOXES: ReadonlyMap<number, BoundingBox> = new Map([
  [11, { x: 10, y: 20, width: 100, height: 30 }],
  [12, { x: 10, y: 60, width: 200, height: 24 }],
]);

const TREE: readonly AxNode[] = [
  ax("heading", "Welcome"),
  ax("button", "Submit", 11),
  ax("generic", ""),
  ax("textbox", "Email", 12),
];

describe("F4 snapshot -- refs, boxes and stability", () => {
  it("gives every interactive node a ref and its injected box", () => {
    const snap = buildAxSnapshot(TREE, { boxes: BOXES });
    expect(snap.refs.map((ref) => ref.ref)).toEqual(["e1", "e2"]);
    expect(snap.refs[0]).toMatchObject({ role: "button", name: "Submit", backendDOMNodeId: 11, box: { x: 10, y: 20, width: 100, height: 30 } });
    expect(snap.refs[1]).toMatchObject({ role: "textbox", name: "Email", backendDOMNodeId: 12 });
    expect(snap.text).toContain('[e1] button "Submit" @ (10,20,100,30)');
    expect(snap.text).toContain('heading "Welcome"');
    expect(snap.truncated).toBe(false);
    expect(snap.truncationReason).toBeNull();
  });

  it("is deterministic: the same tree yields the same refs and text", () => {
    const first = buildAxSnapshot(TREE, { boxes: BOXES });
    const second = buildAxSnapshot(TREE, { boxes: BOXES });
    expect(second.refs).toEqual(first.refs);
    expect(second.text).toBe(first.text);
  });

  it("skips ignored nodes and unnamed non-interactive nodes", () => {
    const nodes = [ax("button", "Ghost", 99, { ignored: true }), ax("generic", ""), ax("button", "Real", 11)];
    const snap = buildAxSnapshot(nodes, { boxes: BOXES });
    expect(snap.refs.map((ref) => ref.name)).toEqual(["Real"]);
    expect(snap.text).not.toContain("Ghost");
  });

  it("names an empty tree explicitly instead of returning nothing", () => {
    const snap = buildAxSnapshot([]);
    expect(snap.includedNodes).toBe(0);
    expect(snap.text).toContain("no interactive or named accessibility nodes");
    expect(snap.truncated).toBe(false);
  });
});

describe("F4 snapshot -- hard limits are explicit", () => {
  it("truncates on the node cap and says so in the text", () => {
    const nodes = [ax("button", "A", 1), ax("button", "B", 2), ax("button", "C", 3)];
    const snap = buildAxSnapshot(nodes, { maxNodes: 2 });
    expect(snap.truncated).toBe(true);
    expect(snap.truncationReason).toContain("node cap (2)");
    expect(snap.includedNodes).toBe(2);
    expect(snap.omittedNodes).toBe(1);
    expect(snap.refs.map((ref) => ref.ref)).toEqual(["e1", "e2"]);
    expect(snap.text).toContain("[snapshot truncated: 2 of 3 nodes included (node cap (2) reached)]");
  });

  it("truncates on the byte cap and says so in the text", () => {
    const nodes = Array.from({ length: 5 }, (_unused, index) => ax("button", "button-" + index));
    const snap = buildAxSnapshot(nodes, { maxBytes: 30 });
    expect(snap.truncated).toBe(true);
    expect(snap.truncationReason).toContain("byte cap (30)");
    expect(snap.includedNodes).toBeGreaterThanOrEqual(1);
    expect(snap.includedNodes).toBeLessThan(5);
    expect(snap.text).toContain("[snapshot truncated:");
  });

  it("does not truncate when the tree fits (the caps are real, not always-on)", () => {
    const nodes = [ax("button", "A", 1), ax("button", "B", 2)];
    const snap = buildAxSnapshot(nodes, { maxNodes: 10, maxBytes: 4096 });
    expect(snap.truncated).toBe(false);
    expect(snap.truncationReason).toBeNull();
    expect(snap.omittedNodes).toBe(0);
    expect(snap.includedNodes).toBe(2);
  });

  it("honours the default caps for a large synthetic tree", () => {
    const nodes = Array.from({ length: 500 }, (_unused, index) => ax("button", "b" + index));
    const snap = buildAxSnapshot(nodes);
    expect(snap.truncated).toBe(true);
    expect(snap.includedNodes).toBeLessThanOrEqual(200);
    expect(snap.refs).toHaveLength(snap.includedNodes);
  });
});

describe("F4 snapshot -- boxes and quads", () => {
  it("computes the axis-aligned bounds of a content quad", () => {
    expect(quadToBox([10, 20, 110, 20, 110, 50, 10, 50])).toEqual({ x: 10, y: 20, width: 100, height: 30 });
    expect(quadToBox([1, 2, 3])).toBeNull();
  });

  it("collects one box per distinct backendDOMNodeId and tolerates misses", async () => {
    const source = {
      getBoxModel: async (backendNodeId: number) => (backendNodeId === 11 ? { content: [0, 0, 10, 0, 10, 5, 0, 5] } : null),
    };
    const boxes = await collectBoxes(source, [ax("button", "A", 11), ax("button", "B", 12), ax("button", "C", 11)], "s1");
    expect(boxes.get(11)).toEqual({ x: 0, y: 0, width: 10, height: 5 });
    expect(boxes.has(12)).toBe(false);
    expect(boxes.size).toBe(1);
  });

  it("accepts options without boxes", () => {
    const options: SnapshotOptions = { maxNodes: 5 };
    const snap = buildAxSnapshot([ax("button", "A", 11)], options);
    expect(snap.refs[0]!.box).toBeNull();
  });
});
