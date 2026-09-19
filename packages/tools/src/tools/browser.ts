/**
 * F4 step 2b: the two browser tools (browser_open / browser_act).
 *
 * Thin adapters over [BrowserManager]: argument validation, the http(s) gate,
 * and the tool VALUE. The manager owns the process lifecycle and the CDP
 * session; the result's isolation block (which states the RLIMIT_AS exemption
 * and the memory backstop) is produced there and passed through untouched.
 */

import type { Tool, ToolExecOutcome, ToolSpec } from "@celestea/core";

import { optionalIntArg, optionalRecordArg, optionalStringArg, stringArg } from "../args.js";
import { BrowserManager, type BrowserActRequest, type BrowserViewport } from "../browser/session.js";
import { descParam } from "../desc.js";
import { contractFailure } from "../errors.js";

/** The frozen contract description; mirrored by contracts/tools.json. */
export const BROWSER_OPEN_DESCRIPTION =
  "Open an absolute http(s) URL in a session-scoped headless browser and return the page's accessibility snapshot (interactive elements with stable refs) plus a PNG screenshot. Use those refs with browser_act. Requires the session's network capability (the sandbox must share the host network so the DevTools endpoint is reachable) and a session attachment store for the screenshot. This call runs with RLIMIT_AS EXEMPTED: the browser's virtual address space is NOT bounded by the sandbox, because Chromium cannot start under an address-space cap. Every other sandbox limit and the exact isolation state are reported in the result's isolation block.";

/** The frozen contract description; mirrored by contracts/tools.json. */
export const BROWSER_ACT_DESCRIPTION =
  "Act on the page opened by browser_open: click, type into, press a key on, or scroll an element identified by its stable ref from the last snapshot. Returns the updated accessibility snapshot and screenshot. Like browser_open, this call runs with RLIMIT_AS EXEMPTED (virtual address space unbounded) and reports the isolation state in its result.";

export interface BrowserToolOptions {
  /** The session's browser owner (shared by browser_open and browser_act). */
  manager: BrowserManager;
}

const ACTIONS: readonly string[] = ["click", "type", "key", "scroll"];

export function browserOpenSpec(): ToolSpec {
  return {
    name: "browser_open",
    description: BROWSER_OPEN_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open." },
        viewport: {
          type: "object",
          description: "Optional viewport size in CSS pixels (default 800x600).",
          properties: { width: { type: "integer" }, height: { type: "integer" } },
          required: ["width", "height"],
          additionalProperties: false,
        },
        desc: descParam(),
      },
      required: ["url"],
      additionalProperties: false,
    },
  };
}

export function browserActSpec(): ToolSpec {
  return {
    name: "browser_act",
    description: BROWSER_ACT_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "type", "key", "scroll"],
          description: "What to do: click an element, type text into it, press a key, or scroll it.",
        },
        ref: { type: "string", description: "Stable ref from the last snapshot (required for click/type/scroll)." },
        text: { type: "string", description: "Text to insert (action=type)." },
        key: { type: "string", description: "Key name for action=key, e.g. Enter, Tab, Escape." },
        delta_x: { type: "integer", description: "Horizontal scroll delta in pixels (action=scroll; default 0)." },
        delta_y: { type: "integer", description: "Vertical scroll delta in pixels (action=scroll; default 0)." },
        desc: descParam(),
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

/** http/https only: the browser must never be pointed at file:, data: or ws:. */
export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw contractFailure("browser_open", "invalid_arg", "'url' must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw contractFailure("browser_open", "invalid_arg", "'url' must use http or https (got " + parsed.protocol + ")");
  }
}

function readViewport(args: unknown): BrowserViewport | undefined {
  const raw = optionalRecordArg(args, "viewport");
  if (raw === undefined) return undefined;
  const width = raw["width"];
  const height = raw["height"];
  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
    throw contractFailure("browser_open", "invalid_arg", "viewport.width must be a positive integer");
  }
  if (typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
    throw contractFailure("browser_open", "invalid_arg", "viewport.height must be a positive integer");
  }
  return { width, height };
}

async function runOpen(args: unknown, manager: BrowserManager): Promise<ToolExecOutcome> {
  const url = stringArg(args, "url");
  assertHttpUrl(url);
  const value = await manager.open(url, readViewport(args));
  return { value, render: "browser_open " + value.url + " (" + value.snapshot.included_nodes + " nodes)" };
}

async function runAct(args: unknown, manager: BrowserManager): Promise<ToolExecOutcome> {
  const action = stringArg(args, "action");
  if (!ACTIONS.includes(action)) {
    throw contractFailure("browser_act", "invalid_arg", "'action' must be one of click, type, key, scroll");
  }
  const ref = optionalStringArg(args, "ref");
  if (action !== "key" && action !== "scroll" && (ref === undefined || ref === "")) {
    throw contractFailure("browser_act", "invalid_arg", "'ref' is required for action=" + action);
  }
  const request: BrowserActRequest = {
    action: action as BrowserActRequest["action"],
    ...(ref === undefined ? {} : { ref }),
    ...(optionalStringArg(args, "text") === undefined ? {} : { text: optionalStringArg(args, "text") as string }),
    ...(optionalStringArg(args, "key") === undefined ? {} : { key: optionalStringArg(args, "key") as string }),
    ...(optionalIntArg(args, "delta_x") === undefined ? {} : { deltaX: optionalIntArg(args, "delta_x") as number }),
    ...(optionalIntArg(args, "delta_y") === undefined ? {} : { deltaY: optionalIntArg(args, "delta_y") as number }),
  };
  const value = await manager.act(request);
  return { value, render: "browser_act " + action + " -> " + value.title };
}

export function browserOpenTool(options: BrowserToolOptions): Tool {
  const spec = browserOpenSpec();
  return {
    spec: () => spec,
    execute: async (args) => (await runOpen(args, options.manager)).value,
    executeWith: async (input) => runOpen(input.args, options.manager),
  };
}

export function browserActTool(options: BrowserToolOptions): Tool {
  const spec = browserActSpec();
  return {
    spec: () => spec,
    execute: async (args) => (await runAct(args, options.manager)).value,
    executeWith: async (input) => runAct(input.args, options.manager),
  };
}
