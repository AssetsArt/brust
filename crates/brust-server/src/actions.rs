//! M3-F E3/E4: the actions subtree. Rust owns the prefix, the preflight (pipeline), the body cap and the transport; the
//! app in the worker owns routing, 404/405/422 and the response. CORS is NOT stamped here: the service_fn chokepoint
//! stamps every response (cors.rs:9-14).
use std::borrow::Cow;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Response};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::body::Incoming;

use crate::config::{ACTION_INLINE_BODY_BYTES, ActionsConfig, CrossSite, Server};
use crate::dispatch::{CallError, FetchCell, call_worker_fetch};
use crate::protocol::{FetchBody, FetchRequest, FetchResponse};
use brust_core::body::{self, header_str};
use brust_core::cors::ResolvedCors;
use brust_core::host::ReadErr;

/// F82, on the worker's JS thread inside its `fetch` call for `slot`: the heap request body, once.
/// `None`: no such worker, the slot is not in a call, it is not a `fetch` call, no heap body was
/// sent, or it was already taken.
pub fn take_fetch_body(s: &Server, worker: u32, slot: u32) -> Option<Vec<u8>> {
    let taken = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let entry = s.pool.entry(worker)?;
        let mut g = entry.claimed_plan_cell(slot)?.lock();
        g.as_mut()?.downcast_mut::<FetchCell>()?.body.take()
    }))
    .ok()
    .flatten()?;
    Some(Vec::from(taken))
}

/// F82: hand Rust a response body too large for the slot. `false` = declined: no actions config,
/// `body.len() > max_response_bytes`, the slot is not in a `fetch` call, or a reply was already put.
pub fn put_fetch_reply(s: &Server, worker: u32, slot: u32, body: &[u8]) -> bool {
    let Some(a) = s.actions.as_ref() else {
        return false;
    };
    if body.len() > a.max_response_bytes {
        return false;
    }
    // Copy before taking the lock.
    let copy = Bytes::copy_from_slice(body);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(entry) = s.pool.entry(worker) else {
            return false;
        };
        let Some(cell) = entry.claimed_plan_cell(slot) else {
            return false;
        };
        let g = cell.lock();
        let Some(fc) = g.as_ref().and_then(|b| b.downcast_ref::<FetchCell>()) else {
            return false;
        };
        let mut reply = fc.reply.lock();
        if reply.is_some() {
            return false;
        }
        *reply = Some(copy);
        true
    }))
    .unwrap_or(false)
}

/// One request under the prefix → one `fetch` worker call. `incoming` is read only here, and never for GET/HEAD (R4).
pub(crate) async fn handle(
    s: &Server,
    a: &ActionsConfig,
    parts: &http::request::Parts,
    incoming: Incoming,
    full: &str,
    head: bool,
) -> Response<Bytes> {
    let method = parts.method.as_str();
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
    let ce = parts
        .headers
        .get(http::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok());
    if ce.is_some_and(|v| !v.trim().eq_ignore_ascii_case("identity")) {
        return body::error_415();
    }
    // F87: refuse a cross-site mutation before its body is read and before the worker is called.
    let host = request_host(parts);
    if cross_site_verdict(
        method,
        &parts.headers,
        host.as_deref(),
        s.cors_resolved.as_ref(),
        a.cross_site,
    )
    .is_err()
    {
        tracing::debug!(
            target: "brust::actions",
            origin = header_str(&parts.headers, "origin").as_deref().unwrap_or(""),
            host = host.as_deref().unwrap_or(""),
            "cross-site rejected"
        );
        return body::error_403_cross_site(method);
    }
    let (fb, heap_body) = if method == "GET" || method == "HEAD" {
        (None, None)
    } else {
        match read_capped(incoming, a.max_body_bytes, s.call_timeout).await {
            Ok(b) if b.is_empty() => (None, None),
            // F82: over the inline threshold the bytes wait in the call's cell for `takeFetchBody`.
            Ok(b) if b.len() > ACTION_INLINE_BODY_BYTES => {
                (Some(FetchBody::Heap(b.len())), Some(b))
            }
            Ok(b) => (
                Some(encode_body(
                    header_str(&parts.headers, "content-type")
                        .as_deref()
                        .unwrap_or(""),
                    b,
                )),
                None,
            ),
            Err(ReadErr::TooLarge) => return body::error_413(),
            Err(ReadErr::Io) => return body::error_400(),
            Err(ReadErr::Slow) => {
                return body::resp(408, "text/plain", &[], b"request timeout".to_vec());
            }
        }
    };
    let query = full.split_once('?').map_or("", |(_, q)| q);
    let mut pairs: Vec<(Cow<str>, Cow<str>)> = parts
        .headers
        .iter()
        .filter(|(n, _)| !body::is_framing_header(n.as_str()))
        .map(|(n, v)| {
            (
                Cow::Borrowed(n.as_str()),
                String::from_utf8_lossy(v.as_bytes()),
            )
        })
        .collect();
    // R8: HTTP/2 carries the host in `:authority`, not a `host` header.
    if !parts.headers.contains_key(http::header::HOST)
        && let Some(au) = parts.uri.authority()
    {
        pairs.push((Cow::Borrowed("host"), Cow::Owned(au.as_str().to_owned())));
    }
    let req = FetchRequest {
        method,
        url: full,
        headers: pairs,
        body: fb,
        req: crate::routing::routes::build_request_envelope(
            method,
            full,
            query,
            &parts.headers,
            None,
        ),
    };
    let r = call_worker_fetch(&s.pool, s.claim_timeout, s.call_timeout, &req, heap_body).await;
    // R11: a worker call, never a loader call.
    if !matches!(r, Err(CallError::NoWorkers | CallError::Timeout)) {
        s.worker_calls.incr();
    }
    let resp = match r {
        Ok(f) => response_from_fetch(f),
        Err(e @ (CallError::NoWorkers | CallError::Timeout)) => body::error_503(&e.to_string()),
        Err(CallError::Deadline) => {
            s.timed_out_calls.fetch_add(1, Ordering::Relaxed);
            body::error_504("call deadline exceeded")
        }
        Err(e) => {
            tracing::error!(path = full, error = %e, "action call failed");
            body::error_500()
        }
    };
    tracing::debug!(
        target: "brust::request",
        path = full,
        status = resp.status().as_u16(),
        "action"
    );
    if head { body::head_only(resp) } else { resp }
}

/// F87 / spec E10: may a request with these headers mutate through an action? `host` is the request authority
/// (first `X-Forwarded-Host`, else `Host`, else the HTTP/2 `:authority`). Browser-declared only: a request with
/// neither `Sec-Fetch-Site: cross-site` nor an `Origin` is a non-browser client and passes.
pub(crate) fn cross_site_verdict(
    method: &str,
    headers: &HeaderMap,
    host: Option<&str>,
    cors: Option<&ResolvedCors>,
    mode: CrossSite,
) -> Result<(), ()> {
    if matches!(method, "GET" | "HEAD" | "OPTIONS") || mode == CrossSite::Allow {
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
fn request_host(parts: &http::request::Parts) -> Option<String> {
    header_str(&parts.headers, "x-forwarded-host")
        .and_then(|v| v.split(',').next().map(|s| s.trim().to_owned()))
        .filter(|s| !s.is_empty())
        .or_else(|| header_str(&parts.headers, "host"))
        .or_else(|| parts.uri.authority().map(|a| a.as_str().to_owned()))
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

/// The whole body, at most `cap` bytes. A declared Content-Length over the cap is refused before any read; a chunked
/// body is cut off by [`Limited`] the moment it passes the cap; the whole read must finish within `deadline`.
async fn read_capped<B>(b: B, cap: usize, deadline: std::time::Duration) -> Result<Bytes, ReadErr>
where
    B: http_body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    if b.size_hint().lower() > cap as u64 {
        return Err(ReadErr::TooLarge);
    }
    let Ok(read) = tokio::time::timeout(deadline, Limited::new(b, cap).collect()).await else {
        return Err(ReadErr::Slow);
    };
    match read {
        Ok(c) => Ok(c.to_bytes()),
        Err(e) if e.downcast_ref::<LengthLimitError>().is_some() => Err(ReadErr::TooLarge),
        Err(_) => Err(ReadErr::Io),
    }
}

/// R2: text for JSON / form / `text/*` / no type when the bytes are UTF-8; base64 (lossless) for everything else.
fn encode_body(ct: &str, b: Bytes) -> FetchBody {
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

/// R9: the worker's answer as a response — status in 200..=599, framing headers dropped, every other valid pair
/// appended in order (repeated `Set-Cookie` survive). No gzip, never L1.
fn response_from_fetch(f: FetchResponse) -> Response<Bytes> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Frame;
    use http_body_util::{Full, StreamBody};
    use std::convert::Infallible;

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
        let host = request_host(&parts);
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

    fn chunks(
        n: usize,
        size: usize,
    ) -> StreamBody<tokio_stream::Iter<std::vec::IntoIter<Result<Frame<Bytes>, Infallible>>>> {
        let v: Vec<_> = (0..n)
            .map(|_| Ok(Frame::data(Bytes::from(vec![b'a'; size]))))
            .collect();
        StreamBody::new(tokio_stream::iter(v))
    }

    #[tokio::test]
    async fn read_capped_by_length_and_by_stream() {
        let full = |n: usize| Full::new(Bytes::from(vec![b'a'; n]));
        assert_eq!(
            read_capped(full(1025), 1024, T).await,
            Err(ReadErr::TooLarge)
        );
        assert_eq!(read_capped(full(1024), 1024, T).await.unwrap().len(), 1024);
        assert_eq!(
            read_capped(chunks(3, 512), 1024, T).await,
            Err(ReadErr::TooLarge)
        );
        assert_eq!(
            read_capped(chunks(2, 512), 1024, T).await.unwrap().len(),
            1024
        );
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

    const T: std::time::Duration = std::time::Duration::from_secs(5);

    #[tokio::test]
    async fn read_capped_gives_up_on_a_trickled_body() {
        let pending = StreamBody::new(tokio_stream::pending::<Result<Frame<Bytes>, Infallible>>());
        let d = std::time::Duration::from_millis(50);
        assert_eq!(read_capped(pending, 1024, d).await, Err(ReadErr::Slow));
    }

    #[test]
    fn response_from_fetch_rules() {
        let r = response_from_fetch(FetchResponse {
            status: 600,
            headers: vec![],
            body: Bytes::new(),
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
        });
        assert_eq!(r.status(), 201);
        let c: Vec<_> = r.headers().get_all("set-cookie").iter().collect();
        assert_eq!(c, ["a=1", "b=2"]);
        assert_eq!(r.headers().len(), 2);
    }
}
