//! M3-P P4 (plan m3p-c-l1-shard): the request envelope is built after the L1 decision and the L1 read
//! front serves HITs. The loader request a MISS/BYPASS sends must not change by one byte.
mod common;
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
