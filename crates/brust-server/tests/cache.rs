//! L1 HIT serves the cached rendered body (spec S10 amendment, plan m2p
//! Task 2): byte-equal to a fresh render, one entry answers identity and gzip
//! clients, invalidation drops the body with the entry, HEAD on a HIT.
mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use brust_server::InvalidateArgs;
use common::*;
use serde_json::{Value, json};

/// Big enough to be gzipped under any page policy (Task 3: >= 16 KiB).
const PAD: usize = 24 * 1024;

/// A loader whose `who` changes on every call (`v1`, `v2`, …).
fn counting_fake() -> Arc<FakeBun> {
    let n = Arc::new(AtomicU32::new(0));
    FakeBun::new(
        move |_| {
            let i = n.fetch_add(1, Ordering::SeqCst) + 1;
            json!({"ok": true, "data": {"who": format!("v{i}")}})
        },
        |_: Value| json!({"results": []}),
    )
}

fn content_length(h: &http::HeaderMap) -> usize {
    hdr(h, "content-length")
        .expect("content-length")
        .parse()
        .unwrap()
}

#[test]
fn hit_serves_the_cached_body_byte_equal_to_a_fresh_render() {
    let dist = sized_dist(PAD);
    let s = boot_in(fake(), dist.path());
    for ae in ["identity", "gzip"] {
        let (_, _, first) = request_raw(&s, "GET", "/sized", &[("accept-encoding", ae)]);
        let (st, h2, hit) = request_raw(&s, "GET", "/sized", &[("accept-encoding", ae)]);
        assert_eq!(st, 200);
        assert_eq!(cache_hdr(&h2), Some("HIT"), "{ae}");
        assert_eq!(first, hit, "{ae}: every request serves the same bytes");
    }
    assert_eq!(stats(&s)["l1"]["hits"], 3);
    assert_eq!(stats(&s)["loader_calls"], 1);

    // A second server, same dist, nothing cached: its fresh render is the
    // cached body byte for byte (useId included).
    let fresh_s = boot_in(fake(), dist.path());
    let (_, h, fresh) = request_raw(
        &fresh_s,
        "GET",
        "/sized",
        &[("accept-encoding", "identity")],
    );
    assert_eq!(cache_hdr(&h), Some("MISS"));
    let (_, h, cached) = request_raw(&s, "GET", "/sized", &[("accept-encoding", "identity")]);
    assert_eq!(cache_hdr(&h), Some("HIT"));
    assert_eq!(cached, fresh);
    let text = String::from_utf8(cached).unwrap();
    assert!(
        text.contains(r#"<main id="brust-r9-sizedPage_z1-1"><h1>anon</h1>"#),
        "{text}"
    );
    assert!(text.len() > PAD, "{}", text.len());
}

#[test]
fn hit_answers_identity_and_gzip_from_one_entry() {
    let dist = sized_dist(PAD);
    let f = fake();
    let s = boot_in(f.clone(), dist.path());
    let (_, h0, miss) = request_raw(&s, "GET", "/sized", &[("accept-encoding", "identity")]);
    assert_eq!(cache_hdr(&h0), Some("MISS"));
    let mut identity_bodies = vec![miss];
    for ae in ["identity", "gzip", "identity", "gzip"] {
        let (st, h, body) = request_raw(&s, "GET", "/sized", &[("accept-encoding", ae)]);
        assert_eq!(st, 200);
        assert_eq!(cache_hdr(&h), Some("HIT"), "{ae}");
        assert_eq!(hdr(&h, "vary"), Some("Accept-Encoding"), "{ae}");
        assert_eq!(content_length(&h), body.len(), "{ae}");
        assert_eq!(hdr(&h, "content-type"), Some("text/html; charset=utf-8"));
        if ae == "gzip" {
            assert_eq!(hdr(&h, "content-encoding"), Some("gzip"));
            assert!(body.len() < identity_bodies[0].len());
            identity_bodies.push(gunzip(&body));
        } else {
            assert_eq!(hdr(&h, "content-encoding"), None);
            identity_bodies.push(body);
        }
    }
    assert!(identity_bodies.windows(2).all(|w| w[0] == w[1]));
    assert_eq!(stats(&s)["l1"]["len"], 1);
    assert_eq!(f.counts(), (1, 0));
}

#[test]
fn invalidate_tags_drops_the_body_with_the_entry() {
    let dist = sized_dist(PAD);
    let f = counting_fake();
    let s = boot_in(f.clone(), dist.path());
    for ae in ["identity", "gzip"] {
        let (_, h, _) = request_raw(&s, "GET", "/sized", &[("accept-encoding", ae)]);
        assert_eq!(
            cache_hdr(&h),
            Some(if ae == "identity" { "MISS" } else { "HIT" })
        );
    }
    let r = s.invalidate(InvalidateArgs {
        tags: vec!["sized".into()],
        ..Default::default()
    });
    assert_eq!(r.l1_removed, 1);
    for ae in ["gzip", "identity"] {
        let (_, h, body) = request_raw(&s, "GET", "/sized", &[("accept-encoding", ae)]);
        let text = if ae == "gzip" { gunzip(&body) } else { body };
        let text = String::from_utf8(text).unwrap();
        assert!(text.contains("<h1>v2</h1>"), "{ae}: stale body served");
        assert_eq!(
            cache_hdr(&h),
            Some(if ae == "gzip" { "MISS" } else { "HIT" })
        );
    }
    assert_eq!(f.counts().0, 2, "the MISS re-ran the loader");
}

#[test]
fn head_on_a_hit_carries_the_get_headers_and_no_body() {
    let dist = sized_dist(PAD);
    let f = fake();
    let s = boot_in(f.clone(), dist.path());
    for ae in ["gzip", "identity"] {
        let (_, _, get_body) = request_raw(&s, "GET", "/sized", &[("accept-encoding", ae)]);
        let (st, h, body) = request_raw(&s, "HEAD", "/sized", &[("accept-encoding", ae)]);
        assert_eq!(st, 200);
        assert_eq!(cache_hdr(&h), Some("HIT"), "{ae}");
        assert!(body.is_empty());
        assert_eq!(content_length(&h), get_body.len(), "{ae}");
        assert_eq!(hdr(&h, "vary"), Some("Accept-Encoding"), "{ae}");
        assert_eq!(
            hdr(&h, "content-encoding"),
            (ae == "gzip").then_some("gzip"),
            "{ae}"
        );
    }
    assert_eq!(f.counts(), (1, 0));
}
