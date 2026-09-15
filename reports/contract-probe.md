# Contract probe evidence (live :3777, read-only)

- generated: 2026-09-15T12:25:35.120Z
- target: http://127.0.0.1:3777
- policy: read-only: GET probes + error branches proven mutation-free in the Rust source

## Verdict

| metric | value |
|---|---|
| checks | 27 |
| passed | 27 |
| failed | 0 |
| **endpoints sampled** | **22** |
| SSE event names frozen | 9 |
| tool specs | 11 |
| verdict | consistent |

## Checks

| endpoint | kind | status | observed | detail |
|---|---|---|---|---|
| contracts/endpoints.json | contract-count | pass | - | 50 endpoints (contract declares 50) |
| contracts/sse-events.json | contract-count | pass | - | 9 SSE events (contract declares 9) |
| contracts/tools.json | contract-count | pass | - | 11 tool specs (contract declares 11) |
| GET /api/health | response-shape | pass | 200 | HTTP 200; 6 key(s) |
| GET /api/status | response-shape | pass | 200 | HTTP 200; 13 key(s); additive (not in contract doc): busy, effective_model, fallback, grants_active |
| GET /api/tools | response-shape | pass | 200 | HTTP 200; 1 key(s) |
| GET /api/config | response-shape | pass | 200 | HTTP 200; 10 key(s) |
| GET /api/sessions | response-shape | pass | 200 | HTTP 200; 2 key(s) |
| GET /api/sessions/{id}/messages | response-shape | pass | 200 | HTTP 200; 3 key(s) |
| GET /api/workspaces | response-shape | pass | 200 | HTTP 200; 2 key(s) |
| GET /api/fs/browse | response-shape | pass | 200 | HTTP 200; 4 key(s) |
| GET /api/providers | response-shape | pass | 200 | HTTP 200; 2 key(s) |
| GET /api/prompts | response-shape | pass | 200 | HTTP 200; 8 key(s) |
| GET /api/worker/status | response-shape | pass | 200 | HTTP 200; 6 key(s); optional absent: error, wid; additive (not in contract doc): watchdogs |
| GET /login | response-shape | pass | 200 | HTTP 200; HTML login page (text/html) — no JSON keys to compare |
| GET /auth/check | response-shape | pass | 401 | HTTP 401; cookie-gated, so the documented 401 "unauthorized" branch is the correct answer for an unauthenticated probe |
| POST /api/turn | error-branch | pass | 400 | HTTP 400 + "input must not be empty" |
| POST /api/cancel | error-branch | pass | 200 | HTTP 200 |
| POST /api/workspaces | error-branch | pass | 400 | HTTP 400 + "path must not be empty" |
| POST /api/providers/test | error-branch | pass | 400 | HTTP 400 + "base_url" |
| POST /api/prompts | error-branch | pass | 400 | HTTP 400 + "prompt id must be 1-128 chars" |
| POST /api/prompts/__p0_probe_missing__/default | error-branch | pass | 404 | HTTP 404 + "unknown prompt" |
| GET /api/sessions/no-slash/messages | error-branch | pass | 400 | HTTP 400 + "invalid session id" |
| GET /api/fs/browse?path=relative-not-absolute | error-branch | pass | 400 | HTTP 400 + "must be absolute" |
| GET /api/worker/status?wid=__p0_probe_missing__ | error-branch | pass | 200 | HTTP 200 + "no worker" |
| GET /api/events | sse-transport | pass | 200 | content-type=text/event-stream; envelope + 9 event names frozen from source (passive connect, no turn running) |
| GET /api/tools | tool-set | pass | 200 | 11 names match contracts/tools.json exactly |

## Mutation safety of the error-branch probes

| endpoint | why it cannot mutate |
|---|---|
| POST /api/turn | src/main.rs:986-991 rejects a blank input BEFORE the busy slot is taken |
| POST /api/cancel | src/main.rs:1028-1037 only signals the watch channel; no state is written |
| POST /api/workspaces | src/workspaces.rs:825-827 validates before WorkspaceRegistry::register |
| POST /api/providers/test | src/providers.rs:729-735 builds an inline candidate and fails before run_probe; never persists |
| POST /api/prompts | src/prompts.rs:748-751 validates the id before load_prompt_file/persist |
| POST /api/prompts/__p0_probe_missing__/default | src/prompts.rs:857-860 returns 404 before any persist |
| GET /api/sessions/no-slash/messages | parse_session_id rejects the id before any filesystem access |
| GET /api/fs/browse?path=relative-not-absolute | pure read-only directory listing |
| GET /api/worker/status?wid=__p0_probe_missing__ | read-only registry lookup |
