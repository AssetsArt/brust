//! M3-F E3/E4: the actions subtree. Rust owns the prefix, the preflight (pipeline), the body cap and the transport (the host); the
//! app in the worker owns routing, 404/405/422 and the response. CORS is NOT stamped here: the `Core::finish` chokepoint
//! stamps every response (cors.rs:9-14).
use std::sync::atomic::Ordering;

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Response};

use crate::body::{self, header_str};
use crate::config::{ActionsConfig, CrossSite};
use crate::core::Core;
use crate::cors::ResolvedCors;
use crate::host::{ActionBody, ActionCall, ActionReply, CallError, Host, ReadErr, RequestHead};
use crate::protocol::{FetchBody, FetchResponse, WsAccepted};

/// One request under the prefix → one `fetch` worker call. `body` is read only here, and never for GET/HEAD (R4); a
/// `stream`-listed route's body is not read here at all (F475): the app pulls it during the call.
pub(crate) async fn handle<H: Host>(
    s: &Core<H>,
    a: &ActionsConfig,
    rq: &RequestHead<'_>,
    body: H::Body,
    head: bool,
) -> Response<Bytes> {
    let (method, full) = (rq.method, rq.full);
    // R9: `new Request` throws on these; the worker could not answer them.
    if matches!(method, "CONNECT" | "TRACE" | "TRACK") {
        return body::resp(501, "text/plain", &[], b"not implemented".to_vec());
    }
    // The worker's URL parser (WHATWG) resolves `..`, `%2e%2e` and `\` that this prefix check matched raw: refuse
    // them, so the path the app routes on is the path Rust admitted under the prefix.
    if ambiguous_path(full.split_once('?').map_or(full, |(p, _)| p)) {
        return body::error_400();
    }
    // R2: Rust forwards bytes as received; an encoded body is the one shape it refuses.
    let ce = rq
        .headers
        .get(http::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok());
    if ce.is_some_and(|v| !v.trim().eq_ignore_ascii_case("identity")) {
        return body::error_415();
    }
    // F87: refuse a cross-site mutation before its body is read and before the worker is called.
    let host = request_host(rq.headers, rq.authority);
    if cross_site_verdict(
        method,
        rq.headers,
        host.as_deref(),
        s.cors_resolved.as_ref(),
        a.cross_site,
    )
    .is_err()
    {
        tracing::debug!(
            target: "brust::actions",
            origin = header_str(rq.headers, "origin").as_deref().unwrap_or(""),
            host = host.as_deref().unwrap_or(""),
            "cross-site rejected"
        );
        return body::error_403_cross_site(if is_ws_upgrade(method, rq.headers) {
            "WebSocket upgrade"
        } else {
            method
        });
    }
    let body = if method == "GET" || method == "HEAD" {
        ActionBody::None
    } else if H::STREAM_BODY && a.streams(method, full) {
        // F475: the declared length is refused over the ceiling before a byte is read; without one the running count
        // enforces it. hyper already refused a malformed or conflicting Content-Length.
        let declared =
            header_str(rq.headers, "content-length").and_then(|v| v.trim().parse::<u64>().ok());
        match declared {
            Some(n) if n > a.stream.max_bytes => {
                // Read out after the 413, so it reaches a client still writing before the close (F127).
                s.host.read_out(body);
                return closing(body::error_413());
            }
            Some(0) => ActionBody::None,
            _ => ActionBody::Stream { body, declared },
        }
    } else {
        match s.host.read_body(body, a.max_body_bytes).await {
            Ok(b) if b.is_empty() => ActionBody::None,
            Ok(b) => ActionBody::Buffered(b),
            Err(e) => return read_err_response(e),
        }
    };
    let streamed = matches!(body, ActionBody::Stream { .. });
    let r = s
        .host
        .action(ActionCall {
            method,
            full,
            headers: rq.headers,
            authority: rq.authority,
            body,
        })
        .await;
    // R11: a worker call, never a loader call.
    if !matches!(
        r,
        Err(CallError::NoWorkers | CallError::Timeout | CallError::StreamsFull)
    ) {
        s.worker_calls.incr();
    }
    let failed = r.is_err();
    let resp = match r {
        Ok(r) => reply_to_response(r, header_str(rq.headers, "accept-encoding").as_deref()),
        Err(e @ (CallError::NoWorkers | CallError::Timeout)) => body::error_503(&e.to_string()),
        Err(e @ CallError::StreamsFull) => body::resp(
            503,
            "text/plain",
            &[("retry-after".into(), "1".into())],
            e.to_string().into_bytes(),
        ),
        // F475: whatever the app answered, a failed stream answers as the buffered read would have, and the
        // connection closes (the rest of the body is never read).
        Err(CallError::BodyAborted(e)) => read_err_response(e),
        Err(CallError::Deadline) => {
            s.timed_out_calls.fetch_add(1, Ordering::Relaxed);
            body::error_504("call deadline exceeded")
        }
        Err(e) => {
            tracing::error!(path = full, error = %e, "action call failed");
            body::error_500()
        }
    };
    // F475: a streamed call that failed (503 over `max_streams`, 408/413/400, 504, 500) may have left its body
    // unread past the bounded read-out: the connection is not reused.
    let resp = if streamed && failed {
        closing(resp)
    } else {
        resp
    };
    tracing::debug!(
        target: "brust::request",
        path = full,
        status = resp.status().as_u16(),
        "action"
    );
    if head { body::head_only(resp) } else { resp }
}

/// A body that could not be read: 413 over the cap, 400 broken, 408 too slow.
fn read_err_response(e: ReadErr) -> Response<Bytes> {
    match e {
        ReadErr::TooLarge => body::error_413(),
        ReadErr::Io => body::error_400(),
        ReadErr::Slow => body::resp(408, "text/plain", &[], b"request timeout".to_vec()),
    }
}

/// F475: answer and close; the host reads out the unread rest of a streamed body for a bounded time only.
fn closing(mut r: Response<Bytes>) -> Response<Bytes> {
    r.headers_mut()
        .insert(http::header::CONNECTION, HeaderValue::from_static("close"));
    r
}

/// F529 D9: a GET that asks to become a WebSocket (`Upgrade: websocket`, a comma list of tokens, case-insensitive).
/// Browsers send no preflight for it and attach the user's cookies, so it is judged like a mutation.
pub(crate) fn is_ws_upgrade(method: &str, headers: &HeaderMap) -> bool {
    method == "GET"
        && headers
            .get_all(http::header::UPGRADE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|t| t.trim().eq_ignore_ascii_case("websocket"))
}

/// F87 / spec E10: may a request with these headers mutate through an action? `host` is the request authority
/// (first `X-Forwarded-Host`, else `Host`, else the HTTP/2 `:authority`). Browser-declared only: a request with
/// neither `Sec-Fetch-Site: cross-site` nor an `Origin` is a non-browser client and passes. F529 D9: a WebSocket
/// upgrade (a GET with `Upgrade: websocket`) is judged by the same rule; any other GET/HEAD/OPTIONS passes.
pub(crate) fn cross_site_verdict(
    method: &str,
    headers: &HeaderMap,
    host: Option<&str>,
    cors: Option<&ResolvedCors>,
    mode: CrossSite,
) -> Result<(), ()> {
    if mode == CrossSite::Allow
        || (matches!(method, "GET" | "HEAD" | "OPTIONS") && !is_ws_upgrade(method, headers))
    {
        return Ok(());
    }
    let origin = headers.get(http::header::ORIGIN);
    let cors_allows = || origin.zip(cors).is_some_and(|(o, c)| c.origin_listed(o));
    let fetch_site = header_str(headers, "sec-fetch-site");
    if fetch_site
        .as_deref()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("cross-site"))
    {
        return if cors_allows() { Ok(()) } else { Err(()) };
    }
    let Some(o) = origin else {
        return Ok(());
    };
    let authority = o
        .to_str()
        .ok()
        .and_then(|o| o.split_once("://"))
        .map(|(_, a)| a.to_ascii_lowercase());
    if let (Some(a), Some(h)) = (&authority, host)
        && *a == h.to_ascii_lowercase()
    {
        return Ok(());
    }
    if cors_allows() { Ok(()) } else { Err(()) }
}

/// The request authority behind proxies: the first `X-Forwarded-Host` value, else `Host`, else `:authority`.
fn request_host(headers: &HeaderMap, authority: Option<&str>) -> Option<String> {
    header_str(headers, "x-forwarded-host")
        .and_then(|v| v.split(',').next().map(|s| s.trim().to_owned()))
        .filter(|s| !s.is_empty())
        .or_else(|| header_str(headers, "host"))
        .or_else(|| authority.map(str::to_owned))
}

/// A path a WHATWG URL parser would rewrite: a `.`/`..` segment (also as `%2e`), or a backslash (also `%5c`).
fn ambiguous_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains('\\')
        || lower.contains("%5c")
        || lower
            .split('/')
            .any(|seg| matches!(seg.replace("%2e", ".").as_str(), "." | ".."))
}

/// R2: text for JSON / form / `text/*` / no type when the bytes are UTF-8; base64 (lossless) for everything else.
#[doc(hidden)]
pub fn encode_body(ct: &str, b: Bytes) -> FetchBody {
    let essence = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let textual = matches!(
        essence.as_str(),
        "" | "application/json" | "application/x-www-form-urlencoded"
    ) || essence.ends_with("+json")
        || essence.starts_with("text/");
    if textual && let Ok(s) = std::str::from_utf8(&b) {
        return FetchBody::Text(s.to_owned());
    }
    FetchBody::B64(b64(&b))
}

/// RFC 4648 §4 base64, standard alphabet, `=` padding (R5: std only).
fn b64(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(c.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(c.get(2).copied().unwrap_or(0));
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            A[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            A[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The host's reply as a response: a `Fetch` through [`response_from_fetch`] (then [`gzip_reply`] for a client that
/// takes gzip), a `Built` as is. An `Unread` reply belongs to a streamed call and is never compressed (F547).
fn reply_to_response(r: ActionReply, accept_encoding: Option<&str>) -> Response<Bytes> {
    match r {
        ActionReply::Fetch(f) => gzip_reply(response_from_fetch(f), accept_encoding),
        ActionReply::Unread(f) => closing(response_from_fetch(f)),
        ActionReply::Built(r) => r,
    }
}

/// F547: a buffered action reply at least this long is gzip-eligible; below it the CPU outweighs the saving.
const ACTION_GZIP_MIN: usize = 1024;

/// F547: gzip a buffered reply for a client that accepts it, by the page rules (`crate::compress`, the page level).
/// A reply is eligible when its status is not 101/204/206/304, it is at least [`ACTION_GZIP_MIN`] long, has a
/// compressible `Content-Type`, no `Content-Encoding`/`Content-Range`, and no `Cache-Control: no-transform` (the app's
/// opt-out, documented for a reply that mixes a secret with reflected input: BREACH). An eligible reply carries
/// `Vary: Accept-Encoding` (merged into an existing `Vary`) whatever the client offered, so a shared cache keys on it
/// as it does for pages. For a client that accepts gzip it is also compressed (`Content-Encoding: gzip`), and a strong
/// `ETag` is dropped (the bytes changed; a weak one still names the same representation). When gzip is not smaller the
/// body is left as the app made it.
fn gzip_reply(mut r: Response<Bytes>, accept_encoding: Option<&str>) -> Response<Bytes> {
    use http::header::{CACHE_CONTROL, CONTENT_ENCODING, CONTENT_RANGE, CONTENT_TYPE, ETAG, VARY};
    if r.body().len() < ACTION_GZIP_MIN || matches!(r.status().as_u16(), 101 | 204 | 206 | 304) {
        return r;
    }
    let h = r.headers();
    let compressible = h
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(crate::compress::is_compressible);
    let no_transform = h.get_all(CACHE_CONTROL).iter().any(|v| {
        v.to_str().is_ok_and(|v| {
            v.split(',')
                .any(|d| d.trim().eq_ignore_ascii_case("no-transform"))
        })
    });
    if !compressible
        || no_transform
        || h.contains_key(CONTENT_ENCODING)
        || h.contains_key(CONTENT_RANGE)
    {
        return r;
    }
    let h = r.headers_mut();
    // One merged field: `Vary: *` stands as is, an existing `Accept-Encoding` is not repeated.
    let mut vary: Vec<String> = h
        .get_all(VARY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
        .collect();
    if !vary
        .iter()
        .any(|t| t == "*" || t.eq_ignore_ascii_case("accept-encoding"))
    {
        vary.push("Accept-Encoding".to_owned());
    }
    if let Ok(v) = HeaderValue::from_str(&vary.join(", ")) {
        h.insert(VARY, v);
    }
    if !crate::compress::accepts_gzip(accept_encoding) {
        return r;
    }
    let Some(gz) = crate::compress::gzip(r.body(), crate::pipeline::PAGE_GZIP_LEVEL) else {
        return r;
    };
    let h = r.headers_mut();
    h.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    if h.get(ETAG)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !v.starts_with("W/"))
    {
        h.remove(ETAG);
    }
    *r.body_mut() = Bytes::from(gz);
    r
}

/// R9: the worker's answer as a response — status in 200..=599, framing headers dropped, every other valid pair
/// appended in order (repeated `Set-Cookie` survive). Never L1; gzip is [`gzip_reply`]'s (F547).
fn response_from_fetch(f: FetchResponse) -> Response<Bytes> {
    if f.status == 101 {
        return upgrade_from_fetch(f);
    }
    if !(200..=599).contains(&f.status) {
        tracing::error!(status = f.status, "action answered an invalid status");
        return body::error_500();
    }
    let mut hm = HeaderMap::with_capacity(f.headers.len());
    for (k, v) in &f.headers {
        if body::is_framing_header(k) {
            continue;
        }
        match (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            (Ok(n), Ok(v)) => {
                hm.append(n, v);
            }
            _ => tracing::warn!(header = %k, "action answered an invalid header; dropped"),
        }
    }
    body::resp_with(f.status, hm, f.body)
}

/// F529 A2: a 101 is an accepted WebSocket upgrade and must say which socket (`ws`); without it the bridge is broken
/// (500). Rust owns the handshake, so the worker's `Upgrade` / `Sec-WebSocket-*` headers are dropped; the rest (cookies
/// from `derive`, say) pass. The accept travels as a [`WsAccepted`] extension and nothing else here reads it.
fn upgrade_from_fetch(f: FetchResponse) -> Response<Bytes> {
    let Some(opts) = f.ws else {
        tracing::error!("action answered 101 without a ws accept");
        return body::error_500();
    };
    let mut r = response_from_fetch(FetchResponse {
        status: 200,
        headers: f
            .headers
            .into_iter()
            .filter(|(k, _)| {
                !k.eq_ignore_ascii_case("upgrade")
                    && !k.to_ascii_lowercase().starts_with("sec-websocket-")
            })
            .collect(),
        body: Bytes::new(),
        ws: None,
    });
    *r.status_mut() = http::StatusCode::SWITCHING_PROTOCOLS;
    r.extensions_mut().insert(WsAccepted {
        worker_local_id: opts.id,
        opts,
    });
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hm(h: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in h {
            m.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        m
    }

    fn cors(origins: &[&str]) -> ResolvedCors {
        ResolvedCors::from_config(&crate::config::CorsConfig {
            origins: origins.iter().map(|s| (*s).to_owned()).collect(),
            methods: None,
            headers: None,
            expose_headers: None,
            credentials: false,
            max_age_seconds: None,
        })
    }

    fn v(m: &str, h: &[(&str, &str)], host: Option<&str>, c: Option<&ResolvedCors>) -> bool {
        cross_site_verdict(m, &hm(h), host, c, CrossSite::Reject).is_ok()
    }

    #[test]
    fn cross_site_get_with_foreign_origin_is_allowed() {
        assert!(v(
            "GET",
            &[("origin", "https://evil.example")],
            Some("app.example"),
            None
        ));
        assert!(v(
            "OPTIONS",
            &[("origin", "https://evil.example")],
            Some("app.example"),
            None
        ));
    }

    #[test]
    fn cross_site_post_without_browser_headers_is_allowed() {
        assert!(v("POST", &[], Some("app.example"), None));
    }

    #[test]
    fn cross_site_post_foreign_origin_is_rejected() {
        assert!(!v(
            "POST",
            &[("origin", "https://evil.example")],
            Some("app.example"),
            None
        ));
    }

    #[test]
    fn cross_site_post_same_origin_is_allowed() {
        assert!(v(
            "POST",
            &[("origin", "https://App.Example")],
            Some("app.example"),
            None
        ));
        // Ports are compared as written, not normalised.
        assert!(!v(
            "POST",
            &[("origin", "https://app.example:443")],
            Some("app.example"),
            None
        ));
    }

    #[test]
    fn cross_site_null_origin_is_foreign() {
        assert!(!v("POST", &[("origin", "null")], Some("app.example"), None));
    }

    #[test]
    fn cross_site_fetch_metadata_without_origin_is_rejected() {
        assert!(!v(
            "POST",
            &[("sec-fetch-site", "Cross-Site")],
            Some("app.example"),
            None
        ));
        // same-site (a sibling subdomain) is allowed by design
        assert!(v(
            "POST",
            &[("sec-fetch-site", "same-site")],
            Some("app.example"),
            None
        ));
    }

    #[test]
    fn cross_site_allow_mode_forwards_everything() {
        let h = hm(&[
            ("origin", "https://evil.example"),
            ("sec-fetch-site", "cross-site"),
        ]);
        assert!(
            cross_site_verdict("POST", &h, Some("app.example"), None, CrossSite::Allow).is_ok()
        );
    }

    #[test]
    fn cross_site_wildcard_cors_does_not_open_the_guard() {
        let c = cors(&["*"]);
        assert!(!v(
            "POST",
            &[("origin", "https://evil.example")],
            Some("app.example"),
            Some(&c)
        ));
        assert!(!v(
            "POST",
            &[
                ("origin", "https://evil.example"),
                ("sec-fetch-site", "cross-site")
            ],
            Some("app.example"),
            Some(&c)
        ));
    }

    #[test]
    fn cross_site_wildcard_cors_with_allow_mode_forwards() {
        let h = hm(&[("origin", "https://evil.example")]);
        let c = cors(&["*"]);
        assert!(
            cross_site_verdict("POST", &h, Some("app.example"), Some(&c), CrossSite::Allow).is_ok()
        );
    }

    #[test]
    fn cross_site_listed_origin_is_an_exact_match() {
        let c = cors(&["https://partner.example"]);
        assert!(!v(
            "POST",
            &[("origin", "https://partner.example:8443")],
            Some("app.example"),
            Some(&c)
        ));
        assert!(!v(
            "POST",
            &[("origin", "http://partner.example")],
            Some("app.example"),
            Some(&c)
        ));
    }

    #[test]
    fn cross_site_sibling_subdomain_with_origin_is_rejected() {
        assert!(!v(
            "POST",
            &[
                ("origin", "https://admin.app.example"),
                ("sec-fetch-site", "same-site")
            ],
            Some("app.example"),
            None
        ));
    }

    #[test]
    fn cross_site_cors_listed_origin_is_allowed() {
        let c = cors(&["https://partner.example"]);
        let h = [
            ("origin", "https://partner.example"),
            ("sec-fetch-site", "cross-site"),
        ];
        assert!(v("POST", &h, Some("app.example"), Some(&c)));
        assert!(!v(
            "POST",
            &[("origin", "https://evil.example")],
            Some("app.example"),
            Some(&c)
        ));
    }

    #[test]
    fn cross_site_forwarded_host_is_the_authority() {
        // `request_host` prefers the first X-Forwarded-Host value over the proxy's own Host.
        let (parts, _) = http::Request::builder()
            .uri("/_brust/action/x")
            .header("host", "10.0.0.5:8080")
            .header("x-forwarded-host", "app.example, proxy.internal")
            .header("origin", "https://app.example")
            .body(())
            .unwrap()
            .into_parts();
        let host = request_host(&parts.headers, parts.uri.authority().map(|a| a.as_str()));
        assert_eq!(host.as_deref(), Some("app.example"));
        assert!(
            cross_site_verdict(
                "POST",
                &parts.headers,
                host.as_deref(),
                None,
                CrossSite::Reject
            )
            .is_ok()
        );
    }

    #[test]
    fn b64_rfc4648_vectors() {
        for (i, o) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(b64(i.as_bytes()), o, "{i:?}");
        }
        assert_eq!(b64(&[0, 1, 255]), "AAH/");
    }

    #[test]
    fn encode_body_r2() {
        let t = |ct: &str, b: &[u8]| encode_body(ct, Bytes::copy_from_slice(b));
        assert_eq!(t("", b"x"), FetchBody::Text("x".into()));
        assert_eq!(
            t("Application/JSON; charset=utf-8", b"{}"),
            FetchBody::Text("{}".into())
        );
        assert_eq!(
            t("application/ld+json", b"{}"),
            FetchBody::Text("{}".into())
        );
        assert_eq!(t("text/csv", b"a,b"), FetchBody::Text("a,b".into()));
        assert_eq!(t("text/plain", &[0xff]), FetchBody::B64("/w==".into()));
        assert_eq!(t("image/png", b"x"), FetchBody::B64("eA==".into()));
    }

    #[test]
    fn ambiguous_paths_are_refused() {
        for p in [
            "/_brust/action/../x",
            "/_brust/action/./x",
            "/_brust/action/%2e%2e/x",
            "/_brust/action/%2E./x",
            "/_brust/action/.%2e",
            "/_brust/action\\x",
            "/_brust/action/a%5Cb",
        ] {
            assert!(ambiguous_path(p), "{p}");
        }
        for p in [
            "/_brust/action",
            "/_brust/action/a.b/..c",
            "/_brust/action/x%2ey",
            "/_brust/action/...",
        ] {
            assert!(!ambiguous_path(p), "{p}");
        }
    }

    #[test]
    fn response_from_fetch_rules() {
        let r = response_from_fetch(FetchResponse {
            status: 600,
            headers: vec![],
            body: Bytes::new(),
            ws: None,
        });
        assert_eq!(r.status(), 500);
        let r = response_from_fetch(FetchResponse {
            status: 201,
            headers: vec![
                ("set-cookie".into(), "a=1".into()),
                ("content-length".into(), "9".into()),
                ("bad name".into(), "x".into()),
                ("set-cookie".into(), "b=2".into()),
            ],
            body: Bytes::from_static(b"ok"),
            ws: None,
        });
        assert_eq!(r.status(), 201);
        let c: Vec<_> = r.headers().get_all("set-cookie").iter().collect();
        assert_eq!(c, ["a=1", "b=2"]);
        assert_eq!(r.headers().len(), 2);
    }

    #[test]
    fn reply_to_response_passes_built_and_checks_fetch() {
        let mut built = Response::new(Bytes::from_static(b"made"));
        *built.status_mut() = http::StatusCode::CREATED;
        built
            .headers_mut()
            .insert("x-a", HeaderValue::from_static("1"));
        let r = reply_to_response(ActionReply::Built(built), None);
        assert_eq!(r.status(), 201);
        assert_eq!(r.headers().get("x-a").unwrap(), "1");
        assert_eq!(r.body(), &Bytes::from_static(b"made"));
        let r = reply_to_response(
            ActionReply::Fetch(FetchResponse {
                status: 99,
                headers: vec![],
                body: Bytes::new(),
                ws: None,
            }),
            None,
        );
        assert_eq!(r.status(), 500);
    }

    // F547: gzip_reply, one test per condition.
    fn js(n: usize) -> Bytes {
        Bytes::from("const a = 1;\n".repeat(n))
    }

    fn reply(status: u16, h: &[(&str, &str)], body: Bytes) -> Response<Bytes> {
        response_from_fetch(FetchResponse {
            status,
            headers: h.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            body,
            ws: None,
        })
    }

    const JS: (&str, &str) = ("content-type", "application/javascript; charset=utf-8");

    #[cfg(feature = "gzip")]
    fn unzip(b: &[u8]) -> Vec<u8> {
        use std::io::Read;
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(b)
            .read_to_end(&mut out)
            .unwrap();
        out
    }

    #[cfg(feature = "gzip")]
    #[test]
    fn gzip_reply_compresses_an_eligible_reply() {
        let raw = js(2000);
        let r = gzip_reply(
            reply(
                200,
                &[JS, ("etag", "\"v1\""), ("set-cookie", "a=1")],
                raw.clone(),
            ),
            Some("br, gzip"),
        );
        assert_eq!(r.headers().get("content-encoding").unwrap(), "gzip");
        assert_eq!(r.headers().get("vary").unwrap(), "Accept-Encoding");
        assert!(
            r.headers().get("etag").is_none(),
            "a strong ETag names the identity bytes"
        );
        assert_eq!(r.headers().get("set-cookie").unwrap(), "a=1");
        assert!(r.body().len() < raw.len());
        assert_eq!(unzip(r.body()), raw.to_vec());
    }

    #[cfg(feature = "gzip")]
    #[test]
    fn gzip_reply_keeps_a_weak_etag_and_merges_vary() {
        let r = gzip_reply(
            reply(
                200,
                &[
                    JS,
                    ("etag", "W/\"v1\""),
                    ("vary", "Origin"),
                    ("vary", "Cookie"),
                ],
                js(2000),
            ),
            Some("gzip"),
        );
        assert_eq!(r.headers().get("etag").unwrap(), "W/\"v1\"");
        let v: Vec<_> = r.headers().get_all("vary").iter().collect();
        assert_eq!(v, ["Origin, Cookie, Accept-Encoding"]);
        // already varying on it, or on everything: not repeated, not narrowed.
        for have in ["accept-encoding", "*"] {
            let r = gzip_reply(reply(200, &[JS, ("vary", have)], js(2000)), Some("gzip"));
            assert_eq!(
                r.headers().get_all("vary").iter().collect::<Vec<_>>(),
                [have]
            );
            assert_eq!(r.headers().get("content-encoding").unwrap(), "gzip");
        }
    }

    #[cfg(feature = "gzip")]
    #[test]
    fn gzip_reply_applies_to_json_and_text_and_any_error_status() {
        for (ct, status) in [
            ("application/json", 200),
            ("text/html; charset=utf-8", 422),
            ("text/plain", 500),
        ] {
            let r = gzip_reply(
                reply(status, &[("content-type", ct)], js(2000)),
                Some("gzip"),
            );
            assert_eq!(r.status().as_u16(), status);
            assert_eq!(r.headers().get("content-encoding").unwrap(), "gzip", "{ct}");
        }
    }

    #[test]
    fn gzip_reply_leaves_an_ineligible_reply_alone() {
        let big = js(2000);
        let untouched = |r: Response<Bytes>, ae: Option<&str>, why: &str| {
            let (status, body) = (r.status(), r.body().clone());
            let h = r.headers().clone();
            let out = gzip_reply(r, ae);
            assert_eq!(out.status(), status, "{why}");
            assert_eq!(out.body(), &body, "{why}");
            assert_eq!(out.headers(), &h, "{why}");
        };
        let g = Some("gzip");
        untouched(reply(200, &[JS], js(10)), g, "under 1024 bytes");
        untouched(
            reply(200, &[("content-type", "image/png")], big.clone()),
            g,
            "not compressible",
        );
        untouched(reply(200, &[], big.clone()), g, "no content type");
        untouched(
            reply(200, &[JS, ("content-encoding", "br")], big.clone()),
            g,
            "already encoded",
        );
        untouched(
            reply(200, &[JS, ("content-range", "bytes 0-9/99")], big.clone()),
            g,
            "a range",
        );
        untouched(reply(206, &[JS], big.clone()), g, "206");
        untouched(reply(304, &[JS], big.clone()), g, "304");
        untouched(reply(204, &[JS], big.clone()), g, "204");
        for cc in [
            "no-transform",
            "private, No-Transform",
            "max-age=0,no-transform",
        ] {
            untouched(reply(200, &[JS, ("cache-control", cc)], big.clone()), g, cc);
        }
        // `no-transform` in a second Cache-Control line counts too; a lookalike directive does not.
        untouched(
            reply(
                200,
                &[
                    JS,
                    ("cache-control", "no-store"),
                    ("cache-control", "no-transform"),
                ],
                big.clone(),
            ),
            g,
            "second line",
        );
    }

    #[cfg(feature = "gzip")]
    #[test]
    fn gzip_reply_ignores_a_lookalike_cache_control_directive() {
        let r = gzip_reply(
            reply(
                200,
                &[JS, ("cache-control", "no-transform-ish, no-store")],
                js(2000),
            ),
            Some("gzip"),
        );
        assert_eq!(r.headers().get("content-encoding").unwrap(), "gzip");
    }

    #[test]
    fn gzip_reply_leaves_incompressible_bytes_identity() {
        // pseudo-random bytes: gzip is not smaller, so the reply is left as the app made it.
        let mut x = 0x9e37_79b9_u32;
        let noise: Vec<u8> = (0..4096)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x >> 11) as u8
            })
            .collect();
        let r = gzip_reply(
            reply(200, &[("content-type", "text/plain")], Bytes::from(noise)),
            Some("gzip"),
        );
        assert!(r.headers().get("content-encoding").is_none());
        // still eligible, so a cache keys on Accept-Encoding.
        assert_eq!(r.headers().get("vary").unwrap(), "Accept-Encoding");
    }

    #[test]
    fn gzip_reply_varies_on_every_eligible_reply_whatever_the_client_offered() {
        let big = js(2000);
        for ae in [None, Some("identity"), Some("br"), Some("gzip;q=0")] {
            let r = gzip_reply(
                reply(
                    200,
                    &[JS, ("vary", "Origin"), ("etag", "\"v1\"")],
                    big.clone(),
                ),
                ae,
            );
            assert!(!r.headers().contains_key("content-encoding"), "{ae:?}");
            assert_eq!(
                r.headers().get_all("vary").iter().collect::<Vec<_>>(),
                ["Origin, Accept-Encoding"],
                "{ae:?}"
            );
            assert_eq!(
                r.headers().get("etag").unwrap(),
                "\"v1\"",
                "the identity bytes keep their ETag"
            );
            assert_eq!(r.body(), &big, "{ae:?}");
        }
        // an ineligible reply (short, no-transform, encoded, not compressible) gets no Vary.
        for r in [
            reply(200, &[JS], js(10)),
            reply(200, &[JS, ("cache-control", "no-transform")], big.clone()),
            reply(200, &[JS, ("content-encoding", "br")], big.clone()),
            reply(200, &[("content-type", "image/png")], big.clone()),
        ] {
            assert!(!gzip_reply(r, None).headers().contains_key("vary"));
        }
    }

    #[test]
    fn reply_to_response_gzips_a_fetch_only() {
        let fetch = || FetchResponse {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: js(2000),
            ws: None,
        };
        let gz = cfg!(feature = "gzip");
        let r = reply_to_response(ActionReply::Fetch(fetch()), Some("gzip"));
        assert_eq!(r.headers().contains_key("content-encoding"), gz);
        // an unread (streamed) reply and a built one are never compressed.
        let r = reply_to_response(ActionReply::Unread(fetch()), Some("gzip"));
        assert!(!r.headers().contains_key("content-encoding"));
        assert_eq!(r.headers().get("connection").unwrap(), "close");
        let mut built = Response::new(js(2000));
        built
            .headers_mut()
            .insert("content-type", HeaderValue::from_static("application/json"));
        let r = reply_to_response(ActionReply::Built(built), Some("gzip"));
        assert!(!r.headers().contains_key("content-encoding"));
    }
}
