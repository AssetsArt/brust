//! M3-P P4 (plan m3p-c-l1-shard): the request envelope is built after the L1 decision and the L1 read
//! front serves HITs. The loader request a MISS/BYPASS sends must not change by one byte.
mod common;
use brust_server::Server;
use common::*;
use serde_json::json;

/// MISS: params decoded, cookies across two Cookie headers, an encoded query (`%41`, `+`), header order.
#[test]
fn loader_request_is_unchanged_by_the_lazy_envelope() {
    let f = fake();
    let s = boot(f.clone());
    let (st, h, _) = get(
        &s,
        "/pokemon/pika%63hu?b=2&a=%41+x",
        &[("cookie", "s=1; t=2"), ("cookie", "u=3"), ("x-a", "1")],
    );
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    let l = f.last_loader().expect("loader called");
    assert_eq!(l["params"], json!({ "name": "pikachu" }));
    assert_eq!(l["path"], json!("/pokemon/pika%63hu"));
    assert_eq!(
        l["req"],
        json!({
            "cookies": { "s": "1", "t": "2", "u": "3" },
            "headers": { "cookie": "u=3", "host": "fx", "x-a": "1" },
            "method": "GET",
            "search": { "a": "A x", "b": "2" },
            "url": "/pokemon/pika%63hu?b=2&a=%41+x"
        })
    );
    // BYPASS (cookie(session) on /tenant) carries the same envelope shape.
    let (_, h, _) = get(
        &s,
        "/tenant?q=%2F",
        &[("cookie", "session=1"), ("x-tenant", "acme")],
    );
    assert_eq!(cache_hdr(&h), Some("BYPASS"));
    let l = f.last_loader().unwrap();
    assert_eq!(l["params"], json!({}));
    assert_eq!(l["path"], json!("/tenant"));
    assert_eq!(
        l["req"],
        json!({
            "cookies": { "session": "1" },
            "headers": { "cookie": "session=1", "host": "fx", "x-tenant": "acme" },
            "method": "GET",
            "search": { "q": "/" },
            "url": "/tenant?q=%2F"
        })
    );
}

/// One keep-alive connection (`common::get` opens one per request; this test sends thousands, which
/// would exhaust the ephemeral ports in TIME_WAIT).
struct Conn {
    rt: tokio::runtime::Runtime,
    sender: hyper::client::conn::http1::SendRequest<http_body_util::Empty<bytes::Bytes>>,
}

impl Conn {
    fn open(s: &Server) -> Self {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let sender = rt.block_on(async {
            let tcp = tokio::net::TcpStream::connect(s.local_addr())
                .await
                .unwrap();
            let (sender, conn) =
                hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp))
                    .await
                    .unwrap();
            tokio::spawn(conn);
            sender
        });
        Self { rt, sender }
    }

    /// (status, `x-brust-cache`) of `GET path`; the body is drained so the connection is reusable.
    fn get(&mut self, path: &str) -> (u16, Option<String>) {
        let req = http::Request::builder()
            .uri(path)
            .header("host", "fx")
            .body(http_body_util::Empty::<bytes::Bytes>::new())
            .unwrap();
        let sender = &mut self.sender;
        self.rt.block_on(async {
            let resp = sender.send_request(req).await.unwrap();
            let (parts, body) = resp.into_parts();
            http_body_util::BodyExt::collect(body).await.unwrap();
            (
                parts.status.as_u16(),
                cache_hdr(&parts.headers).map(str::to_owned),
            )
        })
    }
}

/// Invalidation reaches the read front before `invalidate` returns, while readers hammer a hot key.
#[test]
fn invalidation_under_concurrent_hits_is_immediate() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let s = boot(fake());
    let stop = AtomicBool::new(false);
    std::thread::scope(|sc| {
        for _ in 0..4 {
            sc.spawn(|| {
                let mut c = Conn::open(&s);
                while !stop.load(Ordering::Relaxed) {
                    assert_eq!(c.get("/pokemon/pikachu").0, 200);
                }
            });
        }
        let tags = || {
            s.invalidate(brust_server::InvalidateArgs {
                tags: vec!["pokemon".into()],
                ..Default::default()
            })
        };
        let path = || {
            s.invalidate(brust_server::InvalidateArgs {
                path: Some("/pokemon/pikachu".into()),
                ..Default::default()
            })
        };
        let mut c = Conn::open(&s);
        let mut fresh = || {
            let (st, h) = c.get("/pokemon/pikachu?fresh=1");
            assert_eq!(st, 200);
            h
        };
        for round in 0..200 {
            // The fresh key was dropped at the end of the last round, so only the readers' key can be here.
            assert!(tags().l1_removed <= 1, "round {round}");
            assert_eq!(fresh().as_deref(), Some("MISS"), "round {round}");
            assert_eq!(fresh().as_deref(), Some("HIT"), "round {round}");
            path(); // both keys: the key path excludes the query
            assert_eq!(fresh().as_deref(), Some("MISS"), "round {round}");
            path();
        }
        stop.store(true, Ordering::Relaxed);
    });
}
