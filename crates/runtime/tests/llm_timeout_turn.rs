//! W266 end-to-end: a wedged upstream must end the TURN, not hang it.
//!
//! Studio's reported symptom was a turn stuck in "running" forever because the
//! LLM transport had no timeouts. This test drives a real composed [Runtime]
//! (agent loop + DeepSeek adapter) against fake TCP upstreams and asserts the
//! turn terminates with a structured `TurnOutcome::Error`, within the
//! configured threshold:
//!
//!  * silent upstream (never answers)  → kind "generate" (generate() returns a
//!    structured LlmError whose message starts with "llm timeout");
//!  * headers + one chunk then silence → kind "timeout" (stream idle abort).
//!
//! No real network, no secrets: the key is a dummy env value.

use std::sync::Arc;
use std::time::{Duration, Instant};

use celestea_runtime::{EventSink, Profile, Runtime, TurnOutcome};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Copy)]
enum Upstream {
    /// Accept the connection, swallow the request, never answer.
    Silent,
    /// 200 + headers + one SSE chunk, then silence.
    OneChunkThenSilent,
}

async fn spawn_upstream(behaviour: Upstream) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move { serve(&mut socket, behaviour).await });
        }
    });
    format!("http://{addr}")
}

async fn serve(socket: &mut TcpStream, behaviour: Upstream) {
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
            }
        }
    }
    match behaviour {
        Upstream::Silent => std::future::pending::<()>().await,
        Upstream::OneChunkThenSilent => {
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                      Transfer-Encoding: chunked\r\n\r\n",
                )
                .await;
            let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n";
            let frame = format!("{:x}\r\n{}\r\n", payload.len(), payload);
            let _ = socket.write_all(frame.as_bytes()).await;
            let _ = socket.flush().await;
            std::future::pending::<()>().await;
        }
    }
}

/// Compose a Runtime pointed at `base_url` with a short timeout for the stage
/// under test; the api key is a dummy env value.
fn runtime_for(base_url: String, response_ms: u64, idle_ms: u64) -> Runtime {
    let key_env = "W266_TEST_API_KEY";
    std::env::set_var(key_env, "dummy-test-key");
    let profile = Profile {
        model: "deepseek-v4-flash-0731".into(),
        base_url: Some(base_url),
        api_key_env: key_env.into(),
        llm_connect_timeout_ms: Some(5_000),
        llm_response_timeout_ms: Some(response_ms),
        llm_stream_idle_timeout_ms: Some(idle_ms),
        ..Profile::default()
    };
    let rt = Runtime::compose(&profile).expect("compose runtime");
    std::env::remove_var(key_env);
    rt
}

/// Swallow loop events so the test does not print streamed deltas.
fn quiet_sink() -> Option<EventSink> {
    Some(Arc::new(|_| {}))
}

#[tokio::test]
async fn wedged_upstream_ends_turn_with_generate_error_instead_of_hanging() {
    let base = spawn_upstream(Upstream::Silent).await;
    let rt = runtime_for(base, 500, 5_000);

    let start = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(10), rt.run_turn("hi", None, quiet_sink()))
        .await
        .expect("the turn must terminate (this is the W266 regression)")
        .expect("run_turn returns a terminal outcome");
    let elapsed = start.elapsed();

    match outcome {
        TurnOutcome::Error { kind, message } => {
            assert_eq!(kind, "generate", "message: {message}");
            assert!(message.starts_with("llm timeout"), "message: {message}");
            assert!(message.contains("response headers"), "message: {message}");
        }
        other => panic!("expected Error{{kind: generate}}, got {other:?}"),
    }
    assert!(elapsed < Duration::from_secs(5), "turn took too long: {elapsed:?}");
}

#[tokio::test]
async fn stalled_stream_ends_turn_with_timeout_kind() {
    let base = spawn_upstream(Upstream::OneChunkThenSilent).await;
    let rt = runtime_for(base, 5_000, 500);

    let start = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(10), rt.run_turn("hi", None, quiet_sink()))
        .await
        .expect("the turn must terminate on an idle stream")
        .expect("run_turn returns a terminal outcome");
    let elapsed = start.elapsed();

    match outcome {
        TurnOutcome::Error { kind, message } => {
            assert_eq!(kind, "timeout", "message: {message}");
            assert!(message.contains("stream idle timeout"), "message: {message}");
        }
        other => panic!("expected Error{{kind: timeout}}, got {other:?}"),
    }
    assert!(elapsed < Duration::from_secs(5), "turn took too long: {elapsed:?}");
}
