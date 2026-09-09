# Replay diff report (P0 toolchain)

- generated: 2026-09-09T17:29:23.111Z
- fixtures generated: 2026-09-09T17:28:54.740Z
- strict: true

## Verdict

| metric | value |
|---|---|
| sessions replayed | 5 |
| golden comparisons (Studio messages projection) | 5 |
| **golden divergences** | **0** |
| self-check divergences | 0 |
| structural errors | 0 |
| verdict | match |

## Sessions

| session | roles | events | turns | dangling tool_call | sub-calls (parent_id) | torn tail | turn ids monotonic | outcomes | messages (ts/golden) | golden |
|---|---|---|---|---|---|---|---|---|---|---|
| CelesteaTeamAPI/scratch-cancel-e2e-1788971355.259970577 | session-log, cancelled-outcome | 6 | 1 | 0 | 0 | no | yes | {"cancelled":1} | 4/4 | match |
| CelesteaTeamAPI/scratch-timeout-1788962615.856629520 | session-log, error-outcome | 3 | 1 | 0 | 0 | no | yes | {"error":1} | 1/1 | match |
| CelesteaTeamAPI/test-1788787479.196315272 | session-log, run_code-parent-id, normal-multi-turn | 53 | 6 | 0 | 11 | no | yes | {"completed":6} | 41/41 | match |
| celestea_harness/harness架构哥-1788933931.279221103 | session-log, dangling-tool-call, run_code-parent-id, cancelled-outcome, error-outcome | 606 | 17 | 3 | 11 | no | yes | {"completed":5,"cancelled":1,"error":8} | 575/575 | match |
| server-center/center-架构师-1788940601.93642104 | session-log, normal-multi-turn, error-outcome | 967 | 7 | 0 | 0 | no | yes | {"completed":6,"error":1} | 953/953 | match |

## Findings

| scope | kind | detail |
|---|---|---|
| celestea_harness/harness架构哥-1788933931.279221103 :: sse-transcript | info | derived transcript not stored (large session); regenerated in-memory for this run |
| server-center/center-架构师-1788940601.93642104 :: sse-transcript | info | derived transcript not stored (large session); regenerated in-memory for this run |
| providers public_view | info | 1 provider(s), 0 api_key keys |
| registry.tsv | info | 11 row(s) by_status={"RUNNING":11,"DONE":0,"FAILED":0} |

## What is (and is not) golden at P0

- **Golden (from the running Rust implementation)**: the Studio `messages` projection via `GET /api/sessions/{id}/messages`.
- **Self-check only**: engine `derive_messages` and the SSE transcript — the engine exposes no HTTP surface for them, so the TS reference implementation is compared against its own stored derivation. P1 turns both into golden comparisons.
- A non-empty diff at this stage is expected to be reported, not hidden: `pnpm replay:compare --strict` fails the run when the golden comparison diverges.
