//! F506: one trailing-slash policy per app (`[server] trailing_slash`, baked into the manifest). `strict` (default) =
//! today; `redirect` = GET/HEAD answer 308 to the slashless path (query kept, base path kept), before matching and the
//! page cache; `ignore` = the slash is dropped before matching (one cache entry). brust's own paths and other methods are
//! untouched.
mod common;

use common::*;
use serde_json::json;

fn dist(mode: Option<&str>, base: Option<&str>) -> tempfile::TempDir {
    let (mode, base) = (mode.map(str::to_owned), base.map(str::to_owned));
    temp_dist(move |m| {
        if let Some(mode) = mode {
            m["trailing_slash"] = json!(mode);
        }
        let b = base.clone().unwrap_or_default();
        if !b.is_empty() {
            m["base_path"] = json!(b);
        }
        let routes = m["routes"].as_array_mut().unwrap();
        for r in routes.iter_mut() {
            let p = r["pattern"].as_str().unwrap().to_string();
            if p != "*" {
                r["pattern"] = json!(if p == "/" && !b.is_empty() {
                    b.clone()
                } else {
                    format!("{b}{p}")
                });
            }
        }
        routes.insert(
            0,
            json!({ "id": "rc", "pattern": format!("{b}/cart"), "chain": ["appLayout_a1", "homePage_b2"], "loaders": [],
                    "cache": { "ttl_seconds": 60, "prefix": null, "bypass": null, "tags": [] }, "catch_all": false }),
        );
        routes.insert(
            0,
            json!({ "id": "rd", "pattern": format!("{b}/docs/{{*rest}}"), "chain": ["appLayout_a1", "homePage_b2"], "loaders": [],
                    "cache": null, "catch_all": false }),
        );
    })
}

fn location(h: &http::HeaderMap) -> Option<&str> {
    hdr(h, "location")
}

#[test]
fn strict_is_todays_behaviour() {
    for mode in [None, Some("strict")] {
        let d = dist(mode, None);
        let s = boot_in(fake(), d.path());
        assert_eq!(get(&s, "/cart", &[]).0, 200);
        assert_eq!(get(&s, "/cart/", &[]).0, 404, "{mode:?}");
        // `/docs/a/` reaches the rest route with the slash in it (a second URL of the page).
        assert_eq!(get(&s, "/docs/a/", &[]).0, 200);
    }
}

#[test]
fn redirect_answers_308_to_the_slashless_path_with_the_query() {
    let d = dist(Some("redirect"), None);
    let s = boot_in(fake(), d.path());
    let (st, h, body) = get(&s, "/cart/?a=1&b=2", &[]);
    assert_eq!((st, location(&h)), (308, Some("/cart?a=1&b=2")), "{body}");
    assert!(cache_hdr(&h).is_none(), "answered before the page cache");
    let (st, h, _) = get(&s, "/docs/a/b//", &[]);
    assert_eq!((st, location(&h)), (308, Some("/docs/a/b")));
    let (st, h, body) = request(&s, "HEAD", "/cart/", &[]);
    assert_eq!((st, location(&h), body.as_str()), (308, Some("/cart"), ""));
    // The target answers.
    assert_eq!(get(&s, "/cart?a=1&b=2", &[]).0, 200);
    // `/` is the root, not a trailing slash; a percent-encoded slash is not one either.
    assert_eq!(get(&s, "/", &[]).0, 200);
    assert_ne!(get(&s, "/docs/a%2F", &[]).0, 308);
    // Never a protocol-relative Location (an open redirect): such a path is matched as written.
    for evil in ["//evil.example/", "//evil.example//", "/\\evil.example/"] {
        let (st, h, _) = get(&s, evil, &[]);
        assert_ne!(st, 308, "{evil}");
        assert!(location(&h).is_none(), "{evil}");
    }
    // Other methods are untouched (no 308 that would re-post).
    assert_eq!(request(&s, "POST", "/cart/", &[]).0, 405);
    // brust's own paths are untouched.
    assert_eq!(get(&s, "/ping", &[]).0, 200);
    assert_ne!(get(&s, "/ping/", &[]).0, 308);
    assert_ne!(get(&s, "/_brust/client/", &[]).0, 308);
    assert_ne!(get(&s, "/public/", &[]).0, 308);
}

#[test]
fn redirect_keeps_the_base_path() {
    let d = dist(Some("redirect"), Some("/portal"));
    let s = boot_in(fake(), d.path());
    let (st, h, _) = get(&s, "/portal/cart/", &[]);
    assert_eq!((st, location(&h)), (308, Some("/portal/cart")));
    let (st, h, _) = get(&s, "/portal/", &[]);
    assert_eq!((st, location(&h)), (308, Some("/portal")));
    assert_eq!(get(&s, "/portal", &[]).0, 200);
    assert_eq!(
        get(&s, "/cart/", &[]).0,
        404,
        "outside the base: another app's path"
    );
}

#[test]
fn ignore_matches_the_slashless_path_with_one_cache_entry() {
    let d = dist(Some("ignore"), None);
    let s = boot_in(fake(), d.path());
    let (st, h, _) = get(&s, "/cart", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    let (st, h, _) = get(&s, "/cart/", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("HIT")), "the same entry");
    let (st, h, _) = get(&s, "/cart//?x=1", &[]);
    assert_eq!(st, 200);
    assert!(location(&h).is_none());
    assert_eq!(stats(&s)["l1"]["len"], 2, "/cart and /cart?x=1");
    // The rest route no longer sees the slash.
    assert_eq!(get(&s, "/docs/a/", &[]).0, 200);
}
