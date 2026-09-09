# Contract probe evidence (live :3777, read-only)

- generated: 2026-09-09T17:29:21.881Z
- target: http://127.0.0.1:3777
- policy: read-only: GET probes + error branches proven mutation-free in the Rust source

## Verdict

| metric | value |
|---|---|
| checks | 25 |
| passed | 25 |
| failed | 0 |
| **endpoints sampled** | **20** |
| SSE event names frozen | 8 |
| tool specs | 10 |
| verdict | consistent |

## Checks

| endpoint | kind | status | observed | detail |
|---|---|---|---|---|
| contracts/endpoints.json | contract-count | pass | - | 39 endpoints (expected 39) |
| contracts/sse-events.json | contract-count | pass | - | 8 SSE events (expected 8) |
| contracts/tools.json | contract-count | pass | - | 10 tool specs (expected 10) |
| GET /api/health | response-shape | pass | 200 | HTTP 200; 5 key(s) |
| GET /api/status | response-shape | pass | 200 | HTTP 200; 7 key(s) |
| GET /api/tools | response-shape | pass | 200 | HTTP 200; 1 key(s) |
| GET /api/config | response-shape | pass | 200 | HTTP 200; 10 key(s) |
| GET /api/sessions | response-shape | pass | 200 | HTTP 200; 2 key(s) |
| GET /api/sessions/{id}/messages | response-shape | pass | 200 | HTTP 200; 3 key(s) |
| GET /api/workspaces | response-shape | pass | 200 | HTTP 200; 2 key(s) |
| GET /api/fs/browse | response-shape | pass | 200 | HTTP 200; 4 key(s) |
| GET /api/providers | response-shape | pass | 200 | HTTP 200; 2 key(s) |
| GET /api/prompts | response-shape | pass | 200 | HTTP 200; 8 key(s) |
| GET /api/worker/status | response-shape | pass | 200 | HTTP 200; 5 key(s); optional absent: error, wid |
| POST /api/turn | error-branch | pass | 400 | HTTP 400 + "input must not be empty" |
| POST /api/cancel | error-branch | pass | 200 | HTTP 200 |
| POST /api/workspaces | error-branch | pass | 400 | HTTP 400 + "path must not be empty" |
| POST /api/providers/test | error-branch | pass | 400 | HTTP 400 + "base_url" |
| POST /api/prompts | error-branch | pass | 400 | HTTP 400 + "prompt id must be 1-128 chars" |
| POST /api/prompts/__p0_probe_missing__/default | error-branch | pass | 404 | HTTP 404 + "unknown prompt" |
| GET /api/sessions/no-slash/messages | error-branch | pass | 400 | HTTP 400 + "invalid session id" |
| GET /api/fs/browse?path=relative-not-absolute | error-branch | pass | 400 | HTTP 400 + "must be absolute" |
| GET /api/worker/status?wid=__p0_probe_missing__ | error-branch | pass | 200 | HTTP 200 + "no worker" |
| GET /api/events | sse-transport | pass | 200 | content-type=text/event-stream; envelope + 8 event names frozen from source (passive connect, no turn running) |
| GET /api/tools | tool-set | pass | 200 | 10 names match contracts/tools.json exactly |

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
