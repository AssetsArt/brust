//! M3-F E3/E4: the actions subtree — one `fetch` worker call per request under the prefix, before
//! the method gate; the body cap, the body encoding (R2), the response rules (R9), stats (R11).
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use brust_server::{ActionsConfig, CrossSite, start};
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
    let (status, _, body) = request_body(&s, "POST", URL, &[], vec![b'a'; 1025]);
    assert_eq!((status, body.as_slice()), (413, &b"payload too large"[..]));
    let (status, _, _) = request_body(&s, "POST", URL, &[], vec![b'a'; 1024]);
    assert_eq!(status, 200);
    assert_eq!(fake.fetch_count(), 1);
}

#[test]
fn chunked_body_over_cap_is_413() {
    let (fake, s) = server(ok);
    let (status, _, body) = request_chunked(&s, "POST", URL, &[], vec![vec![b'a'; 1024]; 300]);
    assert_eq!((status, body.as_slice()), (413, &b"payload too large"[..]));
    assert_eq!(fake.fetch_count(), 0);
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
fn headers_cross_as_pairs_minus_framing() {
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
    for f in ["content-length", "transfer-encoding", "connection"] {
        assert!(pairs.iter().all(|(k, _)| k != f), "{f} crossed: {pairs:?}");
    }
    assert!(pairs.contains(&("host".into(), "fx".into())), "{pairs:?}");
    assert!(!r["req"]["headers"]["x-dup"].is_null(), "{}", r["req"]);

    let (status, _, _) = request_chunked(&s, "POST", URL, &[], vec![b"{}".to_vec()]);
    assert_eq!(status, 200);
    let pairs: Vec<(String, String)> =
        serde_json::from_value(last(&fake)["headers"].clone()).unwrap();
    assert!(
        pairs.iter().all(|(k, _)| k != "transfer-encoding"),
        "{pairs:?}"
    );
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
