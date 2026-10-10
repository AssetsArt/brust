//! M3-P P6: one worker round trip per loader page (the planned loader call). The default
//! `fake()` is bound by `boot()` and takes the plan offer like the real worker; a fake that
//! is registered by hand and never bound ignores it (the two-call path).
mod common;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

use brust_server::{InvalidateArgs, Server, start};
use common::*;
use serde_json::{Value, json};

/// r2 MISS: loader + 3 job misses in ONE worker round trip.
#[test]
fn a_loader_page_with_job_misses_is_one_worker_call() {
    let f = fake();
    let s = boot(f.clone());
    let (st, h, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    assert!(
        body.contains("<p>HP 35</p>")
            && body.contains("<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>"),
        "{body}"
    );
    assert_eq!(f.counts(), (1, 1), "one loader run, one job batch");
    let st = stats(&s);
    assert_eq!(
        (
            st["loader_calls"].as_u64(),
            st["job_calls"].as_u64(),
            st["worker_calls"].as_u64()
        ),
        (Some(1), Some(1), Some(1))
    );
    assert_eq!(f.last_loader().unwrap()["plan"], true);
    assert_eq!(s.plan_cells_in_use(), 0);
}

/// An unbound fake: registered by hand, so it ignores the plan offer (the two-call path).
fn boot_declining(f: Arc<FakeBun>) -> Arc<Server> {
    let s = start(config(&fx())).unwrap();
    s.register_worker(Box::new(FakeBunHandle(f)));
    s
}

fn strip(h: &http::HeaderMap) -> http::HeaderMap {
    let mut h = h.clone();
    h.remove("date");
    h
}

fn worker_calls(s: &Server) -> u64 {
    stats(s)["worker_calls"].as_u64().unwrap()
}

/// The same pages through a fake that ignores the offer (unbound) are byte-identical.
#[test]
fn planned_and_declined_pages_are_byte_identical() {
    for path in ["/", "/pokemon/pikachu", "/team", "/ids", "/nope"] {
        // fake() is bound by boot(); b is registered by hand, never bound.
        let (a, b) = (fake(), FakeBun::new(default_loader, default_jobs));
        let sa = boot(a.clone());
        let sb = boot_declining(b.clone());
        for round in 0..2 {
            let (ra, rb) = (get(&sa, path, &[]), get(&sb, path, &[]));
            assert_eq!(
                (ra.0, ra.2.as_str()),
                (rb.0, rb.2.as_str()),
                "{path} round {round}"
            );
            assert_eq!(strip(&ra.1), strip(&rb.1), "{path} round {round}");
        }
        assert_eq!(
            a.counts(),
            b.counts(),
            "{path}: same loader runs and job batches"
        );
        let (wa, wb) = (worker_calls(&sa), worker_calls(&sb));
        assert!(wa <= wb, "{path}: planned {wa} ≤ declined {wb}");
        assert_eq!((sa.plan_cells_in_use(), sb.plan_cells_in_use()), (0, 0));
    }
}

fn verdict_loader(req: Value) -> Value {
    match req["params"]["name"].as_str() {
        Some("r302") => json!({"verdict": "redirect", "location": "/pokemon/pikachu"}),
        Some("tea") => json!({"verdict": "httpError", "status": 418, "body": "teapot"}),
        Some("nothing") => {
            json!({"verdict": "notFound", "data": {"pokemon": {"name": "nothing", "stats": {}, "moves": []}}})
        }
        _ => default_loader(req),
    }
}

#[test]
fn verdicts_are_never_planned() {
    // redirect / httpError: one call, no jobs, as today.
    for (path, want) in [("/pokemon/r302", 302), ("/pokemon/tea", 418)] {
        let f = FakeBun::new(verdict_loader, default_jobs);
        let s = boot(f.clone());
        assert_eq!(get(&s, path, &[]).0, want, "{path}");
        assert_eq!(f.counts(), (1, 0), "{path}");
        assert_eq!(worker_calls(&s), 1, "{path}");
        assert_eq!(s.plan_cells_in_use(), 0, "{path}");
    }
    // notFound renders the route's template at 404 and runs its jobs (S7 step 4): the worker
    // plans only `ok` data, so a notFound page keeps the two-call path on a job miss.
    let (a, b) = (
        FakeBun::new(verdict_loader, default_jobs),
        FakeBun::new(verdict_loader, default_jobs),
    );
    let (sa, sb) = (boot(a.clone()), boot_declining(b.clone()));
    let (ra, rb) = (
        get(&sa, "/pokemon/nothing", &[]),
        get(&sb, "/pokemon/nothing", &[]),
    );
    assert_eq!(ra.0, 404, "{}", ra.2);
    assert_eq!((ra.0, ra.2.as_str()), (rb.0, rb.2.as_str()));
    assert_eq!(strip(&ra.1), strip(&rb.1));
    assert_eq!((a.counts(), b.counts()), ((1, 1), (1, 1)));
    assert_eq!((worker_calls(&sa), worker_calls(&sb)), (2, 2));
    assert_eq!((sa.plan_cells_in_use(), sb.plan_cells_in_use()), (0, 0));
}

#[test]
fn no_loader_routes_keep_planning_in_rust() {
    for path in ["/", "/ids"] {
        let f = fake();
        let s = boot(f.clone());
        assert_eq!(get(&s, path, &[]).0, 200, "{path}");
        assert_eq!(f.counts(), (0, 0), "{path}");
        assert_eq!(worker_calls(&s), 0, "{path}: no plan offer, no call");
        assert!(f.last_loader().is_none(), "{path}");
    }
}

#[test]
fn hits_pinned_at_plan_time_survive_an_invalidation_before_render() {
    // Warm r2's moveCard jobs (tag "moves"), then a page whose fake invalidates "moves" AFTER
    // plan_in_call returned "" (all hit) and BEFORE it replies: the page still renders the
    // pinned values, no job ran; the next page (another name, L1 miss) misses the moveCard
    // jobs and runs one batch.
    let calls = Arc::new(AtomicU32::new(0));
    let srv: Arc<OnceLock<Arc<Server>>> = Default::default();
    let (c2, srv2) = (calls.clone(), srv.clone());
    let f = fake().with_after_plan(move || {
        if c2.fetch_add(1, Ordering::SeqCst) == 1 {
            srv2.get().unwrap().invalidate(InvalidateArgs {
                tags: vec!["moves".into()],
                ..Default::default()
            });
        }
    });
    let s = boot(f.clone());
    srv.set(Arc::clone(&s)).ok();
    assert_eq!(get(&s, "/pokemon/pikachu", &[]).0, 200); // 1st: all miss, 1 batch
    let (_, _, body) = get(&s, "/pokemon/raichu", &[]); // 2nd: all hit; invalidated mid-call
    assert!(body.contains("<li>tackle: MOVE tackle</li>"), "{body}");
    assert_eq!(
        f.counts(),
        (2, 1),
        "the pinned hits were rendered, nothing re-ran"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2, "the invalidation ran");
    get(&s, "/pokemon/mew", &[]); // 3rd: moveCard keys gone → 1 batch
    assert_eq!(f.counts(), (3, 2));
    assert_eq!(s.plan_cells_in_use(), 0);
}

#[test]
fn a_late_planned_call_leaves_no_plan_behind() {
    let (f, gate) = FakeBun::gated(default_loader, default_jobs);
    let s = boot_with(f.clone(), |t| t.call_timeout_ms = 50);
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 504, "{body}");
    assert_eq!(
        s.plan_cells_in_use(),
        1,
        "the seed waits in the claimed slot"
    );
    gate.settle_all();
    // The detached remainder plans, takes the cell and drops the claim once JS settles.
    let t0 = std::time::Instant::now();
    while s.plan_cells_in_use() != 0 && t0.elapsed() < std::time::Duration::from_secs(5) {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(s.plan_cells_in_use(), 0);
    assert_eq!(f.counts(), (1, 1), "the late call took the offer");
    assert_eq!(stats(&s)["timed_out_calls"].as_u64(), Some(1));
}
