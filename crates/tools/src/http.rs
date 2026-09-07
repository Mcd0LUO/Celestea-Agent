//! W242 C: the `http_request` builtin tool — guarded HTTP(S) fetch for the
//! agent. Only http/https URLs are allowed, redirects are capped at 5 hops,
//! the response body is truncated at 1 MiB (`truncated:true` beyond), and
//! transport failures are categorized (timeout / dns / connect / redirect /
//! invalid_url / invalid_arg). HTTP error statuses are NOT tool errors — the
//! caller gets `{status, headers, body, truncated}` and decides. Requests go
//! out directly (no ambient proxy from the environment), with a per-call
//! timeout (default 15s, cap 60s).
//!
//! W249 P0-3 (optional SSRF authorization): `CELESTEA_HTTP_ALLOW` /
//! `CELESTEA_HTTP_DENY` carry comma-separated IP/CIDR entries (e.g.
//! `127.0.0.1/8,::1`). Default (unset): allow all — the status quo, logged
//! once per process as `SSRF guard off`. When a policy is active:
//! - hostname targets are resolved and EVERY resolved IP must pass the policy
//!   (fail-closed; a resolution failure is categorized `dns`);
//! - reqwest's own redirect following is disabled and the tool re-implements
//!   the 5-hop cap, re-checking every hop target, so redirects cannot hop
//!   outside the policy.
//! Residual surface (documented): the check resolves hostnames itself while
//! reqwest resolves again internally — a DNS-rebinding / TOCTOU window
//! remains between the policy check and the connection.

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

/// Env var: comma-separated IP/CIDR allow list for http_request targets.
pub const ENV_HTTP_ALLOW: &str = "CELESTEA_HTTP_ALLOW";
/// Env var: comma-separated IP/CIDR deny list for http_request targets.
pub const ENV_HTTP_DENY: &str = "CELESTEA_HTTP_DENY";

// ---- W249 P0-3: optional SSRF target policy ---------------------------------

/// A parsed IP prefix (IPv4 or IPv6 CIDR; bare IPs get a full-length prefix).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IpRange {
    v4: Option<([u8; 4], u8)>,
    v6: Option<([u8; 16], u8)>,
}

impl IpRange {
    fn parse(s: &str) -> Result<Self, String> {
        let (base, prefix) = match s.split_once('/') {
            Some((b, p)) => (b.trim(), Some(p.trim())),
            None => (s.trim(), None),
        };
        if let Ok(v4) = base.parse::<std::net::Ipv4Addr>() {
            let prefix = match prefix {
                None => 32,
                Some(p) => p
                    .parse::<u8>()
                    .map_err(|_| format!("bad ipv4 prefix '{p}' in '{s}'"))?,
            };
            if prefix > 32 {
                return Err(format!("ipv4 prefix >32 in '{s}'"));
            }
            return Ok(IpRange { v4: Some((v4.octets(), prefix)), v6: None });
        }
        if let Ok(v6) = base.parse::<std::net::Ipv6Addr>() {
            let prefix = match prefix {
                None => 128,
                Some(p) => p
                    .parse::<u8>()
                    .map_err(|_| format!("bad ipv6 prefix '{p}' in '{s}'"))?,
            };
            if prefix > 128 {
                return Err(format!("ipv6 prefix >128 in '{s}'"));
            }
            return Ok(IpRange { v4: None, v6: Some((v6.octets(), prefix)) });
        }
        Err(format!("unparseable ip/cidr '{s}'"))
    }

    fn contains(&self, ip: &std::net::IpAddr) -> bool {
        match (self, ip) {
            (IpRange { v4: Some((addr, prefix)), .. }, std::net::IpAddr::V4(ip)) => {
                let a = u32::from_be_bytes(*addr);
                let i = u32::from_be_bytes(ip.octets());
                let mask = if *prefix == 0 { 0 } else { !0u32 << (32 - *prefix) };
                (a & mask) == (i & mask)
            }
            (IpRange { v6: Some((addr, prefix)), .. }, std::net::IpAddr::V6(ip)) => {
                let a = u128::from_be_bytes(*addr);
                let i = u128::from_be_bytes(ip.octets());
                let mask = if *prefix == 0 { 0 } else { !0u128 << (128 - *prefix) };
                (a & mask) == (i & mask)
            }
            _ => false,
        }
    }
}

/// SSRF target policy for http_request (W249 P0-3). `Default` = allow all
/// (the pre-P0-3 status quo).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpTargetPolicy {
    allow: Vec<IpRange>,
    deny: Vec<IpRange>,
    /// fail-closed: the env knobs were set but unparseable — deny everything
    /// until the operator fixes the configuration.
    fail_closed: bool,
}

impl HttpTargetPolicy {
    /// Parse env-sourced lists; `None` = unset = empty list.
    pub fn parse(allow_spec: Option<&str>, deny_spec: Option<&str>) -> Result<Self, String> {
        let mut allow = Vec::new();
        if let Some(spec) = allow_spec.filter(|s| !s.trim().is_empty()) {
            for entry in spec.split(',') {
                let entry = entry.trim();
                if !entry.is_empty() {
                    allow.push(IpRange::parse(entry)?);
                }
            }
        }
        let mut deny = Vec::new();
        if let Some(spec) = deny_spec.filter(|s| !s.trim().is_empty()) {
            for entry in spec.split(',') {
                let entry = entry.trim();
                if !entry.is_empty() {
                    deny.push(IpRange::parse(entry)?);
                }
            }
        }
        Ok(Self { allow, deny, fail_closed: false })
    }

    /// Read the env knobs. A malformed entry FAILS CLOSED (all targets
    /// denied, loudly) so an operator typo can never silently reopen access;
    /// when neither knob is set the policy is inactive (allow all — logged
    /// once per process as `SSRF guard off`).
    pub fn from_env() -> Self {
        let allow = std::env::var(ENV_HTTP_ALLOW).ok();
        let deny = std::env::var(ENV_HTTP_DENY).ok();
        let policy = match Self::parse(allow.as_deref(), deny.as_deref()) {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "[celestea] http_request SSRF policy misconfigured ({e}); FAILING CLOSED: all http_request targets are denied until {ENV_HTTP_ALLOW}/{ENV_HTTP_DENY} are fixed."
                );
                Self { allow: Vec::new(), deny: Vec::new(), fail_closed: true }
            }
        };
        if !policy.is_active() {
            use std::sync::atomic::{AtomicBool, Ordering};
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "[celestea] http_request SSRF guard off ({ENV_HTTP_ALLOW}/{ENV_HTTP_DENY} unset): all targets allowed"
                );
            }
        }
        policy
    }

    /// Whether a policy actually constrains targets.
    pub fn is_active(&self) -> bool {
        self.fail_closed || !self.allow.is_empty() || !self.deny.is_empty()
    }

    /// Allow / deny entry counts (tests / diagnostics).
    #[cfg(test)]
    pub fn allow_len(&self) -> usize {
        self.allow.len()
    }
    #[cfg(test)]
    pub fn deny_len(&self) -> usize {
        self.deny.len()
    }

    fn ip_allowed(&self, ip: &std::net::IpAddr) -> Result<(), String> {
        if self.fail_closed {
            return Err(format!("ssrf policy misconfigured (fail-closed): fix {ENV_HTTP_ALLOW}/{ENV_HTTP_DENY}"));
        }
        if !self.allow.is_empty() && !self.allow.iter().any(|r| r.contains(ip)) {
            return Err(format!("target ip {ip} is not in the {ENV_HTTP_ALLOW} allow list"));
        }
        if self.deny.iter().any(|r| r.contains(ip)) {
            return Err(format!("target ip {ip} is in the {ENV_HTTP_DENY} deny list"));
        }
        Ok(())
    }

    /// Authorize a URL: every resolved IP of the host must pass the policy.
    /// Hostname resolution failure is an error (fail-closed); the caller
    /// maps it to the `dns` category. IP-literal targets are checked
    /// directly (no resolution).
    pub async fn check_url(&self, url: &reqwest::Url) -> Result<(), String> {
        let host = url.host_str().ok_or_else(|| "target url has no host".to_string())?;
        let ips: Vec<std::net::IpAddr> = match host.parse::<std::net::IpAddr>() {
            Ok(ip) => vec![ip],
            Err(_) => {
                let port = url.port_or_known_default().unwrap_or(80);
                match tokio::net::lookup_host((host, port)).await {
                    Ok(addrs) => {
                        let ips: Vec<std::net::IpAddr> = addrs.map(|a| a.ip()).collect();
                        if ips.is_empty() {
                            return Err(format!("host '{host}' resolves to no addresses"));
                        }
                        ips
                    }
                    Err(e) => return Err(format!("cannot resolve host '{host}': {e}")),
                }
            }
        };
        for ip in &ips {
            self.ip_allowed(ip)?;
        }
        Ok(())
    }
}

fn http_request_spec() -> ToolSpec {
    ToolSpec {
        name: "http_request".into(),
        description: "Send an HTTP(S) request and return {status, headers(subset), body, truncated}. Only http/https URLs are allowed (file:// etc. rejected); redirects are followed up to 5 hops; the response body is truncated at 1MB (truncated:true beyond). HTTP error statuses are preserved in `status` — not tool errors; transport failures are categorized as timeout | dns | connect | redirect | invalid_url | invalid_arg | target_forbidden. SSRF policy: when CELESTEA_HTTP_ALLOW / CELESTEA_HTTP_DENY (comma-separated IP/CIDR) are set, every resolved target IP — and every redirect hop — must pass them; default (unset) allows all hosts.".into(),
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
    http_request_tool_with(HttpTargetPolicy::from_env())
}

/// [http_request_tool] with an explicit target policy (tests / embeddings).
pub(crate) fn http_request_tool_with(policy: HttpTargetPolicy) -> Box<dyn Tool> {
    fn_tool(http_request_spec(), move |args| {
        let policy = policy.clone();
        Box::pin(async move { http_request_impl(&args, &policy).await })
    })
}

fn contract_err(code: &str, msg: impl Into<String>) -> Result<Value, String> {
    Err(format!("http_request: code={code} msg={}", msg.into()))
}

/// Client with reqwest's own redirect following (used when no SSRF policy is
/// configured — the status quo).
fn client_follow() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .no_proxy()
            .build()
            .expect("http_request client construction must not fail")
    })
}

/// Client WITHOUT automatic redirects (used when an SSRF policy is active —
/// the tool re-implements the 5-hop cap and re-checks every hop target).
fn client_manual() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .expect("http_request client construction must not fail")
    })
}

fn client_for(manual_redirects: bool) -> &'static reqwest::Client {
    if manual_redirects {
        client_manual()
    } else {
        client_follow()
    }
}

async fn http_request_impl(args: &Value, policy: &HttpTargetPolicy) -> Result<Value, String> {
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

    // Validate headers once; they are re-applied on every redirect hop.
    let mut header_pairs: Vec<(reqwest::header::HeaderName, reqwest::header::HeaderValue)> = Vec::new();
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
                Ok(val) => header_pairs.push((name, val)),
                Err(e) => return contract_err("invalid_arg", format!("bad header value for '{k}': {e}")),
            }
        }
    }

    let body = args.get("body").and_then(Value::as_str).map(|s| s.to_string());
    let policy_active = policy.is_active();
    let mut current = url.clone();
    let mut current_method = method.clone();
    let mut current_body = body.clone();
    let mut hops: u32 = 0;

    loop {
        // W249 P0-3: with a policy active, every hop target is authorized
        // (IP literals directly; hostnames by resolving all A/AAAA records).
        if policy_active {
            policy
                .check_url(&current)
                .await
                .map_err(|e| format!("http_request: code=target_forbidden msg={e}"))?;
        }

        let mut request = client_for(policy_active)
            .request(current_method.clone(), current.clone())
            .timeout(Duration::from_millis(timeout_ms));
        for (name, val) in &header_pairs {
            request = request.header(name.clone(), val.clone());
        }
        if let Some(b) = &current_body {
            request = request.body(b.clone());
        }

        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => return Err(classify_error(e, &current).await),
        };

        if policy_active && response.status().is_redirection() {
            hops += 1;
            if hops > 5 {
                return contract_err("redirect", "redirect chain longer than 5 hops");
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect response without a Location header".to_string())?;
            let next = current.join(location).map_err(|e| {
                format!(
                    "http_request: code=redirect msg=unparseable redirect location '{location}': {e}"
                )
            })?;
            match next.scheme() {
                "http" | "https" => {}
                other => {
                    return contract_err(
                        "invalid_url",
                        format!("redirect to scheme '{other}' not allowed"),
                    )
                }
            }
            // 301/302/303 → GET without body; 307/308 keep method and body.
            let status = response.status();
            if status == reqwest::StatusCode::MOVED_PERMANENTLY
                || status == reqwest::StatusCode::FOUND
                || status == reqwest::StatusCode::SEE_OTHER
            {
                current_method = reqwest::Method::GET;
                current_body = None;
            }
            current = next;
            continue;
        }

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
                Err(e) => return Err(classify_error(e, &current).await),
            }
        }

        return Ok(json!({
            "ok": true,
            "status": status,
            "headers": headers,
            "body": String::from_utf8_lossy(&buf).into_owned(),
            "truncated": truncated,
        }));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_range_parses_cidrs_and_bare_ips() {
        let r = IpRange::parse("127.0.0.1/8").unwrap();
        assert!(r.contains(&"127.0.0.1".parse().unwrap()));
        assert!(r.contains(&"127.255.255.255".parse().unwrap()));
        assert!(!r.contains(&"128.0.0.1".parse().unwrap()));
        assert!(r.contains(&"127.0.0.1".parse::<std::net::IpAddr>().unwrap()));

        let v6 = IpRange::parse("::1").unwrap();
        assert!(v6.contains(&"::1".parse().unwrap()));
        assert!(!v6.contains(&"::2".parse().unwrap()));

        let net6 = IpRange::parse("fd00::/8").unwrap();
        assert!(net6.contains(&"fd12:3456::1".parse().unwrap()));
        assert!(!net6.contains(&"fe80::1".parse().unwrap()));

        assert!(IpRange::parse("1.2.3.4/33").is_err());
        assert!(IpRange::parse("nonsense").is_err());
    }

    #[test]
    fn policy_parses_allow_and_deny_lists() {
        let p = HttpTargetPolicy::parse(Some("127.0.0.1/8,::1,10.0.0.0/24"), Some("192.168.0.0/16,8.8.8.8"))
            .expect("parse");
        assert!(p.is_active());
        assert_eq!(p.allow_len(), 3);
        assert_eq!(p.deny_len(), 2);
        assert!(!HttpTargetPolicy::default().is_active(), "no env → allow all (status quo)");
        assert!(HttpTargetPolicy::parse(Some("nonsense"), None).is_err());
    }

    #[tokio::test]
    async fn policy_checks_ip_literals_directly() {
        let allow = HttpTargetPolicy::parse(Some("127.0.0.0/8"), None).unwrap();
        let url = reqwest::Url::parse("http://127.0.0.1/x").unwrap();
        assert!(allow.check_url(&url).await.is_ok());
        let url = reqwest::Url::parse("http://8.8.8.8/x").unwrap();
        let err = allow.check_url(&url).await.unwrap_err();
        assert!(err.contains("not in the"), "{err}");

        let deny = HttpTargetPolicy::parse(None, Some("127.0.0.1/32")).unwrap();
        let url = reqwest::Url::parse("http://127.0.0.1/x").unwrap();
        let err = deny.check_url(&url).await.unwrap_err();
        assert!(err.contains("deny list"), "{err}");
    }
}
