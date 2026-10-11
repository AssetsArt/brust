//! M3-P P7 (ruling R1): the plan offer is adaptive per route. After 64 consecutive planned calls
//! whose jobs all hit, a route stops offering (`plan` is omitted) and plans on tokio; the first
//! tokio-side miss turns the offer back on. A page's bytes never depend on the state.
mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use brust_server::{InvalidateArgs, Server};
use common::fake_bun::FakeBun;
use common::*;
use serde_json::{Value, json};

const OFFER_STOP: usize = 64;

fn worker_calls(s: &Server) -> u64 {
    stats(s)["worker_calls"].as_u64().unwrap()
}

fn offered(f: &FakeBun) -> bool {
    f.last_loader().unwrap().get("plan") == Some(&json!(true))
}

/// One page; returns (status, body, worker round trips it took, whether its loader call was offered the plan).
fn page(s: &Server, f: &FakeBun, path: &str) -> (u16, String, u64, bool) {
    let before = worker_calls(s);
    let (st, h, body) = get(s, path, &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"), "{path}");
    (st, body, worker_calls(s) - before, offered(f))
}

/// The same page on a fresh server (every job a miss, planned): the reference bytes.
fn reference(path: &str) -> String {
    let s = boot(fake());
    let (st, _, body) = get(&s, path, &[]);
    assert_eq!(st, 200);
    body
}

#[test]
fn an_all_hit_route_stops_offering_after_64_planned_calls_and_a_miss_resumes_it() {
    let f = fake();
    let s = boot(f.clone());
    // 1st page: every job misses — planned, one round trip; the streak stays 0.
    assert_eq!(page(&s, &f, "/pokemon/p0").2, 1);
    assert!(offered(&f));
    // 64 all-hit planned pages: each still offered and one round trip.
    for i in 1..=OFFER_STOP {
        let (st, _, calls, plan) = page(&s, &f, &format!("/pokemon/p{i}"));
        assert_eq!((st, calls, plan), (200, 1, true), "page {i}");
    }
    // Now the route plans on tokio: no offer, still one round trip, same bytes.
    for i in OFFER_STOP + 1..OFFER_STOP + 4 {
        let path = format!("/pokemon/p{i}");
        let (st, body, calls, plan) = page(&s, &f, &path);
        assert_eq!((st, calls, plan), (200, 1, false), "page {i}");
        assert_eq!(body, reference(&path), "page {i}");
    }
    // A miss while not offering: today's declined path, two round trips; the offer resumes.
    s.invalidate(InvalidateArgs {
        tags: vec!["moves".into()],
        ..Default::default()
    });
    let path = "/pokemon/m1";
    let (st, body, calls, plan) = page(&s, &f, path);
    assert_eq!((st, calls, plan), (200, 2, false));
    assert_eq!(body, reference(path));
    let (st, _, calls, plan) = page(&s, &f, "/pokemon/m2");
    assert_eq!(
        (st, calls, plan),
        (200, 1, true),
        "offered again after the miss"
    );
    assert_eq!(s.plan_cells_in_use(), 0);
}

#[test]
fn a_miss_inside_a_planned_call_resets_the_streak() {
    let f = fake();
    let s = boot(f.clone());
    for i in 0..OFFER_STOP {
        page(&s, &f, &format!("/pokemon/a{i}"));
    }
    // 63 all-hit planned calls so far (the first page missed); one short of the stop.
    s.invalidate(InvalidateArgs {
        tags: vec!["moves".into()],
        ..Default::default()
    });
    let (_, _, calls, plan) = page(&s, &f, "/pokemon/miss");
    assert_eq!((calls, plan), (1, true), "a planned miss is still one call");
    for i in 0..OFFER_STOP {
        let (_, _, calls, plan) = page(&s, &f, &format!("/pokemon/b{i}"));
        assert_eq!(
            (calls, plan),
            (1, true),
            "streak restarted: page {i} still offered"
        );
    }
    let (_, _, calls, plan) = page(&s, &f, "/pokemon/c0");
    assert_eq!((calls, plan), (1, false));
}

#[test]
fn an_always_miss_route_never_stops_offering() {
    // Every page carries new loader data, so the detail job's inputs (and key) change: a miss.
    let n = Arc::new(AtomicU64::new(0));
    let f = FakeBun::new(
        move |req: Value| {
            let hp = n.fetch_add(1, Ordering::SeqCst);
            json!({"ok": true, "data": {
                "pokemon": {
                    "name": req["params"]["name"],
                    "stats": {"hp": hp},
                    "moves": [{"name": "tackle"}]
                },
                "team": ["a"],
                "who": "anon"
            }})
        },
        default_jobs,
    );
    let s = boot(f.clone());
    for i in 0..OFFER_STOP + 8 {
        let (st, _, calls, plan) = page(&s, &f, &format!("/pokemon/x{i}"));
        assert_eq!((st, calls, plan), (200, 1, true), "page {i}");
    }
    assert_eq!(s.plan_cells_in_use(), 0);
}
