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
 *   exposure.ts          exposedRegistry: the per-mode model-visible face  (W791 §5.2)
 *   schema.ts            JSON-Schema subset validator (pipeline stage 1)
 *   args.ts              argument readers with parity error text
 *   desc.ts              the shared `desc` UI-label parameter of every tool   (W779)
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
 *   tools/load-skill.ts  load_skill: one SKILL.md body on demand (W884)
 *   tools/memory.ts      remember / forget: append-only workspace memory (F3 P1)
 *   tools/run_shell      run_shell: orchestration over the Sandbox seam         (builtin.rs, sandbox.rs)
 *   tools/process-control.ts  process_control (poll / stdin / kill)             (process.rs)
 *   tools/http-request.ts     http_request (SSRF, timeout, truncation)          (http.rs)
 *   tools/run-code.ts    run_code: the broker tool + late-bound RegistryHandle   (run_code.rs)
 *   run-code/sdk.ts      the injected Python SDK preamble + runner + assembly    (run_code.rs)
 *   run-code/limits.ts   hard limits + env-tuned broker config                   (run_code.rs)
 *   run-code/lines.ts    newline-framed line reader + UTF-8-safe byte budgets  (run_code.rs)
 *   run-code/broker.ts   the parent broker loop: dispatch, ledger, events        (run_code.rs)
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
export {
  EXECUTION_GUIDANCE,
  EXECUTION_TOOL_NAMES,
  executionExposure,
  exposedRegistry,
  exposedSpecs,
  faceForMode,
  TOOL_UNAVAILABLE_CODE,
  unavailableError,
  type ExposureOptions,
} from "./exposure.js";
export type { ArgsValidationFailure } from "./schema.js";

// --- disclosure (W806): the cache-safe second hidden layer --------------------
export {
  DisclosurePolicy,
  disclosureExposure,
  type DisclosureGuidance,
  type DisclosurePolicyOptions,
  type DisclosureSnapshot,
} from "./disclosure.js";
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
  PATH_ACCESS,
  PATH_ARG_KEYS,
  PathGuard,
  PathGuardPolicy,
  type PathAccess,
  type PathGuardGrants,
  type PathGuardPolicyInit,
} from "./guard/path-guard.js";
export { absolutize, canonicalExisting, isDirectory, isInside, resolveExistingTarget, resolveWriteTarget } from "./guard/paths.js";

// --- tools --------------------------------------------------------------------
export { readFileTool, readFileSpec } from "./tools/read-file.js";
export { writeFileTool, writeFileSpec } from "./tools/write-file.js";
export { listDirTool, listDirSpec } from "./tools/list-dir.js";
export { runShellSpec, runShellTool, type RunShellToolOptions } from "./tools/run-shell.js";
export { processControlSpec, processControlTool } from "./tools/process-control.js";
export { RegistryHandle, runCodeSpec, runCodeTool, runCodeToolWithHandle, type RunCodeToolOptions } from "./tools/run-code.js";
export { httpRequestSpec, httpRequestTool, type HttpRequestToolOptions } from "./tools/http-request.js";
export { ASK_USER_DESCRIPTION, askUserSpec, askUserTool, type AskUserToolOptions } from "./tools/ask-user.js";
export { READ_IMAGE_DESCRIPTION, readImageSpec, readImageTool, type ReadImageToolOptions } from "./tools/read-image.js";
export { LOAD_SKILL_DESCRIPTION, LOAD_SKILL_ERROR_PREFIX, loadSkillSpec, loadSkillTool, type LoadSkillToolOptions } from "./tools/load-skill.js";
export {
  FORGET_DESCRIPTION,
  MEMORY_ERROR_PREFIX,
  REMEMBER_DESCRIPTION,
  forgetSpec,
  forgetTool,
  rememberSpec,
  rememberTool,
  type MemoryToolOptions,
} from "./tools/memory.js";
export {
  MEMORY_ENTRIES_FILE_NAME,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_LOG_VERSION,
  findEntryByText,
  foldMemoryLog,
  memoryEntryPaths,
  memoryLogHeader,
  memoryTextHash,
  nextMemoryId,
  parseMemoryLog,
  renderMemoryMarkdown,
  serializeMemoryLine,
  type MemoryEntryLine,
  type MemoryForgetLine,
  type MemoryLogLine,
  type MemoryLogState,
} from "./memory/log.js";
export { appendMemoryLine, memoryStoreOf, nodeMemoryStoreIo, readMemoryLog, readMemoryState, type MemoryStore, type MemoryStoreIo } from "./memory/store.js";
export { builtinTools, type BuiltinToolsOptions } from "./builtin.js";

// --- attachments (W804): the per-session content-addressed image store ---------
export {
  ATTACHMENTS_DIRNAME,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PIXELS,
  ATTACHMENT_MAX_SIDE,
  AttachmentError,
  createAttachmentStore,
  readImageDimensions,
  sniffImageMediaType,
  type AttachmentErrorCode,
  type AttachmentStore,
  type StoredAttachment,
} from "./attachments/store.js";

// --- http policy + transport contract -----------------------------------------
export {
  ENV_HTTP_ALLOW,
  ENV_HTTP_DENY,
  HttpTargetPolicy,
  ipInRange,
  parseIpRange,
  resolveTargets,
  type CheckedTarget,
  type HostResolver,
  type HttpTargetPolicyOptions,
  type IpRange,
  type SsrfGrantView,
} from "./http/ssrf.js";
export { HEADER_SUBSET, pickHeaders, validateHeaderPairs, type HeaderPairs } from "./http/headers.js";
export { MAX_REDIRECT_HOPS } from "./http/redirects.js";
export { pinnedLookup, requestOnce, type TransportRequest, type TransportResult } from "./http/transport.js";
export { HTTP_ERROR_PREFIX, classifyTransportError, httpFailure, TransportError } from "./http/errors.js";
export { MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./tools/http-request.js";

// --- fs limits ----------------------------------------------------------------
export { BINARY_SNIFF_BYTES, DEFAULT_READ_LIMIT, isProbablyBinary, listDirNames, MAX_DIR_ENTRIES, MAX_READ_BYTES, readTextFile, readTextLines, truncationNote, writeTextFile } from "./fs/file-io.js";

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

// --- platform seam (W885: injectable platform + shell resolution) ---------------
export {
  ENV_SHELL_PIN,
  ShellNotFoundError,
  execSuffixes,
  envValue,
  isWindows,
  kindOfExecutable,
  lookupFor,
  pathApi,
  pathDelimiter,
  resolveShell,
  resolveShellKind,
  shellArgv,
  whichInPath,
  WINDOWS_EXEC_SUFFIXES,
  type PlatformInput,
  type ResolvedShell,
  type ShellKind,
  type ShellLookup,
  type ShellResolveInput,
} from "./platform/index.js";
export {
  PYTHON_CANDIDATES_POSIX,
  PYTHON_CANDIDATES_WINDOWS,
  pythonCandidates,
  quoteCmd,
  quoteForShell,
  quotePath,
  quoteWord,
  runCodeCommand,
  shellQuote,
  type RunCodeLanguageName,
} from "./platform/quote.js";
export { taskkillTree } from "./sandbox/child.js";

// --- testing capability gates (W885: visible skips instead of bare platform checks)
export {
  FILE_MODES_MEANINGFUL,
  POSIX_PROCESS_GROUPS,
  POSIX_SHELL,
  platformGates,
  whichUsable,
  type PlatformGates,
} from "./testing/platform-gates.js";

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
  sessionSandboxConfig,
  shellInvocation,
  type SandboxConfigOverrides,
  type SessionFsScope,
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
  type SandboxGrantView,
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
export {
  assembleTools,
  httpOptions,
  TOOLS_PLUGIN_NAME,
  toolsPlugin,
  type RunCodeMount,
  type ToolAssembly,
  type ToolAssemblyGrants,
  type ToolsPluginOptions,
} from "./plugin.js";

// --- run_code (W255: Python parent-broker + SDK) ------------------------------
export { assembleProgram, firstNonblankLineIndented, RUN_CODE_RUNNER, RUN_CODE_SDK } from "./run-code/sdk.js";
export {
  clampTimeoutMs,
  DEFAULT_TIMEOUT_MS as RUN_CODE_DEFAULT_TIMEOUT_MS,
  ENV_RUN_CODE_TIMEOUT_MS,
  EXIT_GRACE_MS,
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  MAX_SUB_CALLS,
  MAX_SUB_OUTPUT_BYTES,
  MAX_TIMEOUT_MS as RUN_CODE_MAX_TIMEOUT_MS,
  resolveTimeoutMs,
  RUN_CODE_ERROR_PREFIX,
  runCodeConfig,
  runCodeConfigFromEnv,
  SDK_TOOLS,
  type RunCodeConfig,
} from "./run-code/limits.js";
export { brokerRun, type BrokerContext, type RunCodeEventSink } from "./run-code/broker.js";
export { appendBounded, jsonByteLength, LineReader, safeUtf8, tail, truncateValue, utf8Prefix, type BoundedLine } from "./run-code/lines.js";

// --- browser (F4: session-scoped headless browser over zero-dep CDP) ----------
export {
  assertHttpUrl,
  BROWSER_ACT_DESCRIPTION,
  BROWSER_OPEN_DESCRIPTION,
  browserActSpec,
  browserActTool,
  browserOpenSpec,
  browserOpenTool,
  type BrowserToolOptions,
} from "./tools/browser.js";
export {
  ADDRESS_SPACE_NOTE,
  BrowserManager,
  DEFAULT_BROWSER_MAX_BYTES,
  DEFAULT_BROWSER_MAX_NODES,
  DEFAULT_BROWSER_STARTUP_MS,
  type BrowserActRequest,
  type BrowserIsolation,
  type BrowserManagerOptions,
  type BrowserRef,
  type BrowserResult,
  type BrowserScreenshot,
  type BrowserSnapshotValue,
  type BrowserViewport,
} from "./browser/session.js";
export {
  armMemoryGuard,
  DEFAULT_BROWSER_MEMORY_MB,
  readOwnCgroupPath,
  readTreeRssKb,
  type MemoryGuard,
  type MemoryGuardKind,
  type MemoryGuardStatus,
} from "./browser/memory-guard.js";
export {
  buildAxSnapshot,
  collectBoxes,
  isInteractiveRole,
  quadToBox,
  type AxSnapshot,
  type SnapshotOptions,
  type SnapshotRef,
} from "./browser/snapshot.js";
export {
  attachBrowser,
  BrowserNotFoundError,
  BrowserStartupError,
  findHeadlessShell,
  launchBrowser,
  parseDevToolsEndpoint,
  type AttachedBrowser,
  type BrowserProcess,
  type LaunchedBrowser,
} from "./browser/launch.js";
export { CdpClient, CdpClosedError, CdpProtocolError, CdpTimeoutError, CdpTransportError, openWebSocketTransport, WebSocketTransport, type CdpTransport } from "./browser/cdp.js";
