/**
 * `@celestea/tools` — the tool pipeline: registry + guard chain + builtin tools.
 *
 * Parity target: `celestea_harness/crates/tools` (`registry.rs`, `guard.rs`,
 * `builtin.rs`, `http.rs`, `process.rs`, `sandbox.rs`). The package implements
 * the `Tool` / `ToolGuard` / `ToolRegistry` / `Sandbox` seams declared by
 * `@celestea/core`; nothing here is reachable except through this barrel
 * (ARCHITECTURE.md §2.2).
 *
 * Pipeline (one dispatch, `registry.ts` — the order is contract, not taste):
 *   schema validation → ToolGuard chain → execute → structured ToolOutput
 *
 * Module map:
 *   index.ts             public surface (this file)
 *   registry.ts          ToolRegistryImpl: the four-stage dispatch pipeline  (registry.rs)
 *   schema.ts            JSON-Schema subset validator (pipeline stage 1)
 *   args.ts              argument readers with Rust-parity error text
 *   errors.ts            structured contract errors (`toolargs:` / `toolguard:`)
 *   tool-failure.ts      ToolFailure: the single rejection type of a Tool
 *   fn-tool.ts           Tool over a plain async closure                        (builtin.rs)
 *   env.ts               env readers (string / int / on-off flag)
 *   guard/paths.ts       canonicalization: traversal + symlink containment      (guard.rs)
 *   guard/path-guard.ts  PathGuard: CELESTEA_TOOL_ROOTS whitelist, fail-closed  (guard.rs)
 *   fs/file-io.ts        capped reads, binary rejection, capped listings
 *   tools/read-file.ts   read_file                                              (builtin.rs)
 *   tools/write-file.ts  write_file                                             (builtin.rs)
 *   tools/list-dir.ts    list_dir                                               (builtin.rs)
 *   tools/run_shell      run_shell: orchestration over the Sandbox seam         (builtin.rs, sandbox.rs)
 *   tools/process-control.ts  process_control (poll / stdin / kill)             (process.rs)
 *   tools/http-request.ts     http_request (SSRF, timeout, truncation)          (http.rs)
 *   http/ssrf.ts         IP/CIDR allow+deny policy, fail-closed                 (http.rs)
 *   http/headers.ts      request-header validation + response-header subset     (http.rs)
 *   http/transport.ts    one HTTP(S) hop over node:http/https                   (http.rs)
 *   http/redirects.ts    policy-checked redirect following (<= 5 hops)          (http.rs)
 *   http/errors.ts       transport error classification (timeout|dns|connect|…)
 *   process/registry.ts  background process registry + reaper + completion sink (process.rs)
 *   process/buffers.ts   capped ring buffers / tails                            (process.rs)
 *   sandbox/config.ts    sandbox knobs + shell invocation + env allowlist       (sandbox.rs)
 *   sandbox/child.ts     SandboxChild over node:child_process                   (sandbox.rs)
 *   sandbox/async.ts     timeout race + bounded poll
 *   sandbox/userspace.ts userspace-lite Sandbox implementation (P2c: real isolation)
 *   sandbox/fake-sandbox.ts  scripted FakeSandbox test double (seam replaceability)
 *   builtin.ts           the six builtin tools, sharing one sandbox + registry  (builtin.rs)
 *   plugin.ts            toolsPlugin: provides the three tool services          (plugin.rs)
 */

// --- registry: the dispatch pipeline ------------------------------------------
export { createToolRegistry, humanRender, ToolRegistryImpl } from "./registry.js";
export type { ArgsValidationFailure } from "./schema.js";
export { validateArgs } from "./schema.js";

// --- errors: the structured contract ------------------------------------------
export { contractError, contractFailure, errorCode, errorText, GUARD_ERROR_PREFIX, quoteMessage, TOOLARG_ERROR_PREFIX } from "./errors.js";
export { isToolFailure, ToolFailure } from "./tool-failure.js";
export { fnTool } from "./fn-tool.js";

// --- guard: path whitelist ----------------------------------------------------
export {
  ENV_TOOL_GUARD,
  ENV_TOOL_ROOTS,
  ENV_TOOL_WORKDIR,
  mountProductionGuards,
  parseToolRoots,
  PathGuard,
  PathGuardPolicy,
  type PathGuardPolicyInit,
} from "./guard/path-guard.js";
export { absolutize, canonicalExisting, isDirectory, isInside, resolveExistingTarget, resolveWriteTarget } from "./guard/paths.js";

// --- tools --------------------------------------------------------------------
export { readFileTool, readFileSpec } from "./tools/read-file.js";
export { writeFileTool, writeFileSpec } from "./tools/write-file.js";
export { listDirTool, listDirSpec } from "./tools/list-dir.js";
export { runShellSpec, runShellTool, type RunShellToolOptions } from "./tools/run-shell.js";
export { processControlSpec, processControlTool } from "./tools/process-control.js";
export { httpRequestSpec, httpRequestTool, type HttpRequestToolOptions } from "./tools/http-request.js";
export { builtinTools, type BuiltinToolsOptions } from "./builtin.js";

// --- http policy + transport contract -----------------------------------------
export { ENV_HTTP_ALLOW, ENV_HTTP_DENY, HttpTargetPolicy, ipInRange, parseIpRange, type IpRange } from "./http/ssrf.js";
export { HEADER_SUBSET, pickHeaders, validateHeaderPairs, type HeaderPairs } from "./http/headers.js";
export { MAX_REDIRECT_HOPS } from "./http/redirects.js";
export { HTTP_ERROR_PREFIX, classifyTransportError, httpFailure, TransportError } from "./http/errors.js";
export { MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./tools/http-request.js";

// --- fs limits ----------------------------------------------------------------
export { BINARY_SNIFF_BYTES, isProbablyBinary, listDirNames, MAX_DIR_ENTRIES, MAX_READ_BYTES, readTextFile, truncationNote, writeTextFile } from "./fs/file-io.js";

// --- process registry ---------------------------------------------------------
export {
  COMPLETION_TAIL_BYTES,
  foldNewlines,
  MAX_STREAM_BUFFER,
  RingBuffer,
  TAIL_BYTES,
} from "./process/buffers.js";
export {
  KILL_GRACE_MS,
  KILL_WAIT_MS,
  PROCESS_REGISTRY_SERVICE,
  ProcessRegistry,
  STDIN_WRITE_TIMEOUT_MS,
  type CompletionSink,
  type ProcessCompletion,
  type ProcessHandle,
  type ProcessRegistryOptions,
} from "./process/registry.js";

// --- sandbox (userspace-lite; the OS-isolated provider is P2c) ----------------
export {
  buildSandboxConfig,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS as DEFAULT_SANDBOX_TIMEOUT_MS,
  ENV_ALLOWLIST,
  ENV_SHELL_MAX_OUTPUT_BYTES,
  ENV_SHELL_MAX_TIMEOUT_MS,
  ENV_SHELL_ROOT,
  ENV_SHELL_TIMEOUT_MS,
  ENV_SHELL_WORKDIR,
  gitToplevelOr,
  sandboxConfigFromEnv,
  sanitizedEnv,
  shellInvocation,
  type SandboxConfigOverrides,
} from "./sandbox/config.js";
export { USERSPACE_META, UserspaceSandbox, userspaceSandbox, userspaceSandboxWith } from "./sandbox/userspace.js";
export { readCapped, REAP_GRACE_MS, type CappedText } from "./sandbox/launch.js";
export { resolveWorkdir } from "./sandbox/workdir.js";
// --- sandbox (P2c: OS-isolated provider + provider policy) --------------------
export {
  BWRAP_PROVIDER,
  buildBwrapArgv,
  buildBwrapCommand,
  bwrapMeta,
  DEFAULT_BWRAP_OPTIONS,
  SECCOMP_FD,
  type BwrapOptions,
} from "./sandbox/bwrap-argv.js";
export { BwrapSandbox, bwrapSandbox, bwrapSandboxWith, rlimitVia, type BwrapMeta, type BwrapSandboxOptions } from "./sandbox/bwrap.js";
export {
  ENV_SANDBOX_FALLBACK,
  ENV_SANDBOX_MASK,
  ENV_SANDBOX_NET,
  ENV_SANDBOX_SECCOMP,
  ENV_SANDBOX_SHARE_TMP,
  bwrapOptionsFromEnv,
  fallbackMode,
  selectSandbox,
  selectSandboxDetailed,
  type SandboxFallbackMode,
  type SandboxSelection,
  type SelectOptions,
} from "./sandbox/provider.js";
export {
  countUidThreads,
  DEFAULT_LIMITS,
  deriveNproc,
  ENV_SANDBOX_NPROC,
  ENV_SANDBOX_NPROC_HEADROOM,
  limitsFromEnv,
  NPROC_FLOOR,
  NPROC_HEADROOM,
  rlimitsEnabled,
  type SandboxLimits,
} from "./sandbox/limits.js";
export { ENV_SANDBOX_BWRAP, probeHost, resetProbeCache, whichSync, type HostProbe } from "./sandbox/probe.js";
export { applyLimits, ulimitScript, type RlimitPlan, type RlimitVia } from "./sandbox/rlimit.js";
export { buildSeccompFilter, instructionCount, openSeccompBlob, toBlobBytes, type BpfInstruction } from "./sandbox/seccomp.js";

// --- plugin -------------------------------------------------------------------
export { assembleTools, TOOLS_PLUGIN_NAME, toolsPlugin, type ToolAssembly, type ToolsPluginOptions } from "./plugin.js";
