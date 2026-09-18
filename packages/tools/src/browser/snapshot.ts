/**
 * Accessibility-tree snapshot (F4 slice 1).
 *
 * A raw Accessibility.getFullAXTree is unusable as model input: the measured
 * Studio home page is 3687 nodes / 1.23MB. This module turns it into a BOUNDED
 * text snapshot where every interactive node carries a stable ref (e1, e2, ...)
 * plus its box, so click/type can target a ref instead of raw coordinates.
 *
 * Hard limits: a node cap and a byte cap. Both are explicit in the result
 * (truncated / truncationReason) and the text ends with a visible note -- a
 * silently clipped snapshot would make the model act on an incomplete page.
 *
 * Pure: no CDP, no filesystem. Boxes are injected (collectBoxes fills them from
 * DOM.getBoxModel when a caller has a live session).
 */

import type { AxNode, BoundingBox, BoxModel } from "./types.js";

/** Default cap on rendered nodes. */
export const DEFAULT_MAX_NODES = 200;
/** Default cap on rendered UTF-8 bytes. */
export const DEFAULT_MAX_BYTES = 32 * 1024;
/** Longest name kept per node (the rest is elided). */
export const MAX_NAME_CHARS = 120;

/** Roles that receive a ref (clickable / typeable). */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
]);

/** Roles rendered as context (no ref) when they carry a name. */
export const CONTEXT_ROLES: ReadonlySet<string> = new Set([
  "heading",
  "cell",
  "columnheader",
  "rowheader",
  "article",
  "img",
  "alert",
]);

/** One addressable element in the snapshot. */
export interface SnapshotRef {
  ref: string;
  role: string;
  name: string;
  backendDOMNodeId: number | null;
  box: BoundingBox | null;
}

/** The bounded result handed to the model. */
export interface AxSnapshot {
  text: string;
  refs: SnapshotRef[];
  totalNodes: number;
  includedNodes: number;
  omittedNodes: number;
  truncated: boolean;
  truncationReason: string | null;
}

export interface SnapshotOptions {
  maxNodes?: number;
  maxBytes?: number;
  /** Boxes keyed by backendDOMNodeId (see collectBoxes). */
  boxes?: ReadonlyMap<number, BoundingBox>;
}

/** true when a role can be clicked or typed into. */
export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

/** Role of a node (CDP omits it for some ignored nodes). */
export function roleOf(node: AxNode): string {
  return node.role?.value ?? "generic";
}

/** Collapsed, trimmed, elided accessible name. */
export function nameOf(node: AxNode): string {
  const raw = node.name?.value ?? node.value?.value ?? "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_NAME_CHARS ? collapsed.slice(0, MAX_NAME_CHARS) + "..." : collapsed;
}

/**
 * Build the bounded snapshot. Iterates the tree in its given order (CDP returns
 * pre-order), so refs are stable for an unchanged tree.
 */
export function buildAxSnapshot(nodes: readonly AxNode[], options: SnapshotOptions = {}): AxSnapshot {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines: string[] = [];
  const refs: SnapshotRef[] = [];
  let bytes = 0;
  let reason: string | null = null;

  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = roleOf(node);
    const name = nameOf(node);
    const interactive = INTERACTIVE_ROLES.has(role);
    const context = CONTEXT_ROLES.has(role) && name !== "";
    if (!interactive && !context) continue;
    if (refs.length >= maxNodes) {
      reason = "node cap (" + maxNodes + ") reached";
      break;
    }
    const line = interactive ? renderRefLine(refs.length + 1, role, name, boxOf(node, options.boxes)) : role + ' "' + name + '"';
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > maxBytes) {
      reason = "byte cap (" + maxBytes + ") reached";
      break;
    }
    lines.push(line);
    bytes += lineBytes;
    if (interactive) {
      refs.push({
        ref: "e" + (refs.length + 1),
        role,
        name,
        backendDOMNodeId: node.backendDOMNodeId ?? null,
        box: boxOf(node, options.boxes),
      });
    }
  }

  const includedNodes = lines.length;
  const omittedNodes = nodes.length - includedNodes;
  if (reason !== null) {
    lines.push("[snapshot truncated: " + includedNodes + " of " + nodes.length + " nodes included (" + reason + ")]");
  } else if (includedNodes === 0) {
    lines.push("(no interactive or named accessibility nodes)");
  }
  return {
    text: lines.join("\n"),
    refs,
    totalNodes: nodes.length,
    includedNodes,
    omittedNodes,
    truncated: reason !== null,
    truncationReason: reason,
  };
}

function renderRefLine(index: number, role: string, name: string, box: BoundingBox | null): string {
  const head = "[e" + index + "] " + role + ' "' + name + '"';
  return box === null ? head : head + " @ (" + box.x + "," + box.y + "," + box.width + "," + box.height + ")";
}

function boxOf(node: AxNode, boxes: ReadonlyMap<number, BoundingBox> | undefined): BoundingBox | null {
  const id = node.backendDOMNodeId;
  if (id === undefined || boxes === undefined) return null;
  return boxes.get(id) ?? null;
}

/** The slice of CdpClient collectBoxes needs (structural, avoids a cycle). */
export interface BoxSource {
  getBoxModel(backendNodeId: number, sessionId: string): Promise<BoxModel | null>;
}

/** Fetch a box per distinct backendDOMNodeId; a failed lookup is simply absent. */
export async function collectBoxes(source: BoxSource, nodes: readonly AxNode[], sessionId: string): Promise<Map<number, BoundingBox>> {
  const boxes = new Map<number, BoundingBox>();
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const id = node.backendDOMNodeId;
    if (id === undefined || boxes.has(id)) continue;
    const model = await source.getBoxModel(id, sessionId).catch(() => null);
    const box = model === null ? null : quadToBox(model.content);
    if (box !== null) boxes.set(id, box);
  }
  return boxes;
}

/** The axis-aligned bounds of a CDP content quad ([x1,y1,x2,y2,x3,y3,x4,y4]). */
export function quadToBox(quad: readonly number[]): BoundingBox | null {
  const q = quad.slice(0, 8).map(Number);
  if (q.length < 8) return null;
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
