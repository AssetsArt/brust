//! HTTP hygiene (review round 2, fix 9): HEAD length, 405 `Allow`, `nosniff`,
//! no symlink escape from `dist/`, HTTP/1 header-read timeout.
mod common;

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use brust_server::{Tuning, start};
use common::*;

#[test]
fn head_page_carries_get_content_length() {
    let s = boot(fake());
    let (_, _, body) = get(&s, "/pokemon/pikachu", &[]);
    let (st, h, hb) = request(&s, "HEAD", "/pokemon/pikachu", &[]);
    assert_eq!((st, hb.as_str()), (200, ""));
    assert_eq!(
        h.get("content-length")
            .map(|v| v.to_str().unwrap().to_string()),
        Some(body.len().to_string())
    );
}

#[test]
fn method_not_allowed_lists_allow() {
    let s = boot(fake());
    let (st, h, _) = request(&s, "POST", "/", &[]);
    assert_eq!(st, 405);
    assert_eq!(h.get("allow").unwrap(), "GET, HEAD");
}

#[test]
fn static_responses_are_nosniff() {
    let s = boot(fake());
    for p in ["/public/app.css", "/_brust/client/runtime-8b1c.js"] {
        let (st, h, _) = get(&s, p, &[]);
        assert_eq!(st, 200, "{p}");
        assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff", "{p}");
    }
}

#[cfg(unix)]
#[test]
fn symlinks_do_not_escape_static_roots() {
    let d = temp_dist(|_| {});
    let p = d.path();
    std::fs::write(p.join("secret.txt"), "SECRET").unwrap();
    std::os::unix::fs::symlink(p.join("manifest.json"), p.join("public/link.json")).unwrap();
    std::os::unix::fs::symlink(p, p.join("public/root")).unwrap();
    std::os::unix::fs::symlink(p.join("manifest.json"), p.join("client/evil-1a2b3c.js")).unwrap();
    let s = boot_in(fake(), p);
    for path in [
        "/public/link.json",
        "/public/root/secret.txt",
        "/public/root/manifest.json",
        "/_brust/client/evil-1a2b3c.js",
    ] {
        let (st, _, b) = get(&s, path, &[]);
        assert_eq!(st, 404, "{path}: {b}");
    }
    assert_eq!(get(&s, "/public/app.css", &[]).0, 200);
}

#[test]
fn partial_request_headers_time_out() {
    let mut cfg = config(&fx());
    cfg.tuning = Tuning {
        header_read_timeout_ms: 300,
        ..cfg.tuning
    };
    let s = start(cfg).expect("start");
    s.register_worker(Box::new(FakeBunHandle(fake())));
    let mut t = std::net::TcpStream::connect(s.local_addr()).unwrap();
    t.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    t.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n").unwrap();
    let t0 = Instant::now();
    let mut out = Vec::new();
    let r = t.read_to_end(&mut out);
    assert!(r.is_ok(), "connection not closed: {r:?}");
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
}
