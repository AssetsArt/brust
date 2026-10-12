//! cache-adapter lane A, Task 4: the native L2 hooks over `CallKind::Cache` — read-through on an L1
//! MISS of a cacheable route, background write-through after an L1 insert, fail-open budgets, the
//! heap transfer of a large hit, and the floor raised by a replayed broadcast (ruling L7c).
mod common;
use std::sync::Arc;
use std::time::{Duration, Instant};

use brust_server::Server;
use common::*;
use serde_json::{Value, json};

fn l2_stats(s: &Server) -> Value {
    stats(s)["l2"].clone()
}

/// Poll `f` for up to 2 s.
fn wait_for(what: &str, f: impl Fn() -> bool) {
    let t0 = Instant::now();
    while !f() {
        assert!(t0.elapsed() < Duration::from_secs(2), "timed out: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn pair(
    l2: &Arc<FakeL2>,
    cfg: impl Fn() -> brust_core::l2::L2Config,
) -> (Arc<FakeBun>, Arc<Server>, Arc<FakeBun>, Arc<Server>) {
    let fa = fake().with_l2(Arc::clone(l2));
    let fb = fake().with_l2(Arc::clone(l2));
    let a = boot_l2(Arc::clone(&fa), &fx(), cfg());
    let b = boot_l2(Arc::clone(&fb), &fx(), cfg());
    (fa, a, fb, b)
}

#[test]
fn miss_then_hit_l2_on_a_second_server() {
    let l2 = FakeL2::new();
    let (_fa, a, fb, b) = pair(&l2, || l2_config(1000, 1 << 20));
    let (st, h, body_a) = get(&a, "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    wait_for("the set", || l2.ops().1 == 1 && l2.len() == 1);
    wait_for("sets counted", || l2_stats(&a)["sets"] == 1);
    let (st, h, body_b) = get(&b, "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("HIT-L2")));
    assert_eq!(body_b, body_a);
    assert_eq!(h.get("content-type").unwrap(), "text/html; charset=utf-8");
    assert_eq!(fb.counts(), (0, 0), "B ran no loader and no job");
    let (_, h, _) = get(&b, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("HIT"));
    let s = l2_stats(&b);
    assert_eq!(
        (s["hits"].clone(), s["adapter"].clone()),
        (json!(1), json!("custom"))
    );
    assert_eq!(stats(&b)["loader_calls"], 0);
}

#[test]
fn get_timeout_renders() {
    let l2 = FakeL2::new();
    let f = fake().with_l2(Arc::clone(&l2));
    let s = boot_l2(Arc::clone(&f), &fx(), l2_config(50, 1 << 20));
    l2.hang_next_get
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let t0 = Instant::now();
    let (st, h, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
    assert_eq!(l2_stats(&s)["timeouts"], 1);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        f.last_cache().unwrap()["op"],
        "get",
        "a timed-out lookup writes nothing"
    );
    assert_eq!(l2.ops().1, 0);
}

#[test]
fn stale_set_is_refused() {
    let l2 = FakeL2::new();
    let l2c = Arc::clone(&l2);
    // The invalidation lands during the render: after the get (stamp 0), before the set.
    let fa = FakeBun::new(
        move |req| {
            l2c.invalidate_tag("pokemon");
            default_loader(req)
        },
        default_jobs,
    )
    .with_l2(Arc::clone(&l2));
    let a = boot_l2(Arc::clone(&fa), &fx(), l2_config(1000, 1 << 20));
    let fb = fake().with_l2(Arc::clone(&l2));
    let b = boot_l2(fb, &fx(), l2_config(1000, 1 << 20));
    let (_, h, _) = get(&a, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    wait_for("set_refused", || l2_stats(&a)["set_refused"] == 1);
    assert_eq!(l2.len(), 0);
    let (_, h, _) = get(&b, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
}

#[test]
fn oversize_body_is_not_written() {
    let dist = sized_dist(4096);
    let l2 = FakeL2::new();
    let f = fake().with_l2(Arc::clone(&l2));
    let s = boot_l2(f, dist.path(), l2_config(1000, 1024));
    let (st, h, body) = get(&s, "/sized", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    assert!(body.len() > 1024);
    assert_eq!(l2_stats(&s)["set_oversize"], 1);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(l2.ops().1, 0);
}

#[test]
fn heap_reply_for_a_large_hit() {
    let l2 = FakeL2::new();
    let (fa, a, _fb, b) = pair(&l2, || l2_config(1000, 1 << 20));
    get(&a, "/pokemon/pikachu", &[]);
    wait_for("the set", || l2.len() == 1);
    let key = fa.last_cache().unwrap()["key"].as_str().unwrap().to_owned();
    let big: Vec<u8> = (0..300_000).map(|i| b'a' + (i % 26) as u8).collect();
    l2.put(
        &key,
        FakeEntry {
            status: 200,
            headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
            body: big.clone(),
            tags: vec!["pokemon".into()],
            entry_stamp: Some(0),
            stored_at: common::fake_bun::now_ms(),
        },
    );
    let (st, h, body) = request_raw(&b, "GET", "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("HIT-L2")));
    assert_eq!(body, big);
}

/// R6: an L2 entry past its ttl is a miss (and is written again).
#[test]
fn expired_l2_entry_is_a_miss() {
    let l2 = FakeL2::new();
    let (fa, a, _fb, b) = pair(&l2, || l2_config(1000, 1 << 20));
    get(&a, "/pokemon/pikachu", &[]);
    wait_for("the set", || l2.len() == 1);
    let key = fa.last_cache().unwrap()["key"].as_str().unwrap().to_owned();
    l2.state
        .lock()
        .unwrap()
        .map
        .get_mut(&key)
        .unwrap()
        .stored_at = 0;
    let (_, h, _) = get(&b, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    assert_eq!(l2_stats(&b)["misses"], 1);
    wait_for("written again", || l2_stats(&b)["sets"] == 1);
}

#[test]
fn bypass_and_uncached_routes_never_call_l2() {
    let l2 = FakeL2::new();
    let f = fake().with_l2(Arc::clone(&l2));
    let s = boot_l2(Arc::clone(&f), &fx(), l2_config(1000, 1 << 20));
    let (_, h, _) = get(&s, "/tenant", &[("cookie", "session=1"), ("x-tenant", "a")]);
    assert_eq!(cache_hdr(&h), Some("BYPASS"));
    let (st, _, _) = get(&s, "/", &[]);
    assert_eq!(st, 200);
    assert_eq!(f.cache_count(), 0);
}

#[test]
fn no_adapter_is_byte_identical() {
    let f = fake();
    let s = boot(Arc::clone(&f));
    let (_, h, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    let (_, h, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("HIT"));
    let (_, _, raw) = get(&s, "/_brust/cache/stats", &[]);
    assert!(!raw.contains("\"l2\""), "{raw}");
    assert_eq!(f.cache_count(), 0);
}

#[test]
fn failed_get_is_fail_open() {
    let l2 = FakeL2::new();
    let f = fake().with_l2(Arc::clone(&l2));
    let s = boot_l2(f, &fx(), l2_config(1000, 1 << 20));
    l2.fail_next
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (st, h, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    assert_eq!(l2_stats(&s)["errors"], 1);
}

/// L7c: a replayed invalidation raises the floor; an L2 body written before it is a miss here.
#[test]
fn replayed_invalidation_floors_an_older_l2_body() {
    let l2 = FakeL2::new();
    let (_fa, a, _fb, b) = pair(&l2, || l2_config(1000, 1 << 20));
    get(&a, "/pokemon/pikachu", &[]);
    wait_for("the set", || l2.len() == 1);
    // B learns of an invalidation (seq 1) of the tag whose store delete has not landed.
    b.l2_replay(
        serde_json::from_value(json!({"tags": ["pokemon"]})).unwrap(),
        Some(1),
    );
    let (st, h, _) = get(&b, "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    assert_eq!(l2_stats(&b)["rejected_floor"], 1);
}
