# rust-parity-probe

A ~80-line read-only probe that links the **real** Rust engine crates
(`celestea-core`, `celestea-session`) and prints the canonical
`derive_messages` JSON for one `cli-main.jsonl`:

```sh
cargo run --offline -- <path/to/cli-main.jsonl>
# {"path":…,"events":967,"next_turn_id":"turn-0","messages":[…]}
```

Output shape per message (the Rust `Message` model, serde tagged content):

```json
{"role":"assistant","content":[{"type":"tool_call","content":{"id":"c1","name":"run_shell","args":{…}}}],"tool_call_id":null}
```

## Why it exists

`fixtures/sessions/*/derive-messages-expected.json` is a **Rust golden**: the
engine exposes `derive_messages` over HTTP nowhere, so the P1 golden was
produced by this probe and is asserted field-for-field against the TS
implementation by `packages/session/src/parity.test.ts`.

Regenerate the goldens (from the repo root):

```sh
for d in fixtures/sessions/*/; do
  cargo run --offline --quiet --manifest-path packages/session/tools/rust-parity-probe/Cargo.toml -- "$d/cli-main.jsonl"
done
```

The two path dependencies point at `/src/celestea_harness` (the Rust source of
truth). Building writes only to this crate's own `target/`; the harness tree is
never modified.
