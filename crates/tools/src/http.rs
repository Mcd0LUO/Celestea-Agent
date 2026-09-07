//! W242 C: the `http_request` builtin tool — guarded HTTP(S) fetch for the
//! agent. Only http/https URLs are allowed, redirects are capped at 5 hops,
//! the response body is truncated at 1 MiB (`truncated:true` beyond), and
//! transport failures are categorized (timeout / dns / connect / redirect /
//! invalid_url / invalid_arg). HTTP error statuses are NOT tool errors — the
//! caller gets `{status, headers, body, truncated}` and decides. Requests go
//! out directly (no ambient proxy from the environment), with a per-call
//! timeout (default 15s, cap 60s).

use std::sync::OnceLock;
use std::time::Duration;

use celestea_core::{Tool, ToolSpec};
use serde_json::{json, Value};

use crate::builtin::fn_tool;

/// Default per-request timeout (ms).
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// Maximum per-request timeout (ms).
const MAX_TIMEOUT_MS: u64 = 60_000;
/// Response body cap (1 MiB); beyond this `truncated:true`.
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// Response headers echoed back to the caller (subset; values joined).
const HEADER_SUBSET: &[&str] = &[
    "content-type",
    "content-length",
    "content-encoding",
    "cache-control",
    "etag",
    "last-modified",
    "location",
    "server",
    "www-authenticate",
    "retry-after",
    "date",
];

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .no_proxy()
            .build()
            .expect("http_request client construction must not fail")
    })
}

fn http_request_spec() -> ToolSpec {
    ToolSpec {
        name: "http_request".into(),
        description: "Send an HTTP(S) request and return {status, headers(subset), body, truncated}. Only http/https URLs are allowed (file:// etc. rejected); redirects are followed up to 5 hops; the response body is truncated at 1MB (truncated:true beyond). HTTP error statuses are preserved in `status` — not tool errors; transport failures are categorized as timeout | dns | connect | redirect | invalid_url | invalid_arg.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "method": { "type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"], "description": "HTTP method (default GET)." },
                "url": { "type": "string", "description": "Target URL; only http/https schemes are allowed." },
                "headers": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Optional request headers as {name: value}." },
                "body": { "type": "string", "description": "Optional request body string." },
                "timeout_ms": { "type": "integer", "minimum": 1, "description": "Optional timeout in milliseconds (default 15000, maximum 60000)." }
            },
            "required": ["url"],
            "additionalProperties": false
        }),
    }
}

pub(crate) fn http_request_tool() -> Box<dyn Tool> {
    fn_tool(http_request_spec(), |args| {
        Box::pin(async move { http_request_impl(&args).await })
    })
}

fn contract_err(code: &str, msg: impl Into<String>) -> Result<Value, String> {
    Err(format!("http_request: code={code} msg={}", msg.into()))
}

async fn http_request_impl(args: &Value) -> Result<Value, String> {
    let url_str = match args.get("url").and_then(Value::as_str) {
        Some(u) if !u.trim().is_empty() => u.trim(),
        _ => return contract_err("invalid_arg", "url required"),
    };
    // Guard: parse first, then insist on http/https (file:// etc. rejected).
    let url = match reqwest::Url::parse(url_str) {
        Ok(u) => u,
        Err(e) => return contract_err("invalid_url", format!("unparseable url: {e}")),
    };
    match url.scheme() {
        "http" | "https" => {}
        other => return contract_err("invalid_url", format!("scheme '{other}' not allowed (only http/https)")),
    }

    let method = match args.get("method").and_then(Value::as_str) {
        None | Some("GET") => reqwest::Method::GET,
        Some(m) => match m.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            "PATCH" => reqwest::Method::PATCH,
            "HEAD" => reqwest::Method::HEAD,
            other => return contract_err("invalid_arg", format!("unsupported method: {other}")),
        },
    };

    let timeout_ms = match args.get("timeout_ms").and_then(Value::as_i64) {
        None => DEFAULT_TIMEOUT_MS,
        Some(ms) => {
            if ms < 1 {
                return contract_err("invalid_arg", format!("timeout_ms must be >= 1, got {ms}"));
            }
            if ms as u64 > MAX_TIMEOUT_MS {
                return contract_err(
                    "invalid_arg",
                    format!("timeout_ms={ms} exceeds the maximum {MAX_TIMEOUT_MS}ms"),
                );
            }
            ms as u64
        }
    };

    let mut request = client()
        .request(method, url.clone())
        .timeout(Duration::from_millis(timeout_ms));

    if let Some(headers) = args.get("headers").and_then(Value::as_object) {
        for (k, v) in headers {
            let Some(v) = v.as_str() else {
                return contract_err("invalid_arg", format!("header '{k}' value must be a string"));
            };
            let name = match reqwest::header::HeaderName::from_bytes(k.as_bytes()) {
                Ok(n) => n,
                Err(e) => return contract_err("invalid_arg", format!("bad header name '{k}': {e}")),
            };
            match reqwest::header::HeaderValue::from_str(v) {
                Ok(val) => {
                    request = request.header(name, val);
                }
                Err(e) => return contract_err("invalid_arg", format!("bad header value for '{k}': {e}")),
            }
        }
    }

    if let Some(body) = args.get("body").and_then(Value::as_str) {
        request = request.body(body.to_string());
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return Err(classify_error(e, &url).await),
    };

    let status = response.status().as_u16();
    let headers = subset_headers(response.headers());

    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = response;
    loop {
        match stream.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > MAX_BODY_BYTES {
                    let take = MAX_BODY_BYTES - buf.len();
                    buf.extend_from_slice(&chunk[..take]);
                    truncated = true;
                    break;
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(classify_error(e, &url).await),
        }
    }

    Ok(json!({
        "ok": true,
        "status": status,
        "headers": headers,
        "body": String::from_utf8_lossy(&buf).into_owned(),
        "truncated": truncated,
    }))
}

/// Categorize a transport failure: timeout / dns / connect / redirect / other.
/// DNS vs connect refusal is separated with a best-effort hostname lookup:
/// if the name cannot even be resolved the failure is `dns`, otherwise the
/// connection itself failed (`connect`).
async fn classify_error(e: reqwest::Error, url: &reqwest::Url) -> String {
    if e.is_timeout() {
        return format!("http_request: code=timeout msg={e}");
    }
    if e.is_redirect() {
        return format!("http_request: code=redirect msg={e}");
    }
    if e.is_connect() {
        let host = url.host_str().unwrap_or_default();
        let port = url.port_or_known_default().unwrap_or(80);
        let kind = match tokio::net::lookup_host((host, port)).await {
            Ok(_) => "connect",
            Err(_) => "dns",
        };
        return format!("http_request: code={kind} msg={e}");
    }
    format!("http_request: code=other msg={e}")
}

fn subset_headers(headers: &reqwest::header::HeaderMap) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for name in HEADER_SUBSET {
        let values: Vec<String> = headers
            .get_all(*name)
            .into_iter()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect();
        if !values.is_empty() {
            out.insert((*name).to_string(), Value::String(values.join(", ")));
        }
    }
    out
}
