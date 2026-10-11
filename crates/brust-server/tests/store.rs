//! M3-F S2: the loader's store snapshot becomes the reserved ctx key `__store`, on the declined
//! two-call path and on the planned one-call path alike.
mod common;

use std::path::Path;
use std::sync::Arc;

use brust_server::{Server, start};
use common::fake_bun::FakeBun;
use common::*;
use serde_json::{Value, json};

const MARK: &str = r#"<b id="c">{{ __store.cart.count | e }}</b>"#;

/// The fixture dist whose detail page also prints `__store.cart.count`.
fn store_dist() -> tempfile::TempDir {
    let dir = temp_dist(|_| {});
    let p = dir.path().join("jinja/detailPage_c3.jinja");
    let src = std::fs::read_to_string(&p).unwrap();
    assert!(src.contains("</main>"));
    std::fs::write(&p, src.replace("</main>", &format!("{MARK}</main>"))).unwrap();
    dir
}

/// `default_loader` plus a `store` snapshot.
fn with_store(snap: Value) -> impl Fn(Value) -> Value + Send + Sync + 'static {
    move |req| {
        let mut r = default_loader(req);
        r["store"] = snap.clone();
        r
    }
}

/// Booted WITHOUT `fake.bind`: the worker ignores the plan offer, so this is the declined
/// two-call path.
fn boot_unbound(fake: Arc<FakeBun>, dir: &Path) -> Arc<Server> {
    let s = start(config(dir)).expect("start");
    s.register_worker(Box::new(FakeBunHandle(fake)));
    s
}

fn counted(snap: Value) -> Arc<FakeBun> {
    FakeBun::new(with_store(snap), default_jobs)
}

#[test]
fn loader_store_renders_from_ctx() {
    let dir = store_dist();
    let s = boot_in(counted(json!({"cart": {"count": 3}})), dir.path());
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200);
    assert!(body.contains(r#"<b id="c">3</b>"#), "{body}");
}

#[test]
fn planned_and_declined_paths_render_the_same_bytes() {
    let dir = store_dist();
    let snap = json!({"cart": {"count": 3}});
    let bf = counted(snap.clone());
    let bound = boot_in(bf.clone(), dir.path());
    let uf = counted(snap);
    let unbound = boot_unbound(uf.clone(), dir.path());
    let (s1, _, b1) = get(&bound, "/pokemon/pikachu", &[]);
    let (s2, _, b2) = get(&unbound, "/pokemon/pikachu", &[]);
    assert_eq!((s1, s2), (200, 200));
    assert!(b1.contains(r#"<b id="c">3</b>"#), "{b1}");
    assert_eq!(b1, b2);
    assert!(bf.last_jobs().is_some());
    assert_eq!(bf.last_jobs(), uf.last_jobs());
}

#[test]
#[allow(non_snake_case)]
fn loader_key___store_is_dropped() {
    let dir = store_dist();
    let f = FakeBun::new(
        |req| {
            let mut r = default_loader(req);
            r["data"]["__store"] = json!({"cart": {"count": 9}});
            r
        },
        default_jobs,
    );
    let s = boot_in(f, dir.path());
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200);
    assert!(body.contains(r#"<b id="c"></b>"#), "{body}");
}

#[test]
fn not_found_verdict_carries_the_store() {
    let dir = store_dist();
    let f = FakeBun::new(
        |_| {
            json!({"verdict": "notFound",
                "data": {"pokemon": {"name": "x", "stats": {"hp": 1}, "moves": []}},
                "store": {"cart": {"count": 5}}})
        },
        default_jobs,
    );
    let s = boot_in(f, dir.path());
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 404);
    assert!(body.contains(r#"<b id="c">5</b>"#), "{body}");
}

/// `default_loader` whose store snapshot is read from `count` at each call.
fn with_counter(count: Arc<std::sync::atomic::AtomicU32>) -> impl Fn(Value) -> Value + Send + Sync {
    move |req| {
        let mut r = default_loader(req);
        let c = count.load(std::sync::atomic::Ordering::SeqCst);
        r["store"] = json!({"cart": {"count": c}});
        r
    }
}

#[test]
fn ssr_job_cache_follows_the_store() {
    use std::sync::atomic::{AtomicU32, Ordering};
    let count = Arc::new(AtomicU32::new(3));
    let dir = store_dist();
    let f = FakeBun::new(with_counter(count.clone()), default_jobs);
    let s = boot_in(f.clone(), dir.path());
    for n in [3, 3, 4] {
        count.store(n, Ordering::SeqCst);
        let (st, _, _) = get(&s, "/team", &[]);
        assert_eq!(st, 200);
    }
    assert_eq!(f.counts().1, 2, "3 miss, 3 hit, 4 miss");
    assert_eq!(
        f.last_jobs().unwrap()["jobs"][0]["inputs"]["__store"],
        json!({"cart": {"count": 4}})
    );
}

#[test]
fn precompute_inputs_never_carry_the_store() {
    let dir = store_dist();
    let f = counted(json!({"cart": {"count": 3}}));
    let s = boot_in(f.clone(), dir.path());
    let (st, _, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200);
    let jobs = f.last_jobs().expect("jobs were requested");
    let arr = jobs["jobs"].as_array().unwrap();
    assert!(!arr.is_empty());
    for call in arr {
        assert!(call["inputs"].get("__store").is_none(), "{call}");
    }
}

#[test]
fn island_props_hide_the_store() {
    let dir = temp_dist(|m| {
        m["routes"].as_array_mut().unwrap().push(json!({
            "id": "r7", "pattern": "/island",
            "chain": ["appLayout_a1", "teamBuilder_h8"],
            "loaders": ["r7"], "cache": null, "catch_all": false}));
    });
    let f = counted(json!({"cart": {"count": 3}}));
    let s = boot_in(f.clone(), dir.path());
    let (st, _, body) = get(&s, "/island", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(body.contains("x-props="), "{body}");
    assert!(!body.contains("__store"), "{body}");
    let jobs = f.last_jobs().expect("ssr job requested");
    let call = jobs["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["componentId"] == "teamBuilder_h8")
        .expect("teamBuilder_h8 call");
    assert_eq!(call["inputs"]["__store"], json!({"cart": {"count": 3}}));
}

const STORE_TAG: &str = "<script type=\"application/json\" data-brust-store=\"";
const RUNTIME_TAG: &str = "<script type=\"module\" src=\"/_brust/client/runtime-8b1c.js\">";

#[test]
fn store_tag_once_per_store_on_the_page() {
    let dir = store_dist();
    let s = boot_in(
        counted(json!({"cart": {"count": 3}, "user": {"name": "ash"}})),
        dir.path(),
    );
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200);
    for name in ["cart", "user"] {
        let tag = format!("{STORE_TAG}{name}\">");
        assert_eq!(body.matches(&tag).count(), 1, "{body}");
    }
    let i = body.find(STORE_TAG).expect("tag");
    let j = body.find(RUNTIME_TAG).expect("runtime");
    assert!(i < j, "{body}");
    let between = &body[i..j];
    assert!(between.ends_with("</script>"), "{between}");
    assert_eq!(between.matches(STORE_TAG).count(), 2, "{between}");
    assert!(!between.contains("src="), "{between}");
}

#[test]
fn l1_hit_serves_the_same_store_tag() {
    let dir = store_dist();
    let f = counted(json!({"cart": {"count": 3}}));
    let s = boot_in(f.clone(), dir.path());
    let (s1, h1, b1) = get(&s, "/pokemon/pikachu", &[]);
    let (s2, h2, b2) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!((s1, s2), (200, 200));
    assert_eq!(cache_hdr(&h1), Some("MISS"));
    assert_eq!(cache_hdr(&h2), Some("HIT"));
    assert!(b1.contains(&format!("{STORE_TAG}cart\">")), "{b1}");
    assert_eq!(b1, b2);
    assert_eq!(f.counts().0, 1);
}

#[test]
fn no_store_page_has_no_tag_and_same_bytes() {
    let dir = store_dist();
    let absent = boot_in(FakeBun::new(default_loader, default_jobs), dir.path());
    let nulled = boot_in(
        FakeBun::new(
            |req| {
                let mut r = default_loader(req);
                r["store"] = Value::Null;
                r
            },
            default_jobs,
        ),
        dir.path(),
    );
    let (s1, _, b1) = get(&absent, "/pokemon/pikachu", &[]);
    let (s2, _, b2) = get(&nulled, "/pokemon/pikachu", &[]);
    assert_eq!((s1, s2), (200, 200));
    assert_eq!(b1, b2);
    assert!(!b1.contains("data-brust-store"), "{b1}");
}

#[test]
fn request_derived_store_value_cannot_break_out() {
    let dir = store_dist();
    let f = FakeBun::new(
        |req| {
            let mut r = default_loader(req.clone());
            r["store"] = json!({"cart": {"name": req["params"]["name"]}});
            r
        },
        default_jobs,
    );
    let s = boot_in(f, dir.path());
    let (st, _, body) = get(&s, "/pokemon/%3C%2Fscript%3E", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(body.contains(r#"{"name":"\u003c/script\u003e"}"#), "{body}");
    let i = body.find(STORE_TAG).expect("tag");
    let tag_end = body[i..].find("</script>").unwrap();
    assert!(!body[i..i + tag_end].contains("</"), "{body}");
}

/// M3-F S7b: `/ll` has no loaders but its chain's component lists a store module.
fn loaderless_dist(with_stores: bool) -> tempfile::TempDir {
    let dir = store_dist();
    let mp = dir.path().join("manifest.json");
    let mut m: Value = serde_json::from_slice(&std::fs::read(&mp).unwrap()).unwrap();
    m["routes"].as_array_mut().unwrap().push(json!({
        "id": "r8", "pattern": "/ll", "chain": ["appLayout_a1", "detailPage_c3"],
        "loaders": [], "cache": null, "catch_all": false}));
    if with_stores {
        m["components"]["detailPage_c3"]["stores"] = json!(["stores/cart.ts"]);
    }
    std::fs::write(&mp, serde_json::to_vec(&m).unwrap()).unwrap();
    dir
}

#[test]
fn loaderless_route_with_a_chain_store_calls_the_worker_once() {
    for bound in [false, true] {
        let dir = loaderless_dist(true);
        let f = counted(json!({"cart": {"count": 3}}));
        let s = if bound {
            boot_in(f.clone(), dir.path())
        } else {
            boot_unbound(f.clone(), dir.path())
        };
        let (st, _, body) = get(&s, "/ll", &[]);
        assert_eq!(st, 200, "{body}");
        assert!(body.contains(r#"<b id="c">3</b>"#), "{body}");
        assert!(
            body.contains(r#"<script type="application/json" data-brust-store="cart">{"count":3}</script><script type="module" src="/_brust/client/runtime-"#),
            "{body}"
        );
        assert_eq!(f.counts().0, 1, "bound={bound}");
    }
}

#[test]
fn loaderless_route_without_stores_makes_zero_worker_calls() {
    let dir = loaderless_dist(false);
    let f = counted(json!({"cart": {"count": 3}}));
    let s = boot_in(f.clone(), dir.path());
    let (_, _, body) = get(&s, "/", &[]);
    assert!(!body.contains("data-brust-store"));
    assert_eq!(f.counts().0, 0);
}
