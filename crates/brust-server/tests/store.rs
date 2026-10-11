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
