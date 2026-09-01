# celestea_harness

An "everything is a plugin" AI agent harness in Rust, inspired by DeepSeek Harness.

- Core seams live in crates/core/src/lib.rs (the pinned contracts).
- See ARCHITECTURE.md for the design and module ownership.

## Build

cargo build

## Run the CLI (after the crates are implemented)

cargo run -p celestea-cli -- --profile profile.json
