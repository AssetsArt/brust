//! M3-F E3/E4: the actions subtree — one `fetch` worker call per request under the prefix, before
//! the method gate; the body cap, the body encoding (R2), the response rules (R9), stats (R11).
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use brust_server::{ActionsConfig, CrossSite, StreamConfig, StreamRoute, start};
use common::*;
use serde_json::{Value, json};

const URL: &str = "/_brust/action/team?x=1";

/// Echoes the A1 request back as the JSON body.
fn echo(req: Value) -> Vec<u8> {
    frame(
        200,
        &[("content-type", "application/json")],
        &serde_json::to_vec(&req).unwrap(),
    )
}

/// A tiny answer, for requests whose echo would not fit the slot.
fn ok(_: Value) -> Vec<u8> {
    frame(200, &[("content-type", "text/plain")], b"ok")
}

fn server(f: fn(Value) -> Vec<u8>) -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    server_cap(f, brust_server::DEFAULT_MAX_ACTION_BODY_BYTES)
}

fn server_cap(f: fn(Value) -> Vec<u8>, cap: usize) -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    let fake = fake().with_fetch(f);
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig {
            max_body_bytes: cap,
            ..ActionsConfig::default()
        },
        None,
    );
    (fake, s)
}

fn last(fake: &FakeBun) -> Value {
    fake.last_fetch().expect("a fetch call")
}

fn header_names(h: &http::HeaderMap) -> Vec<String> {
    let mut v: Vec<String> = h
        .keys()
        .filter(|k| k.as_str() != "date")
        .map(|k| k.as_str().to_owned())
        .collect();
    v.sort();
    v
}

#[test]
fn every_method_under_the_prefix_reaches_the_worker() {
    let (fake, s) = server(echo);
    for m in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
        let (status, _, body) = request_body(&s, m, URL, &[], Vec::new());
        assert_eq!(status, 200, "{m}: {}", String::from_utf8_lossy(&body));
        let r = last(&fake);
        assert_eq!(r["method"], m);
        assert_eq!(r["url"], URL);
    }
    let (status, _, _) = request_body(&s, "POST", "/_brust/action", &[], Vec::new());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["url"], "/_brust/action");
    assert_eq!(fake.fetch_count(), 7);
}

#[test]
fn outside_the_prefix_keeps_405_and_404() {
    let (fake, s) = server(echo);
    let (status, h, _) = request_body(&s, "POST", "/", &[], Vec::new());
    assert_eq!(status, 405);
    assert_eq!(hdr(&h, "allow"), Some("GET, HEAD"));
    let (status, _, _) = request_body(&s, "POST", "/_brust/actionX", &[], Vec::new());
    assert_eq!(status, 405);
    let (status, _, _) = get(&s, "/_brust/action2", &[]);
    assert_eq!(status, 404);
    assert_eq!(fake.fetch_count(), 0);
}

#[test]
fn no_actions_config_is_byte_identical() {
    // The lane base's answers, pinned: no actions = no branch.
    let s = boot(fake());
    let (status, h, body) = request_body(&s, "POST", "/_brust/action/x", &[], b"{}".to_vec());
    assert_eq!((status, body.as_slice()), (405, &b"method not allowed"[..]));
    assert_eq!(
        header_names(&h),
        ["allow", "content-length", "content-type"]
    );
    assert_eq!(hdr(&h, "allow"), Some("GET, HEAD"));
    assert_eq!(hdr(&h, "content-type"), Some("text/plain"));
    assert_eq!(hdr(&h, "content-length"), Some("18"));
    let (status, h, body) = get(&s, "/_brust/action/x", &[]);
    assert_eq!((status, body.as_str()), (404, "not found"));
    assert_eq!(header_names(&h), ["content-length", "content-type"]);
    assert_eq!(hdr(&h, "content-type"), Some("text/plain"));
}

#[test]
fn body_over_cap_by_content_length_is_413() {
    let (fake, s) = server_cap(echo, 1024);
    let (status, h, body) = request_body(&s, "POST", URL, &[], vec![b'a'; 1025]);
    assert_eq!((status, body.as_slice()), (413, &b"payload too large"[..]));
    assert_eq!(hdr(&h, "connection"), Some("close"));
    let (status, _, _) = request_body(&s, "POST", URL, &[], vec![b'a'; 1024]);
    assert_eq!(status, 200);
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn chunked_body_over_cap_is_413() {
    let (fake, s) = server_cap(ok, 262_144);
    let (status, h, body) = request_chunked(&s, "POST", URL, &[], vec![vec![b'a'; 1024]; 300]);
    assert_eq!((status, body.as_slice()), (413, &b"payload too large"[..]));
    // F127: the connection of a refused body is not reused (the read-out is bounded).
    assert_eq!(hdr(&h, "connection"), Some("close"));
    assert_eq!(fake.fetch_count(), 0);
}

/// A raw HTTP/1.1 client for the refusal tests: writes `head`, then `body` in pieces, and reports what it saw. Unlike
/// the hyper client, a write error does not hide the response: it is recorded and the response is still read.
struct Raw {
    write_err: Option<std::io::ErrorKind>,
    response: Result<String, std::io::ErrorKind>,
}

fn raw_exchange(
    s: &brust_server::Server,
    head: &str,
    body: &[Vec<u8>],
    finish: Option<&[u8]>,
) -> Raw {
    use std::io::{Read, Write};
    let mut c = std::net::TcpStream::connect(s.local_addr()).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    c.write_all(head.as_bytes()).unwrap();
    let mut write_err = None;
    for piece in body {
        if let Err(e) = c.write_all(piece) {
            write_err = Some(e.kind());
            break;
        }
    }
    if write_err.is_none()
        && let Some(f) = finish
    {
        let _ = c.write_all(f);
    }
    let mut got = Vec::new();
    let mut buf = [0u8; 2048];
    let response = loop {
        match c.read(&mut buf) {
            Ok(0) => break Ok(String::from_utf8_lossy(&got).into_owned()),
            Ok(n) => {
                got.extend_from_slice(&buf[..n]);
                if got.windows(4).any(|w| w == b"\r\n\r\n") && got.len() > 20 {
                    break Ok(String::from_utf8_lossy(&got).into_owned());
                }
            }
            Err(e) => break Err(e.kind()),
        }
    };
    Raw {
        write_err,
        response,
    }
}

fn chunk(n: usize) -> Vec<u8> {
    let mut c = format!("{n:x}\r\n").into_bytes();
    c.extend(vec![b'a'; n]);
    c.extend(b"\r\n");
    c
}

/// F127: a refused body is read out (up to a bound) before the connection closes, so the 413 reaches the client
/// instead of a reset. Before the fix a client still writing when the server closed got EPIPE/ECONNRESET in about a
/// fifth of the attempts (macOS, a raw client: 44/200 write errors; 130/200 reads ended in ECONNRESET).
#[test]
fn refused_chunked_body_is_read_out_so_the_413_survives() {
    let (_fake, s) = server_cap(ok, 262_144);
    for attempt in 0..100 {
        let body: Vec<Vec<u8>> = (0..300).map(|_| chunk(1024)).collect();
        let r = raw_exchange(
            &s,
            &format!("POST {URL} HTTP/1.1\r\nhost: fx\r\ntransfer-encoding: chunked\r\n\r\n"),
            &body,
            Some(b"0\r\n\r\n"),
        );
        assert_eq!(
            r.write_err, None,
            "attempt {attempt}: the client's write failed (the server closed first)"
        );
        let resp = r
            .response
            .unwrap_or_else(|k| panic!("attempt {attempt}: reading the answer failed: {k:?}"));
        assert!(
            resp.starts_with("HTTP/1.1 413"),
            "attempt {attempt}: {resp:?}"
        );
    }
}

#[test]
fn refused_content_length_body_is_read_out_so_the_413_survives() {
    let (_fake, s) = server_cap(ok, 1024);
    for attempt in 0..100 {
        let body = vec![vec![b'a'; 300 * 1024]];
        let r = raw_exchange(
            &s,
            &format!(
                "POST {URL} HTTP/1.1\r\nhost: fx\r\ncontent-length: {}\r\n\r\n",
                300 * 1024
            ),
            &body,
            None,
        );
        assert_eq!(
            r.write_err, None,
            "attempt {attempt}: the client's write failed (the server closed first)"
        );
        let resp = r
            .response
            .unwrap_or_else(|k| panic!("attempt {attempt}: reading the answer failed: {k:?}"));
        assert!(
            resp.starts_with("HTTP/1.1 413"),
            "attempt {attempt}: {resp:?}"
        );
    }
}

/// The read-out is bounded: a client that sends past the cap and then goes quiet (never ends its body) still gets its
/// 413 within the discard timeout, not after the call timeout.
#[test]
fn refused_body_that_never_ends_is_answered_within_the_discard_bound() {
    let (_fake, s) = server_cap(ok, 1024);
    let t0 = Instant::now();
    let r = raw_exchange(
        &s,
        &format!("POST {URL} HTTP/1.1\r\nhost: fx\r\ntransfer-encoding: chunked\r\n\r\n"),
        &[chunk(2048)],
        None,
    );
    let resp = r.response.unwrap_or_else(|k| panic!("no answer: {k:?}"));
    assert!(resp.starts_with("HTTP/1.1 413"), "{resp:?}");
    assert!(
        t0.elapsed() < Duration::from_secs(4),
        "the 413 took {:?}",
        t0.elapsed()
    );
}

#[test]
fn chunked_body_at_cap_is_forwarded() {
    let (fake, s) = server(ok);
    let (status, _, _) = request_chunked(
        &s,
        "POST",
        URL,
        &[("content-type", "text/plain")],
        vec![vec![b'a'; 1024]; 256],
    );
    assert_eq!(status, 200);
    let r = last(&fake);
    assert_eq!(r["body"]["text"].as_str().unwrap().len(), 262_144);
    assert!(
        r["headers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p[0] != "transfer-encoding")
    );
}

#[test]
fn content_encoding_is_415() {
    let (fake, s) = server(echo);
    let (status, _, body) = request_body(
        &s,
        "POST",
        URL,
        &[("content-encoding", "gzip")],
        b"x".to_vec(),
    );
    assert_eq!(
        (status, body.as_slice()),
        (415, &b"unsupported media type"[..])
    );
    assert_eq!(fake.fetch_count(), 0);
    let (status, _, _) = request_body(
        &s,
        "POST",
        URL,
        &[("content-encoding", "identity")],
        b"x".to_vec(),
    );
    assert_eq!(status, 200);
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn body_encoding_text_vs_b64() {
    let (fake, s) = server(echo);
    let body_of = |ct: Option<&str>, b: &[u8]| {
        let h: Vec<(&str, &str)> = ct.map(|c| ("content-type", c)).into_iter().collect();
        let (status, _, _) = request_body(&s, "POST", URL, &h, b.to_vec());
        assert_eq!(status, 200);
        last(&fake)["body"].clone()
    };
    for (ct, b) in [
        (Some("application/json"), &b"{\"a\":1}"[..]),
        (None, b"plain"),
        (Some("text/plain; charset=utf-8"), "héllo".as_bytes()),
        (Some("application/x-www-form-urlencoded"), b"a=1&b=2"),
        (Some("application/merge-patch+json"), b"{}"),
    ] {
        assert_eq!(
            body_of(ct, b),
            json!({"text": std::str::from_utf8(b).unwrap()}),
            "{ct:?}"
        );
    }
    assert_eq!(
        body_of(Some("application/octet-stream"), &[0, 1, 255]),
        json!({"b64": "AAH/"})
    );
    assert_eq!(
        body_of(Some("multipart/form-data; boundary=x"), b"--x--"),
        json!({"b64": "LS14LS0="})
    );
    assert_eq!(body_of(Some("text/plain"), &[0xff]), json!({"b64": "/w=="}));
    assert_eq!(body_of(Some("application/json"), b""), Value::Null);
}

#[test]
fn get_and_head_bodies_are_not_read() {
    let (fake, s) = server(echo);
    let (status, _, _) = request_open_body(&s, "GET", URL, &[]);
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["body"], Value::Null);
    let (status, _, _) = request_open_body(&s, "HEAD", URL, &[]);
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["method"], "HEAD");
    assert_eq!(last(&fake)["body"], Value::Null);
}

#[test]
fn page_route_never_reads_the_body() {
    let (fake, s) = server(echo);
    let (status, _, body) = request_open_body(&s, "GET", "/pokemon/pikachu", &[]);
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let (status, _, _) = request_open_body(&s, "POST", "/", &[]);
    assert_eq!(status, 405);
    assert_eq!(fake.fetch_count(), 0);
}

#[test]
fn headers_cross_as_pairs_minus_hop_by_hop() {
    let (fake, s) = server(echo);
    let (status, _, _) = request_body(
        &s,
        "POST",
        URL,
        &[("x-dup", "1"), ("x-dup", "2"), ("connection", "keep-alive")],
        b"{}".to_vec(),
    );
    assert_eq!(status, 200);
    let r = last(&fake);
    let pairs: Vec<(String, String)> = serde_json::from_value(r["headers"].clone()).unwrap();
    let dups: Vec<&str> = pairs
        .iter()
        .filter(|(k, _)| k == "x-dup")
        .map(|(_, v)| v.as_str())
        .collect();
    assert_eq!(dups, ["1", "2"]);
    for f in ["transfer-encoding", "connection"] {
        assert!(pairs.iter().all(|(k, _)| k != f), "{f} crossed: {pairs:?}");
    }
    // F474: the client's own Content-Length crosses (the body is `{}`: 2 bytes).
    assert!(
        pairs.contains(&("content-length".into(), "2".into())),
        "{pairs:?}"
    );
    assert!(pairs.contains(&("host".into(), "fx".into())), "{pairs:?}");
    assert!(!r["req"]["headers"]["x-dup"].is_null(), "{}", r["req"]);

    let (status, _, _) = request_chunked(&s, "POST", URL, &[], vec![b"{}".to_vec()]);
    assert_eq!(status, 200);
    let pairs: Vec<(String, String)> =
        serde_json::from_value(last(&fake)["headers"].clone()).unwrap();
    // a chunked request has no Content-Length to keep, and none is invented
    for f in ["transfer-encoding", "content-length"] {
        assert!(pairs.iter().all(|(k, _)| k != f), "{f} crossed: {pairs:?}");
    }
}

fn binary(_: Value) -> Vec<u8> {
    let body: Vec<u8> = (0u8..=255).collect();
    frame(
        201,
        &[
            ("content-type", "application/octet-stream"),
            ("set-cookie", "a=1; Path=/"),
            ("set-cookie", "b=2; Path=/"),
            ("x-custom", "v"),
        ],
        &body,
    )
}

#[test]
fn framing_round_trip_binary_and_two_cookies() {
    let (_fake, s) = server(binary);
    let (status, h, body) = request_raw(&s, "GET", URL, &[("accept-encoding", "gzip")]);
    assert_eq!(status, 201);
    let cookies: Vec<&str> = h
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect();
    assert_eq!(cookies, ["a=1; Path=/", "b=2; Path=/"]);
    assert_eq!(hdr(&h, "x-custom"), Some("v"));
    assert_eq!(hdr(&h, "content-type"), Some("application/octet-stream"));
    assert_eq!(body, (0u8..=255).collect::<Vec<u8>>());
    assert!(cache_hdr(&h).is_none());
    assert!(h.get("content-encoding").is_none());
}

#[test]
fn framing_headers_from_the_worker_are_dropped() {
    let (_fake, s) = server(|_| {
        frame(
            200,
            &[
                ("content-length", "999"),
                ("transfer-encoding", "chunked"),
                ("connection", "close"),
                ("bad name", "x"),
                ("x-ok", "1"),
            ],
            b"hello",
        )
    });
    let (status, h, body) = request_raw(&s, "GET", URL, &[]);
    assert_eq!((status, body.as_slice()), (200, &b"hello"[..]));
    assert_eq!(hdr(&h, "content-length"), Some("5"));
    assert!(h.get("transfer-encoding").is_none());
    assert_eq!(hdr(&h, "x-ok"), Some("1"));
}

#[test]
fn never_cached() {
    let (fake, s) = server(echo);
    get(&s, URL, &[]);
    let (_, h, _) = get(&s, URL, &[]);
    assert!(cache_hdr(&h).is_none());
    assert_eq!(fake.fetch_count(), 2);
    let st = stats(&s);
    assert_eq!(st["loader_calls"], 0);
    assert_eq!(st["worker_calls"], 2);
}

#[test]
fn head_under_the_prefix_strips_the_body() {
    let (fake, s) = server(|_| frame(200, &[("content-type", "text/plain")], b"hello world"));
    let (status, h, body) = request_raw(&s, "HEAD", URL, &[]);
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["method"], "HEAD");
    assert!(body.is_empty());
    assert_eq!(hdr(&h, "content-length"), Some("11"));
}

#[test]
fn connect_trace_track_are_501() {
    let (fake, s) = server(echo);
    for m in ["TRACE", "TRACK"] {
        let (status, _, body) = request_raw(&s, m, URL, &[]);
        assert_eq!(
            (status, body.as_slice()),
            (501, &b"not implemented"[..]),
            "{m}"
        );
    }
    // CONNECT carries an authority-form target from a real client; hyper's server still parses an
    // origin-form one, which lands in the branch: probe it over a raw socket.
    let raw = raw_request(
        &s,
        b"CONNECT /_brust/action/x HTTP/1.1\r\nhost: fx\r\ncontent-length: 0\r\n\r\n",
    );
    assert!(
        raw.starts_with("HTTP/1.1 501") && raw.ends_with("not implemented"),
        "{raw}"
    );
    assert_eq!(fake.fetch_count(), 0);
}

/// Writes `req` on a fresh socket and reads until the server closes or 1 s passes.
fn raw_request(s: &brust_server::Server, req: &[u8]) -> String {
    use std::io::{Read, Write};
    let mut tcp = std::net::TcpStream::connect(s.local_addr()).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    tcp.write_all(req).unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(n) = tcp.read(&mut chunk) {
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[test]
fn bad_status_from_the_worker_is_500() {
    for code in [99u16, 600] {
        let fake = fake().with_fetch(move |_| frame(code, &[], b"x"));
        let s = boot_actions(fake, &fx(), ActionsConfig::default(), None);
        let (status, _, body) = get(&s, URL, &[]);
        assert_eq!(
            (status, body.as_str()),
            (500, "500 Internal Server Error"),
            "{code}"
        );
    }
}

#[test]
fn worker_oversize_frame_is_relayed_as_500() {
    // R10: the worker answers this frame when the Response does not fit its slot.
    let (_fake, s) = server(|_| {
        frame(
            500,
            &[("content-type", "text/plain; charset=utf-8")],
            b"brust: action response exceeds 262144 bytes",
        )
    });
    let (status, h, body) = get(&s, URL, &[]);
    assert_eq!(
        (status, body.as_str()),
        (500, "brust: action response exceeds 262144 bytes")
    );
    assert_eq!(hdr(&h, "content-type"), Some("text/plain; charset=utf-8"));
}

#[test]
fn json_answer_to_fetch_is_500() {
    let (_fake, s) = server(|_| br#"{"error":"unknown call kind fetch"}"#.to_vec());
    let (status, _, body) = get(&s, URL, &[]);
    assert_eq!((status, body.as_str()), (500, "500 Internal Server Error"));
}

#[test]
fn deadline_is_504() {
    let fake = FakeBun::with(default_loader, default_jobs, true).with_fetch(echo);
    let mut cfg = config(&fx());
    cfg.tuning.call_timeout_ms = 50;
    cfg.actions = Some(ActionsConfig::default());
    let s = start(cfg).expect("start");
    s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    let (status, _, body) = get(&s, URL, &[]);
    assert_eq!((status, body.as_str()), (504, "call deadline exceeded"));
    let st = stats(&s);
    assert_eq!(st["timed_out_calls"], 1);
    assert_eq!(st["worker_calls"], 1);
    assert_eq!(st["loader_calls"], 0);
}

#[test]
fn no_workers_is_503() {
    let mut cfg = config(&fx());
    cfg.expected_workers = 0;
    cfg.actions = Some(ActionsConfig::default());
    let s = start(cfg).expect("start");
    let t0 = Instant::now();
    let (status, _, body) = request_body(&s, "POST", URL, &[], b"{}".to_vec());
    assert_eq!((status, body.as_slice()), (503, &b"no workers"[..]));
    assert!(t0.elapsed() < Duration::from_secs(1));
    assert_eq!(stats(&s)["worker_calls"], 0);
}

// ----- CORS parity (0.1.x `tests/cors.integration.test.ts`, F11): the chokepoint in
// `server/mod.rs` stamps action responses like every other response; `actions.rs` never stamps.

const ALLOWED: &str = "http://allowed.test";
const EVIL: &str = "http://evil.test";
const ACTION: &str = "/_brust/action/notes";

fn note(_: Value) -> Vec<u8> {
    frame(
        200,
        &[("content-type", "application/json")],
        br#"{"id":"n-2"}"#,
    )
}

fn cors_policy() -> brust_server::CorsConfig {
    brust_server::CorsConfig {
        origins: vec![ALLOWED.into()],
        methods: None,
        headers: None,
        expose_headers: Some(vec!["x-render-ms".into()]),
        credentials: true,
        max_age_seconds: None,
    }
}

fn cors_server(f: fn(Value) -> Vec<u8>) -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    let fake = fake().with_fetch(f);
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig::default(),
        Some(cors_policy()),
    );
    (fake, s)
}

/// Case-insensitive Vary tokens, in order (Vary is a comma-joined token list, possibly multi-line).
fn vary_tokens(h: &http::HeaderMap) -> Vec<String> {
    h.get_all("vary")
        .iter()
        .flat_map(|v| v.to_str().unwrap().split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

fn post_note(s: &brust_server::Server, origin: &str) -> (u16, http::HeaderMap, Vec<u8>) {
    request_body(
        s,
        "POST",
        ACTION,
        &[("origin", origin), ("content-type", "application/json")],
        br#"{"text":"hi"}"#.to_vec(),
    )
}

#[test]
fn cors_preflight_on_the_action_path_is_204() {
    let (fake, s) = cors_server(note);
    let (status, h, body) = request(
        &s,
        "OPTIONS",
        ACTION,
        &[
            ("origin", ALLOWED),
            ("access-control-request-method", "POST"),
            ("access-control-request-headers", "content-type"),
        ],
    );
    assert_eq!((status, body.as_str()), (204, ""));
    assert_eq!(hdr(&h, "access-control-allow-origin"), Some(ALLOWED));
    assert!(
        hdr(&h, "access-control-allow-methods")
            .unwrap()
            .split(',')
            .any(|m| m == "POST")
    );
    assert_eq!(hdr(&h, "access-control-allow-credentials"), Some("true"));
    // No `headers` configured → the request's Access-Control-Request-Headers is echoed.
    assert_eq!(
        hdr(&h, "access-control-allow-headers"),
        Some("content-type")
    );
    assert_eq!(hdr(&h, "access-control-max-age"), Some("600"));
    assert_eq!(
        vary_tokens(&h),
        [
            "origin",
            "access-control-request-method",
            "access-control-request-headers"
        ]
    );
    assert_eq!(
        fake.fetch_count(),
        0,
        "a preflight never reaches the worker"
    );
}

#[test]
fn cors_action_post_is_stamped() {
    let (fake, s) = cors_server(note);
    let (status, h, body) = post_note(&s, ALLOWED);
    assert_eq!((status, body.as_slice()), (200, &br#"{"id":"n-2"}"#[..]));
    assert_eq!(hdr(&h, "access-control-allow-origin"), Some(ALLOWED));
    assert_eq!(hdr(&h, "access-control-allow-credentials"), Some("true"));
    assert_eq!(
        hdr(&h, "access-control-expose-headers"),
        Some("x-render-ms")
    );
    assert!(vary_tokens(&h).contains(&"origin".to_owned()));
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn cors_disallowed_origin_is_processed_without_acao() {
    // With `cross_site = "allow"` the server is not the enforcement point for a non-preflight request: the
    // browser blocks the READ when ACAO is missing. (Under the F87 default this POST is a 403: see below.)
    let fake = fake().with_fetch(note);
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig {
            cross_site: CrossSite::Allow,
            ..ActionsConfig::default()
        },
        Some(cors_policy()),
    );
    let (status, h, _) = post_note(&s, EVIL);
    assert_eq!(status, 200);
    assert_eq!(hdr(&h, "access-control-allow-origin"), None);
    assert_eq!(hdr(&h, "access-control-allow-credentials"), None);
    assert_eq!(hdr(&h, "access-control-expose-headers"), None);
    assert!(vary_tokens(&h).contains(&"origin".to_owned()));
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn cors_page_get_is_stamped() {
    let (fake, s) = cors_server(note);
    let (status, h, _) = get(&s, "/", &[("origin", ALLOWED)]);
    assert_eq!(status, 200);
    assert_eq!(hdr(&h, "access-control-allow-origin"), Some(ALLOWED));
    assert!(vary_tokens(&h).contains(&"origin".to_owned()));
    assert_eq!(fake.fetch_count(), 0);
}

#[test]
fn cors_static_vary_merges() {
    // `static_asset_response` emits `Vary: Accept-Encoding`; the chokepoint APPENDS Origin.
    let (_fake, s) = cors_server(note);
    let (status, h, _) = get(&s, "/_brust/client/runtime-8b1c.js", &[("origin", ALLOWED)]);
    assert_eq!(status, 200);
    let tokens = vary_tokens(&h);
    assert!(tokens.contains(&"accept-encoding".to_owned()), "{tokens:?}");
    assert!(tokens.contains(&"origin".to_owned()), "{tokens:?}");
    assert_eq!(hdr(&h, "access-control-allow-origin"), Some(ALLOWED));
}

#[test]
fn cors_options_without_preflight_headers() {
    // R3: under the prefix the subtree is the app's — an OPTIONS that is not a preflight (no
    // Access-Control-Request-Method) is forwarded (0.1.x answered a Rust 405). On a page path
    // the 0.1.x 405 stays.
    let (fake, s) = cors_server(note);
    let (status, h, _) = request(&s, "OPTIONS", ACTION, &[("origin", ALLOWED)]);
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["method"], "OPTIONS");
    // The forwarded answer is an actual response: stamped like any other.
    assert_eq!(hdr(&h, "access-control-allow-origin"), Some(ALLOWED));
    assert_eq!(fake.fetch_count(), 1);

    let (status, h, _) = request(&s, "OPTIONS", "/", &[("origin", ALLOWED)]);
    assert_eq!(status, 405);
    assert_eq!(hdr(&h, "allow"), Some("GET, HEAD"));
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn cors_disallowed_preflight() {
    // R3: a preflight from a disallowed origin is not answered in Rust; under the prefix it is
    // forwarded (no ACAO), on a page path it falls through to the 405 (no ACAO), as in 0.1.x.
    let (fake, s) = cors_server(note);
    let pre = [("origin", EVIL), ("access-control-request-method", "POST")];
    let (status, h, _) = request(&s, "OPTIONS", ACTION, &pre);
    assert_eq!(status, 200);
    assert_eq!(hdr(&h, "access-control-allow-origin"), None);
    assert_eq!(fake.fetch_count(), 1);

    let (status, h, _) = request(&s, "OPTIONS", "/", &pre);
    assert_eq!(status, 405);
    assert_eq!(hdr(&h, "access-control-allow-origin"), None);
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn cors_worker_acao_wins() {
    // Insert-if-absent: an ACAO the app set is kept; Vary still gains Origin.
    let (_fake, s) =
        cors_server(|_| frame(200, &[("access-control-allow-origin", "https://x")], b"ok"));
    let (status, h, _) = post_note(&s, ALLOWED);
    assert_eq!(status, 200);
    assert_eq!(
        h.get_all("access-control-allow-origin")
            .iter()
            .collect::<Vec<_>>(),
        ["https://x"]
    );
    assert!(vary_tokens(&h).contains(&"origin".to_owned()));
}

#[test]
fn cors_credentials_with_wildcard_is_a_boot_error() {
    let mut cfg = config(&fx());
    cfg.actions = Some(ActionsConfig::default());
    cfg.cors = Some(brust_server::CorsConfig {
        origins: vec!["*".into()],
        ..cors_policy()
    });
    let Err(msg) = start(cfg) else {
        panic!("start should refuse credentials with a wildcard origin");
    };
    assert!(
        msg.starts_with("cors: ") && msg.contains("wildcard"),
        "{msg}"
    );
}

// ---- M3-F A4: the `__BRUST_ACTION_PREFIX__` script ----

const PREFIX_TAG: &str = "<script>globalThis.__BRUST_ACTION_PREFIX__=\"/api\"</script>";

fn api_server() -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    let fake = fake().with_fetch(echo);
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig {
            prefix: "/api".into(),
            ..ActionsConfig::default()
        },
        None,
    );
    (fake, s)
}

#[test]
fn non_default_prefix_page_gets_the_tag() {
    let (_fake, s) = api_server();
    let (status, h1, b1) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(status, 200, "{b1}");
    assert_eq!(cache_hdr(&h1), Some("MISS"));
    assert_eq!(b1.matches(PREFIX_TAG).count(), 1, "{b1}");
    assert!(
        b1.contains(&format!(
            "{PREFIX_TAG}<script type=\"module\" src=\"/_brust/client/runtime-"
        )),
        "{b1}"
    );
    let (status, h2, b2) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(status, 200);
    assert_eq!(cache_hdr(&h2), Some("HIT"));
    assert_eq!(b1, b2);
}

#[test]
fn default_prefix_adds_no_tag() {
    let with = boot_actions(fake(), &fx(), ActionsConfig::default(), None);
    let without = boot(fake());
    for path in ["/pokemon/pikachu?nocache=1", "/?nocache=1"] {
        let (s1, _, b1) = get(&with, path, &[]);
        let (s2, _, b2) = get(&without, path, &[]);
        assert_eq!((s1, s2), (200, 200), "{path}");
        assert!(!b1.contains("__BRUST_ACTION_PREFIX__"), "{b1}");
        assert_eq!(b1, b2, "{path}");
    }
}

#[test]
fn api_prefix_routes_actions() {
    let (fake, s) = api_server();
    let (status, _, _) = request_body(&s, "POST", "/api/x", &[], b"{}".to_vec());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["url"], "/api/x");
    let (status, _, _) = request_body(&s, "POST", "/_brust/action/x", &[], b"{}".to_vec());
    assert_eq!(status, 405);
    assert_eq!(fake.fetch_count(), 1);
}

// ---- F470: page and loader routes under the actions prefix ----

fn prefixed(prefix: &str) -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    let fake = fake().with_fetch(echo);
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig {
            prefix: prefix.into(),
            ..ActionsConfig::default()
        },
        None,
    );
    (fake, s)
}

#[test]
fn a_get_route_under_the_prefix_is_the_page_and_every_other_request_the_actions_app() {
    let (fake, s) = prefixed("/pokemon");
    // GET and HEAD of /pokemon/{name}: the loader route, not the actions app
    let (status, h, b) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(status, 200, "{b}");
    assert_eq!(cache_hdr(&h), Some("MISS"));
    assert!(b.contains("pikachu"), "{b}");
    let (status, _, body) = request_body(&s, "HEAD", "/pokemon/pikachu", &[], Vec::new());
    assert_eq!((status, body.len()), (200, 0));
    assert_eq!(fake.fetch_count(), 0);
    // POST at the same path: the action
    let (status, _, _) = request_body(&s, "POST", "/pokemon/pikachu", &[], b"{}".to_vec());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["url"], "/pokemon/pikachu");
    assert_eq!(fake.fetch_count(), 1);
    // a GET no route matches (the prefix itself, a deeper path): the catch-all does not take it, the actions app does
    for path in ["/pokemon", "/pokemon/a/b"] {
        let (status, _, b) = get(&s, path, &[]);
        assert_eq!(status, 200, "{path}: {b}");
        assert_eq!(last(&fake)["url"], path);
    }
    assert_eq!(fake.fetch_count(), 3);
}

#[test]
fn a_route_declared_outside_the_prefix_does_not_take_a_path_under_it() {
    // /pokemon/{name} matches /pokemon/pikachu, but its pattern is not under /pokemon/pikachu
    let (fake, s) = prefixed("/pokemon/pikachu");
    let (status, _, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["url"], "/pokemon/pikachu");
    // outside the prefix the route still serves
    let (status, _, b) = get(&s, "/pokemon/eevee", &[]);
    assert_eq!(status, 200, "{b}");
    assert!(b.contains("eevee"), "{b}");
    assert_eq!(fake.fetch_count(), 1);
}

/// The app's URL parser would resolve these out of (or around) the path Rust admitted: 400, never forwarded.
#[test]
fn dot_segments_and_backslashes_are_400() {
    let (fake, s) = server(echo);
    for p in [
        "/_brust/action/%2e%2e/x",
        "/_brust/action/x/%2E%2e/y",
        "/_brust/action/a%5Cb",
    ] {
        let (status, _, _) = request_body(&s, "POST", p, &[], b"x".to_vec());
        assert_eq!(status, 400, "{p}");
    }
    assert_eq!(fake.fetch_count(), 0);
    let (status, _, _) = request_body(&s, "POST", "/_brust/action/a.b", &[], b"x".to_vec());
    assert_eq!(status, 200);
    assert_eq!(fake.fetch_count(), 1);
}

// ----- F87 / spec E10: cross-site mutating requests are refused in Rust, before the body and the worker -----

fn post_with(
    s: &brust_server::Server,
    headers: &[(&str, &str)],
) -> (u16, http::HeaderMap, Vec<u8>) {
    request_body(s, "POST", ACTION, headers, br#"{"text":"hi"}"#.to_vec())
}

#[test]
fn cross_site_post_is_403_and_the_worker_is_not_called() {
    let (fake, s) = server(note);
    let (st, h, b) = post_with(
        &s,
        &[("origin", EVIL), ("content-type", "application/json")],
    );
    assert_eq!(st, 403);
    assert_eq!(hdr(&h, "content-type"), Some("application/problem+json"));
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(v["title"], "CrossSiteRejected");
    assert_eq!(v["status"], 403);
    assert!(
        v["detail"]
            .as_str()
            .unwrap()
            .starts_with("cross-site POST to an action is rejected")
    );
    assert_eq!(fake.fetch_count(), 0);
    // Fetch Metadata alone (no Origin) is enough.
    let (st, ..) = post_with(&s, &[("sec-fetch-site", "cross-site")]);
    assert_eq!(st, 403);
    assert_eq!(fake.fetch_count(), 0);
}

#[test]
fn same_origin_headerless_and_get_requests_are_forwarded() {
    let (fake, s) = server(note);
    // `host: fx` is what the harness sends.
    assert_eq!(post_with(&s, &[("origin", "http://fx")]).0, 200);
    assert_eq!(post_with(&s, &[]).0, 200);
    assert_eq!(
        request_body(&s, "GET", ACTION, &[("origin", EVIL)], vec![]).0,
        200
    );
    assert_eq!(fake.fetch_count(), 3);
}

#[test]
fn cross_site_allow_forwards_a_foreign_post() {
    let fake = fake().with_fetch(note);
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig {
            cross_site: CrossSite::Allow,
            ..ActionsConfig::default()
        },
        None,
    );
    assert_eq!(post_with(&s, &[("origin", EVIL)]).0, 200);
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn cross_site_cors_listed_origin_is_forwarded_and_stamped() {
    let (fake, s) = cors_server(note);
    let (st, h, _) = post_note(&s, ALLOWED);
    assert_eq!(st, 200);
    assert_eq!(hdr(&h, "access-control-allow-origin"), Some(ALLOWED));
    assert_eq!(post_note(&s, EVIL).0, 403);
    assert_eq!(fake.fetch_count(), 1);
}

// ---- F82: bodies larger than the slot cross by heap transfer ----

fn server_resp_cap(
    f: fn(Value) -> Vec<u8>,
    max_response_bytes: usize,
) -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    let fake = fake().with_fetch(f);
    fake.set_response_cap(max_response_bytes);
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig {
            max_response_bytes,
            ..ActionsConfig::default()
        },
        None,
    );
    (fake, s)
}

#[test]
fn body_at_threshold_is_inline_and_one_over_is_heap() {
    let (fake, s) = server(ok);
    let h = [("content-type", "text/plain")];
    let at = vec![b'a'; 262_144];
    let (status, _, _) = request_body(&s, "POST", URL, &h, at.clone());
    assert_eq!(status, 200);
    assert_eq!(
        last(&fake)["body"],
        json!({"text": String::from_utf8(at).unwrap()})
    );
    assert_eq!(fake.last_fetch_body(), None);
    let over = vec![b'b'; 262_145];
    let (status, _, _) = request_body(&s, "POST", URL, &h, over.clone());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["body"], json!({"heap": 262_145}));
    assert_eq!(fake.last_fetch_body().as_deref(), Some(&over[..]));
}

#[test]
fn heap_body_binary_is_lossless() {
    let (fake, s) = server(ok);
    let bin: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
    let h = [("content-type", "application/octet-stream")];
    let (status, _, _) = request_body(&s, "POST", URL, &h, bin.clone());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["body"], json!({"heap": bin.len()}));
    assert_eq!(fake.last_fetch_body().as_deref(), Some(&bin[..]));
}

#[test]
fn response_over_slot_crosses_by_heap() {
    let (_fake, s) = server(|_| {
        frame(
            200,
            &[
                ("content-type", "application/octet-stream"),
                ("set-cookie", "a=1"),
                ("set-cookie", "b=2"),
            ],
            &vec![7u8; 1 << 20],
        )
    });
    let (status, h, body) = request_body(&s, "GET", URL, &[], Vec::<u8>::new());
    assert_eq!(status, 200);
    assert_eq!(body, vec![7u8; 1 << 20]);
    let cookies: Vec<&str> = h
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect();
    assert_eq!(cookies, ["a=1", "b=2"]);
    assert_eq!(hdr(&h, "content-length"), Some("1048576"));
}

#[test]
fn heap_reply_over_max_response_bytes_is_declined() {
    let (_fake, s) = server_resp_cap(
        |_| frame(200, &[("content-type", "text/plain")], &vec![b'x'; 300_000]),
        262_144,
    );
    let (status, h, body) = get(&s, URL, &[]);
    assert_eq!(
        (status, body.as_str()),
        (500, "brust: action response exceeds 262144 bytes")
    );
    assert_eq!(hdr(&h, "content-type"), Some("text/plain; charset=utf-8"));
}

#[test]
fn heap_meta_without_reply_is_500() {
    let (_fake, s) = server(|_| {
        let meta = br#"{"status":200,"heap":10}"#;
        let mut f = (meta.len() as u32).to_le_bytes().to_vec();
        f.extend_from_slice(meta);
        f
    });
    let (status, _, body) = get(&s, URL, &[]);
    assert_eq!((status, body.as_str()), (500, "500 Internal Server Error"));
}

#[test]
fn put_fetch_reply_declines_outside_a_fetch_call() {
    let (fake, s) = server(ok);
    let id = fake.worker_id();
    // Idle slot (no call in flight), then an unknown worker.
    assert!(!brust_server::put_fetch_reply(&s, id, 0, b"x"));
    assert!(!brust_server::put_fetch_reply(&s, id + 99, 0, b"x"));
    assert_eq!(brust_server::take_fetch_body(&s, id, 0), None);
    assert_eq!(brust_server::take_fetch_body(&s, id + 99, 0), None);
}

// ---- L16: base URL / credentials injection, actions-only, the root prefix ----

fn boot_client(
    client: brust_server::ActionsClient,
    actions: Option<ActionsConfig>,
) -> Arc<brust_server::Server> {
    let fake = fake().with_fetch(echo);
    let mut cfg = config(&fx());
    cfg.actions = actions;
    cfg.actions_client = Some(client);
    let s = start(cfg).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
    s
}

#[test]
fn base_url_and_credentials_are_injected_after_the_prefix_script() {
    let s = boot_client(
        brust_server::ActionsClient {
            prefix: Some("/api".into()),
            base_url: Some("https://api.example.com".into()),
            credentials: brust_server::ActionCredentials::Include,
        },
        Some(ActionsConfig {
            prefix: "/api".into(),
            ..ActionsConfig::default()
        }),
    );
    let (status, _, b) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(status, 200, "{b}");
    let want = format!(
        "{PREFIX_TAG}<script>globalThis.__BRUST_ACTION_BASE__=\"https://api.example.com\";globalThis.__BRUST_ACTION_CREDENTIALS__=\"include\"</script><script type=\"module\" src=\"/_brust/client/runtime-"
    );
    assert!(b.contains(&want), "{b}");
}

#[test]
fn a_page_only_build_injects_the_remote_base_without_a_local_app() {
    let s = boot_client(
        brust_server::ActionsClient {
            base_url: Some("http://127.0.0.1:9".into()),
            ..Default::default()
        },
        None,
    );
    let (status, _, b) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(status, 200, "{b}");
    assert!(
        b.contains("<script>globalThis.__BRUST_ACTION_BASE__=\"http://127.0.0.1:9\"</script>"),
        "{b}"
    );
    assert!(
        !b.contains("__BRUST_ACTION_PREFIX__") && !b.contains("__BRUST_ACTION_CREDENTIALS__"),
        "{b}"
    );
    // No local app: the prefix is a page 404, never forwarded.
    let (status, _, _) = request_body(&s, "POST", "/_brust/action/x", &[], b"{}".to_vec());
    assert_eq!(status, 405);
}

#[test]
fn a_bad_base_url_is_refused_at_boot() {
    for bad in [
        "api.example.com",
        "ftp://x",
        "https://x/path",
        "https://x?q=1",
        "https://x#f",
        "https://u:p@x",
        "https://",
    ] {
        let mut cfg = config(&fx());
        cfg.actions_client = Some(brust_server::ActionsClient {
            base_url: Some(bad.into()),
            ..Default::default()
        });
        let e = start(cfg)
            .err()
            .unwrap_or_else(|| panic!("{bad} was accepted"));
        assert!(e.starts_with("actions: base_url"), "{bad}: {e}");
    }
}

fn actions_only_dist() -> tempfile::TempDir {
    temp_dist(|m| {
        m["routes"] = json!([]);
        m["actions_only"] = json!(true);
    })
}

#[test]
fn actions_only_answers_non_actions_with_a_404_problem() {
    let dist = actions_only_dist();
    let fake = fake().with_fetch(echo);
    let s = boot_actions(
        Arc::clone(&fake),
        dist.path(),
        ActionsConfig::default(),
        None,
    );
    for (method, path) in [
        ("GET", "/"),
        ("GET", "/pokemon/pikachu"),
        ("POST", "/anything"),
        ("GET", "/public/x.css"),
    ] {
        let (status, h, b) = request(&s, method, path, &[]);
        assert_eq!(status, 404, "{method} {path}");
        assert_eq!(
            hdr(&h, "content-type"),
            Some("application/problem+json"),
            "{path}"
        );
        assert!(b.contains("\"Not Found\""), "{b}");
    }
    let (status, _, _) = request(&s, "GET", "/ping", &[]);
    assert_eq!(status, 200);
    let (status, _, _) = request_body(&s, "POST", "/_brust/action/x", &[], b"{}".to_vec());
    assert_eq!(status, 200);
}

#[test]
fn the_root_prefix_is_only_for_actions_only_and_maps_the_path_as_is() {
    let root = ActionsConfig {
        prefix: "/".into(),
        ..ActionsConfig::default()
    };
    // a normal build refuses it
    let mut cfg = config(&fx());
    cfg.actions = Some(root.clone());
    let e = start(cfg).err().expect("refused");
    assert!(
        e.starts_with("actions: prefix \"/\" is only allowed in an actions-only build"),
        "{e}"
    );
    // an actions-only build serves it: /team reaches the app as /team
    let dist = actions_only_dist();
    let fake = fake().with_fetch(echo);
    let s = boot_actions(Arc::clone(&fake), dist.path(), root, None);
    let (status, _, _) = request_body(&s, "POST", "/team", &[], b"{}".to_vec());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["url"], "/team");
    let (status, _, _) = request_body(&s, "POST", "/a/b?x=1", &[], b"{}".to_vec());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["url"], "/a/b?x=1");
    // the server's own paths stay the server's
    let (status, _, b) = request(&s, "GET", "/ping", &[]);
    assert_eq!((status, b.as_str()), (200, "pong\n"));
    assert_eq!(fake.fetch_count(), 2);
}

// ----- F465: a cross-site HTML form POST answers the documented 403, whatever the body -----

/// Writes `req` on a fresh socket and reads to EOF or 1 s: the whole answer, head and body.
fn raw_all(s: &brust_server::Server, req: &[u8]) -> String {
    use std::io::{Read, Write};
    let mut tcp = std::net::TcpStream::connect(s.local_addr()).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    // The server may answer and close before a large body is written out: a write error is not a failure here.
    let _ = tcp.write_all(req);
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(n) = tcp.read(&mut chunk) {
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// What a browser sends for a cross-site form post: the cross-site `Origin` / `Sec-Fetch-*`, a form content
/// type, and `body` (`None`: no body headers at all).
fn form_post(extra: &str, content_type: &str, body: Option<&str>) -> Vec<u8> {
    // `connection: close` so the read ends with the answer instead of waiting out the timeout.
    let mut r = format!(
        "POST {ACTION} HTTP/1.1\r\nhost: fx\r\nconnection: close\r\n{extra}content-type: {content_type}\r\n"
    );
    match body {
        Some(b) => r.push_str(&format!("content-length: {}\r\n\r\n{b}", b.len())),
        None => r.push_str("\r\n"),
    }
    r.into_bytes()
}

#[test]
fn cross_site_form_posts_get_the_documented_403_for_every_shape() {
    let (fake, s) = server(note);
    let boundary = "----b";
    let multipart = format!(
        "--{boundary}\r\ncontent-disposition: form-data; name=\"text\"\r\n\r\nhi\r\n--{boundary}--\r\n"
    );
    let urlencoded = "text=hi";
    let ct_multi = format!("multipart/form-data; boundary={boundary}");
    let origin = format!("origin: {EVIL}\r\n");
    let fetch = "sec-fetch-site: cross-site\r\n";
    let both = format!(
        "origin: {EVIL}\r\nsec-fetch-site: cross-site\r\nsec-fetch-mode: navigate\r\nsec-fetch-dest: document\r\n"
    );
    let mut bad = vec![];
    for (name, extra) in [
        ("origin", origin.as_str()),
        ("fetch-site", fetch),
        ("browser", both.as_str()),
    ] {
        for (kind, ct, body) in [
            (
                "urlencoded",
                "application/x-www-form-urlencoded",
                Some(urlencoded),
            ),
            (
                "urlencoded-empty",
                "application/x-www-form-urlencoded",
                Some(""),
            ),
            (
                "urlencoded-nobody",
                "application/x-www-form-urlencoded",
                None,
            ),
            ("multipart", ct_multi.as_str(), Some(multipart.as_str())),
            ("multipart-nobody", ct_multi.as_str(), None),
            ("text-plain", "text/plain", Some("a=b")),
        ] {
            let got = raw_all(&s, &form_post(extra, ct, body));
            if !(got.starts_with("HTTP/1.1 403") && got.contains("CrossSiteRejected")) {
                bad.push(format!(
                    "{name}/{kind}: {}",
                    got.lines().next().unwrap_or("")
                ));
            }
        }
    }
    assert!(bad.is_empty(), "not the documented 403: {bad:#?}");
    assert_eq!(fake.fetch_count(), 0);
}

#[test]
fn cross_site_posts_get_the_403_whatever_the_framing() {
    let (fake, s) = server(note);
    let head = format!(
        "POST {ACTION} HTTP/1.1\r\nhost: fx\r\nconnection: close\r\nsec-fetch-site: cross-site\r\ncontent-type: application/x-www-form-urlencoded\r\n"
    );
    let big = format!("a={}", "x".repeat(300_000));
    let shapes = [
        (
            "chunked",
            format!("{head}transfer-encoding: chunked\r\n\r\nd\r\npayload=a.b.c\r\n0\r\n\r\n"),
        ),
        (
            "expect-continue",
            format!("{head}expect: 100-continue\r\ncontent-length: 13\r\n\r\npayload=a.b.c"),
        ),
        (
            "body over the action cap",
            format!("{head}content-length: {}\r\n\r\n{big}", big.len()),
        ),
        ("no body, no length", format!("{head}\r\n")),
    ];
    let mut bad = vec![];
    for (name, req) in &shapes {
        let got = raw_all(&s, req.as_bytes());
        if !(got.starts_with("HTTP/1.1 403") && got.contains("CrossSiteRejected")) {
            bad.push(format!("{name}: {}", got.lines().next().unwrap_or("")));
        }
    }
    assert!(bad.is_empty(), "not the documented 403: {bad:#?}");
    assert_eq!(fake.fetch_count(), 0);
}

// ---- F475: streamed bodies of `[actions] stream` routes ----

/// A server whose `POST /team` streams, bounded by `max_bytes` / `idle_ms`.
fn stream_server(max_bytes: u64, idle_ms: u64) -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    stream_server_with(fake().with_fetch(ok), max_bytes, idle_ms)
}

fn stream_server_with(
    fake: Arc<FakeBun>,
    max_bytes: u64,
    idle_ms: u64,
) -> (Arc<FakeBun>, Arc<brust_server::Server>) {
    let s = boot_actions(
        Arc::clone(&fake),
        &fx(),
        ActionsConfig {
            max_body_bytes: 1024,
            stream: StreamConfig {
                routes: vec![StreamRoute::parse("POST /team").unwrap()],
                max_bytes,
                idle_ms,
                ..StreamConfig::default()
            },
            ..ActionsConfig::default()
        },
        None,
    );
    (fake, s)
}

#[test]
fn streamed_body_reaches_the_app_byte_exact_past_max_body_bytes() {
    let (fake, s) = stream_server(1 << 20, 30_000);
    let chunks: Vec<Vec<u8>> = (0..300).map(|i| vec![(i % 251) as u8; 1024]).collect();
    let (status, h, body) = request_chunked(&s, "POST", URL, &[], chunks.clone());
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    assert_eq!(fake.last_fetch_body(), Some(chunks.concat()));
    // Read to its end: the connection stays open for the next request.
    assert_eq!(hdr(&h, "connection"), None);
    let a1 = last(&fake);
    assert!(a1["body"]["stream"]["length"].is_null(), "{a1}");
    assert!(a1["body"]["stream"]["token"].is_u64(), "{a1}");
    // F474 on the streamed path too: a chunked request has no Content-Length, and none is invented.
    let pairs: Vec<(String, String)> = serde_json::from_value(a1["headers"].clone()).unwrap();
    for f in ["transfer-encoding", "content-length", "connection"] {
        assert!(pairs.iter().all(|(k, _)| k != f), "{f} crossed: {pairs:?}");
    }
    // A declared length is carried and met.
    let want = vec![7u8; 600_000];
    let (status, _, _) = request_body(&s, "POST", URL, &[], want.clone());
    assert_eq!(status, 200);
    assert_eq!(last(&fake)["body"]["stream"]["length"], 600_000);
    // ... and the client's own Content-Length crosses.
    let pairs: Vec<(String, String)> =
        serde_json::from_value(last(&fake)["headers"].clone()).unwrap();
    assert!(
        pairs.contains(&("content-length".into(), "600000".into())),
        "{pairs:?}"
    );
    assert_eq!(fake.last_fetch_body(), Some(want));
}

#[test]
fn streamed_declared_length_over_the_ceiling_is_413_before_any_call() {
    let (fake, s) = stream_server(4096, 30_000);
    let (status, h, body) = request_body(&s, "POST", URL, &[], vec![b'a'; 4097]);
    assert_eq!((status, body.as_slice()), (413, &b"payload too large"[..]));
    assert_eq!(hdr(&h, "connection"), Some("close"));
    assert_eq!(fake.fetch_count(), 0);
    let (status, _, _) = request_body(&s, "POST", URL, &[], vec![b'a'; 4096]);
    assert_eq!(status, 200);
}

#[test]
fn streamed_body_past_the_ceiling_mid_stream_replaces_the_answer_with_413() {
    let (fake, s) = stream_server(4096, 30_000);
    let (status, h, body) = request_chunked(&s, "POST", URL, &[], vec![vec![b'a'; 1024]; 8]);
    assert_eq!((status, body.as_slice()), (413, &b"payload too large"[..]));
    assert_eq!(hdr(&h, "connection"), Some("close"));
    // The app was called and saw at most the ceiling.
    assert_eq!(fake.fetch_count(), 1);
    assert!(fake.last_fetch_body().unwrap().len() <= 4096);
}

#[test]
fn unlisted_route_and_method_stay_buffered_under_max_body_bytes() {
    let (fake, s) = stream_server(1 << 20, 30_000);
    for (m, url) in [("POST", "/_brust/action/other"), ("PUT", URL)] {
        let (status, _, _) = request_body(&s, m, url, &[], vec![b'a'; 1025]);
        assert_eq!(status, 413, "{m} {url}");
        let (status, _, _) = request_body(&s, m, url, &[], b"{}".to_vec());
        assert_eq!(status, 200, "{m} {url}");
        assert_eq!(last(&fake)["body"], json!({"text": "{}"}), "{m} {url}");
    }
}

#[test]
fn stalled_stream_is_408_and_a_stream_over_max_streams_is_503() {
    // One slot → max_streams defaults to 1.
    let (fake, s) = stream_server(1 << 20, 300);
    let s2 = Arc::clone(&s);
    let stalled = std::thread::spawn(move || request_open_body(&s2, "POST", URL, &[]));
    let t0 = Instant::now();
    while fake.fetch_count() == 0 {
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "the stalled stream never reached the app"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let (status, h, _) = request_body(&s, "POST", URL, &[], b"late".to_vec());
    assert_eq!(status, 503);
    assert_eq!(hdr(&h, "retry-after"), Some("1"));
    assert_eq!(
        fake.fetch_count(),
        1,
        "a refused stream never calls the app"
    );
    let (status, h, body) = stalled.join().unwrap();
    assert_eq!((status, body.as_slice()), (408, &b"request timeout"[..]));
    assert_eq!(hdr(&h, "connection"), Some("close"));
    assert_eq!(fake.last_fetch_body(), Some(b"x".to_vec()));
    // The admission was released with the stream.
    let (status, _, _) = request_body(&s, "POST", URL, &[], b"after".to_vec());
    assert_eq!(status, 200);
}

/// B1 (F127 on the streamed paths): every answer that leaves a streamed body unread reads it out (bounded) after
/// the answer, so a client still writing a body larger than the socket buffers reads the answer, not a reset.
fn assert_survives(r: Raw, status: &str, attempt: usize) -> String {
    assert_eq!(
        r.write_err, None,
        "attempt {attempt}: the client's write failed (the server closed first)"
    );
    let resp = r
        .response
        .unwrap_or_else(|k| panic!("attempt {attempt}: reading the answer failed: {k:?}"));
    assert!(
        resp.starts_with(&format!("HTTP/1.1 {status}")),
        "attempt {attempt}: {resp:?}"
    );
    resp.to_ascii_lowercase()
}

#[test]
fn streamed_declared_length_over_the_ceiling_is_read_out_so_the_413_survives() {
    let (fake, s) = stream_server(1024, 30_000);
    for attempt in 0..50 {
        let r = raw_exchange(
            &s,
            &format!(
                "POST {URL} HTTP/1.1\r\nhost: fx\r\ncontent-length: {}\r\n\r\n",
                300 * 1024
            ),
            &[vec![b'a'; 300 * 1024]],
            None,
        );
        let resp = assert_survives(r, "413", attempt);
        assert!(resp.contains("connection: close"), "{resp}");
    }
    assert_eq!(fake.fetch_count(), 0);
}

fn unauthorized(_: Value) -> Vec<u8> {
    frame(401, &[("content-type", "text/plain")], b"no")
}

#[test]
fn an_app_answering_without_reading_the_stream_is_read_out_so_its_answer_survives() {
    let (fake, s) = stream_server_with(
        fake().with_fetch(unauthorized).reading_at_most(0),
        1 << 20,
        30_000,
    );
    for attempt in 0..50 {
        let body: Vec<Vec<u8>> = (0..300).map(|_| chunk(1024)).collect();
        let r = raw_exchange(
            &s,
            &format!("POST {URL} HTTP/1.1\r\nhost: fx\r\ntransfer-encoding: chunked\r\n\r\n"),
            &body,
            Some(b"0\r\n\r\n"),
        );
        let resp = assert_survives(r, "401", attempt);
        assert!(resp.contains("connection: close"), "{resp}");
    }
    assert_eq!(fake.fetch_count(), 50);
    // A body that never ends: the answer does not wait for it.
    let r = raw_exchange(
        &s,
        &format!("POST {URL} HTTP/1.1\r\nhost: fx\r\ntransfer-encoding: chunked\r\n\r\n"),
        &[chunk(10)],
        None,
    );
    let resp = assert_survives(r, "401", 0);
    assert!(resp.contains("connection: close"), "{resp}");
}

#[test]
fn a_stream_over_max_streams_is_read_out_so_the_503_survives() {
    // One slot → max_streams defaults to 1; a first stream left open holds it.
    use std::io::{Read, Write};
    let (fake, s) = stream_server(1 << 20, 30_000);
    let mut held = std::net::TcpStream::connect(s.local_addr()).unwrap();
    held.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    held.write_all(
        format!("POST {URL} HTTP/1.1\r\nhost: fx\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n1\r\nx\r\n")
            .as_bytes(),
    )
    .unwrap();
    let t0 = Instant::now();
    while fake.fetch_count() == 0 {
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "the held stream never reached the app"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    for attempt in 0..20 {
        let body: Vec<Vec<u8>> = (0..300).map(|_| chunk(1024)).collect();
        let r = raw_exchange(
            &s,
            &format!("POST {URL} HTTP/1.1\r\nhost: fx\r\ntransfer-encoding: chunked\r\n\r\n"),
            &body,
            Some(b"0\r\n\r\n"),
        );
        let resp = assert_survives(r, "503", attempt);
        assert!(resp.contains("retry-after: 1"), "{resp}");
        assert!(resp.contains("connection: close"), "{resp}");
    }
    assert_eq!(fake.fetch_count(), 1);
    // The held stream ends and is answered.
    held.write_all(b"0\r\n\r\n").unwrap();
    let mut got = String::new();
    let _ = held.read_to_string(&mut got);
    assert!(got.starts_with("HTTP/1.1 200"), "{got:?}");
}
