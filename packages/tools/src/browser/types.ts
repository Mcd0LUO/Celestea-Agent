/**
 * Shared CDP protocol shapes (F4 slice 1).
 *
 * Only the fields this layer actually reads are declared: the goal is a
 * zero-dependency client, not a full CDP type surface. Everything here is
 * structural, so a test can hand-build an AX tree without a browser.
 */

/** A rectangle in CSS pixels, top-left origin. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CDP DOM.getBoxModel result (content quad + declared size). */
export interface BoxModel {
  content: number[];
  width?: number;
  height?: number;
}

/** A CDP AX string value (role / name / description). */
export interface AxValue {
  type?: string;
  value?: string;
}

/** A CDP AX property (checked, disabled, focused, ...). */
export interface AxProperty {
  name: string;
  value?: { type?: string; value?: unknown };
}

/** The subset of Accessibility.AXNode this layer reads. */
export interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: AxProperty[];
}

/** A CDP error object as it appears on a response envelope. */
export interface CdpErrorShape {
  code: number;
  message: string;
  data?: unknown;
}
