//! L24: a route with a non-ASCII literal segment answers when the browser sends it percent-encoded, in either
//! hex case, and its L1 entry is one entry however the URL is spelled; `invalidate({ path })` with the Thai
//! spelling removes it.
mod common;

use std::io::{Read, Write};

use brust_server::InvalidateArgs;
use common::*;
use serde_json::json;

const NEWS: &str = "/ข่าว";
const NEWS_ENC: &str = "/%E0%B8%82%E0%B9%88%E0%B8%B2%E0%B8%A7";

fn thai_dist() -> tempfile::TempDir {
    temp_dist(|m| {
        m["routes"].as_array_mut().unwrap().insert(
            0,
            json!({ "id": "r7", "pattern": NEWS, "chain": ["appLayout_a1", "homePage_b2"], "loaders": [],
                    "cache": { "ttl_seconds": 60, "prefix": null, "bypass": null, "tags": [] }, "catch_all": false }),
        );
    })
}

/// A request with the target written verbatim (hyper's client refuses a raw UTF-8 target).
fn raw_get(s: &brust_server::Server, target: &[u8]) -> (u16, String) {
    let mut c = std::net::TcpStream::connect(s.local_addr()).unwrap();
    let mut req = b"GET ".to_vec();
    req.extend_from_slice(target);
    req.extend_from_slice(b" HTTP/1.1\r\nHost: fx\r\nConnection: close\r\n\r\n");
    c.write_all(&req).unwrap();
    let mut out = Vec::new();
    c.read_to_end(&mut out).unwrap();
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let cache = text
        .lines()
        .find_map(|l| l.to_ascii_lowercase().strip_prefix("x-brust-cache:").map(|v| v.trim().to_uppercase()))
        .unwrap_or_default();
    (status, cache)
}

#[test]
fn a_thai_literal_route_answers_in_every_spelling_and_shares_one_l1_entry() {
    let d = thai_dist();
    let s = boot_in(fake(), d.path());
    // the browser's spelling
    let (st, h, body) = get(&s, NEWS_ENC, &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")), "{body}");
    // lowercase hex: the same entry
    let lower = NEWS_ENC.replace("%E0", "%e0").replace("%B8", "%b8").replace("%B2", "%b2");
    let (st, h, _) = get(&s, &lower, &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("HIT")));
    // raw UTF-8 on the wire (curl --path-as-is style): the same entry
    let (st, cache) = raw_get(&s, NEWS.as_bytes());
    assert_eq!((st, cache.as_str()), (200, "HIT"));
    // a neighbouring path still 404s through the catch-all
    assert_eq!(get(&s, "/%E0%B8%82", &[]).0, 404);
}

#[test]
fn invalidating_by_a_thai_path_removes_the_entry_in_either_spelling() {
    for spelling in [NEWS, NEWS_ENC] {
        let d = thai_dist();
        let s = boot_in(fake(), d.path());
        assert_eq!(cache_hdr(&get(&s, NEWS_ENC, &[]).1), Some("MISS"));
        assert_eq!(cache_hdr(&get(&s, NEWS_ENC, &[]).1), Some("HIT"));
        let r = s.invalidate(InvalidateArgs { path: Some(spelling.into()), ..Default::default() });
        assert_eq!(r.l1_removed, 1, "{spelling}");
        assert_eq!(cache_hdr(&get(&s, NEWS_ENC, &[]).1), Some("MISS"), "{spelling}");
    }
}
