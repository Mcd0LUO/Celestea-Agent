//! W266 regression tests: LLM request timeouts against fake TCP upstreams.
//!
//! The engine used to build a bare `reqwest::Client::new()`, so an upstream
//! that accepted the connection and then never answered hung a whole turn
//! forever. These tests drive [`DeepSeekLlm::generate`] against three
//! hand-rolled upstreams:
//!
//! 1. `Silent`            — accepts, reads the request, never replies
//!                          → response-headers timeout;
//! 2. `OneChunkThenSilent` — 200 + headers + one SSE chunk, then silence
//!                          → stream idle timeout (terminal kind "timeout");
//! 3. `FastStream`        — a normal quick SSE stream ending in [DONE]
//!                          → must NOT be killed by any timeout.
//!
//! Everything runs on an ephemeral 127.0.0.1 port with a dummy key; no network
//! access and no secrets. The live-gateway check at the bottom is `#[ignore]`d
//! and reads the key from the Studio provider file without ever printing it.

use std::time::{Duration, Instant};

use celestea_core::{Llm, Message, ModelRequest, StreamEvent};
use celestea_llm::{DeepSeekConfig, DeepSeekLlm, TIMEOUT_ERROR_PREFIX};
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ---------------------------------------------------------------------------
// fake upstream
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Upstream {
    /// Accept the connection, swallow the request, never write a byte.
    Silent,
    /// Reply 200 + SSE headers + one data chunk, then go silent.
    OneChunkThenSilent,
    /// Reply a normal, fast SSE stream terminated by [DONE].
    FastStream,
}

/// Bind an ephemeral loopback port and serve `behaviour` on every connection.
/// Returns the OpenAI-compatible base URL (no /v1 suffix; generate appends
/// /chat/completions).
async fn spawn_fake_upstream(behaviour: Upstream) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                serve(&mut socket, behaviour).await;
            });
        }
    });
    format!("http://{addr}")
}

async fn serve(socket: &mut TcpStream, behaviour: Upstream) {
    // Consume the request head (plus whatever body bytes arrived) so the
    // client's send() has actually been transmitted before we decide the
    // behaviour.
    let mut buf = [0u8; 4096];
    let mut seen = Vec::new();
    loop {
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                seen.extend_from_slice(&buf[..n]);
                if seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if seen.len() > 64 * 1024 {
                    break;
                }
            }
        }
    }

    match behaviour {
        Upstream::Silent => {
            // Hold the connection open without answering: exactly the wedged
            // gateway that parked a turn forever before W266.
            std::future::pending::<()>().await;
        }
        Upstream::OneChunkThenSilent => {
            write_sse_headers(socket).await;
            // The SSE frame must be terminated by a blank line, otherwise the
            // eventsource decoder holds it back until more bytes arrive.
            write_chunk(socket, "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n")
                .await;
            // Stream is open and then stalls: only the idle guard can end it.
            std::future::pending::<()>().await;
        }
        Upstream::FastStream => {
            write_sse_headers(socket).await;
            for piece in ["He", "llo", " world"] {
                write_chunk(
                    socket,
                    &format!(
                        "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{piece}\"}}}}]}}\n\n"
                    ),
                )
                .await;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            write_chunk(socket, "data: [DONE]\n\n").await;
            // Terminate the chunked body.
            let _ = socket.write_all(b"0\r\n\r\n").await;
            let _ = socket.flush().await;
        }
    }
}

async fn write_sse_headers(socket: &mut TcpStream) {
    let _ = socket
        .write_all(
            b"HTTP/1.1 200 OK\r\n\
              Content-Type: text/event-stream\r\n\
              Cache-Control: no-cache\r\n\
              Transfer-Encoding: chunked\r\n\r\n",
        )
        .await;
    let _ = socket.flush().await;
}

/// Write one HTTP/1.1 chunked-transfer frame carrying `data`.
async fn write_chunk(socket: &mut TcpStream, data: &str) {
    let frame = format!("{:x}\r\n{}\r\n", data.len(), data);
    let _ = socket.write_all(frame.as_bytes()).await;
    let _ = socket.flush().await;
}

// ---------------------------------------------------------------------------
// client helpers
// ---------------------------------------------------------------------------

fn client(base_url: String, response_ms: u64, idle_ms: u64) -> DeepSeekLlm {
    DeepSeekLlm::new(DeepSeekConfig {
        base_url,
        // Dummy value: the fake upstream never checks auth, and nothing here
        // prints it.
        api_key: "dummy-test-key".into(),
        model: "deepseek-v4-flash-0731".into(),
        reasoning_effort: None,
        max_output_tokens: None,
        connect_timeout_ms: 5_000,
        response_timeout_ms: response_ms,
        stream_idle_timeout_ms: idle_ms,
    })
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "deepseek-v4-flash-0731".into(),
        system: None,
        messages: vec![Message::user("ping")],
        tools: vec![],
        max_tokens: Some(16),
        temperature: None,
    }
}

/// Drain a stream with a hard wall-clock guard so a regression cannot hang the
/// test suite (it would surface as a failure, not an infinite run).
async fn collect(stream: celestea_core::LlmStream, guard: Duration) -> Vec<StreamEvent> {
    let mut stream = stream;
    tokio::time::timeout(guard, async move {
        let mut events = Vec::new();
        while let Some(ev) = stream.next().await {
            events.push(ev);
        }
        events
    })
    .await
    .expect("stream must terminate (no hang)")
}

// ---------------------------------------------------------------------------
// 1. response-headers timeout
// ---------------------------------------------------------------------------

#[tokio::test]
async fn silent_upstream_trips_response_header_timeout() {
    let base = spawn_fake_upstream(Upstream::Silent).await;
    let llm = client(base, 300, 5_000);

    let start = Instant::now();
    let err = match llm.generate(request()).await {
        Ok(_) => panic!("an upstream that never answers must surface a timeout error"),
        Err(e) => e,
    };
    let elapsed = start.elapsed();

    assert!(
        elapsed >= Duration::from_millis(250),
        "returned before the response timeout elapsed: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "response-header timeout not honored: {elapsed:?}"
    );

    let msg = err.to_string();
    assert!(
        msg.starts_with(TIMEOUT_ERROR_PREFIX),
        "timeout must be structurally identifiable, got: {msg}"
    );
    assert!(msg.contains("response headers"), "message: {msg}");
    assert!(msg.contains("300ms"), "message: {msg}");
}

// ---------------------------------------------------------------------------
// 2. stream idle timeout
// ---------------------------------------------------------------------------

#[tokio::test]
async fn silent_stream_trips_idle_timeout() {
    let base = spawn_fake_upstream(Upstream::OneChunkThenSilent).await;
    let llm = client(base, 5_000, 300);

    let stream = llm.generate(request()).await.expect("headers arrive quickly");
    let start = Instant::now();
    let events = collect(stream, Duration::from_secs(5)).await;
    let elapsed = start.elapsed();

    // The first chunk is delivered to the consumer before the stream stalls.
    assert!(
        events.iter().any(|e| matches!(e, StreamEvent::Text(t) if t == "Hel")),
        "partial chunk must be surfaced before the idle abort: {events:?}"
    );
    // The stall is terminal and carries the machine-readable timeout kind.
    match events.last().expect("terminal event") {
        StreamEvent::Failed { kind, message } => {
            assert_eq!(kind, "timeout", "message: {message}");
            assert!(
                message.contains("stream idle timeout"),
                "message: {message}"
            );
            assert!(message.contains("300ms"), "message: {message}");
        }
        other => panic!("expected Failed{{kind: timeout}}, got {other:?}"),
    }
    assert!(
        !events.iter().any(|e| matches!(e, StreamEvent::Done(_))),
        "an idle-aborted stream must not report a fake Done"
    );
    assert!(
        elapsed >= Duration::from_millis(250) && elapsed < Duration::from_secs(3),
        "idle timeout timing off: {elapsed:?}"
    );
}

// ---------------------------------------------------------------------------
// 3. fast stream is not killed (regression guard)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fast_stream_completes_without_timeout() {
    let base = spawn_fake_upstream(Upstream::FastStream).await;
    // Deliberately tight guards: the upstream answers immediately and streams
    // chunks every 20ms, so nothing here should trip.
    let llm = client(base, 2_000, 500);

    let stream = llm.generate(request()).await.expect("fast upstream answers");
    let events = collect(stream, Duration::from_secs(5)).await;

    assert!(
        !events.iter().any(|e| matches!(e, StreamEvent::Failed { .. })),
        "healthy stream must not be failed by a timeout: {events:?}"
    );
    match events.last().expect("terminal event") {
        StreamEvent::Done(message) => {
            let text: String = message
                .content
                .iter()
                .filter_map(|c| match c {
                    celestea_core::Content::Text(t) => Some(t.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(text, "Hello world");
        }
        other => panic!("expected Done, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 4. 0 disables a timeout stage
// ---------------------------------------------------------------------------

#[test]
fn zero_disables_timeout_stages() {
    let llm = client("http://127.0.0.1:1".into(), 0, 0);
    let (connect, response, idle) = llm.timeouts();
    assert!(connect.is_some(), "connect timeout stays at the configured 5s");
    assert!(response.is_none(), "response_timeout_ms=0 must disable it");
    assert!(idle.is_none(), "stream_idle_timeout_ms=0 must disable it");
}

// ---------------------------------------------------------------------------
// 5. live gateway check (ignored by default)
// ---------------------------------------------------------------------------

/// Real-machine W266 check against the local Celestea gateway.
///
/// Ignored by default because it needs the gateway on 127.0.0.1:3001 and the
/// Studio provider file. The API key is read from
/// /src/celestea_studio/providers.json at runtime and is never printed, logged
/// or committed.
///
/// Run with:
/// `cargo test -p celestea-llm --test timeout_upstream -- --ignored --nocapture`
#[tokio::test]
#[ignore = "live gateway: needs /src/celestea_studio/providers.json and 127.0.0.1:3001"]
async fn live_deepseek_v4_flash_0731_reports_timeout_within_threshold() {
    const PROVIDERS: &str = "/src/celestea_studio/providers.json";
    const MODEL: &str = "deepseek-v4-flash-0731";
    // The observed wedge lasts >20s (and indefinitely), so a 20s response
    // guard is enough to prove the engine no longer hangs.
    const RESPONSE_MS: u64 = 20_000;

    let raw = std::fs::read_to_string(PROVIDERS)
        .unwrap_or_else(|e| panic!("cannot read {PROVIDERS}: {e}"));
    let json: serde_json::Value = serde_json::from_str(&raw).expect("providers.json is JSON");

    let mut base_url = None;
    let mut api_key = None;
    'outer: for provider in json["providers"].as_array().into_iter().flatten() {
        let has_model = provider["models"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|m| m["id"].as_str() == Some(MODEL));
        if !has_model {
            continue;
        }
        base_url = provider["base_url"].as_str().map(str::to_string);
        api_key = provider["api_key"].as_str().map(str::to_string);
        break 'outer;
    }
    let (base_url, api_key) = match (base_url, api_key) {
        (Some(b), Some(k)) if !k.is_empty() => (b, k),
        _ => {
            eprintln!("[W266 live] no provider offers {MODEL} in {PROVIDERS}; skipping");
            return;
        }
    };

    let llm = DeepSeekLlm::new(DeepSeekConfig {
        base_url,
        api_key,
        model: MODEL.into(),
        reasoning_effort: None,
        max_output_tokens: Some(16),
        connect_timeout_ms: 5_000,
        response_timeout_ms: RESPONSE_MS,
        stream_idle_timeout_ms: RESPONSE_MS,
    });

    let start = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_millis(RESPONSE_MS + 10_000),
        llm.generate(request()),
    )
    .await
    .expect("generate must return within response_timeout + 10s margin");
    let elapsed = start.elapsed();

    match result {
        Err(e) => {
            let msg = e.to_string();
            eprintln!("[W266 live] {MODEL} timed out after {elapsed:?}: {msg}");
            assert!(
                msg.starts_with(TIMEOUT_ERROR_PREFIX),
                "expected a structured timeout, got: {msg}"
            );
            assert!(
                elapsed < Duration::from_millis(RESPONSE_MS + 5_000),
                "timeout must fire within the configured threshold: {elapsed:?}"
            );
        }
        Ok(stream) => {
            let events = collect(stream, Duration::from_secs(120)).await;
            eprintln!(
                "[W266 live] {MODEL} answered within {elapsed:?} ({} events); upstream currently healthy",
                events.len()
            );
            assert!(
                !events
                    .iter()
                    .any(|e| matches!(e, StreamEvent::Failed { kind, .. } if kind == "timeout")),
                "healthy upstream must not be failed by the timeout guard"
            );
        }
    }
}
