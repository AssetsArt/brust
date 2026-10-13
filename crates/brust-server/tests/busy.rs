//! Worker starvation (Review Focus 5): a dispatch that never resolves yields a
//! 503 after `claim_timeout_ms`, and an empty pool yields 503 at once.
mod common;

use std::time::{Duration, Instant};

use brust_server::{Tuning, start};
use common::*;

#[test]
fn claim_timeout_is_503_all_workers_busy_and_static_still_answers() {
    let fake = FakeBun::with(default_loader, default_jobs, true);
    let mut cfg = config(&fx());
    cfg.tuning = Tuning {
        claim_timeout_ms: 150,
        ..Default::default()
    };
    let s = start(cfg).expect("start");
    s.register_worker(Box::new(FakeBunHandle(fake)));

    // Occupies the only slot forever; the thread is detached on purpose.
    let s2 = s.clone();
    std::thread::spawn(move || {
        let _ = get(&s2, "/pokemon/a", &[]);
    });
    std::thread::sleep(Duration::from_millis(50));

    let t0 = Instant::now();
    let (status, _, body) = get(&s, "/pokemon/b", &[]);
    let elapsed = t0.elapsed();
    assert_eq!((status, body.as_str()), (503, "all workers busy"));
    assert!(
        elapsed >= Duration::from_millis(150) && elapsed < Duration::from_secs(2),
        "{elapsed:?}"
    );

    // The static route never claims a worker.
    let (status, _, body) = get(&s, "/", &[]);
    assert_eq!(status, 200, "{body}");
}

/// "Immediately" means: the 503 is answered from the empty-pool check, WITHOUT waiting for a worker claim. A request
/// that waited would take at least `claim_timeout_ms`, so the test sets a long claim timeout and asserts the answer
/// came in under half of it. The bound is derived from the configured timeout, never a fixed few milliseconds, so a
/// loaded runner (connect + round trip + scheduling) cannot trip it (F127, R28.2).
#[test]
fn no_workers_is_503_immediately() {
    const CLAIM_TIMEOUT_MS: u64 = 10_000;
    let mut cfg = config(&fx());
    cfg.expected_workers = 0;
    cfg.tuning = Tuning {
        claim_timeout_ms: CLAIM_TIMEOUT_MS,
        ..Default::default()
    };
    let s = start(cfg).expect("start");

    let t0 = Instant::now();
    let (status, _, body) = get(&s, "/pokemon/a", &[]);
    let elapsed = t0.elapsed();
    assert_eq!((status, body.as_str()), (503, "no workers"));
    let bound = Duration::from_millis(CLAIM_TIMEOUT_MS / 2);
    assert!(
        elapsed < bound,
        "the 503 took {elapsed:?}, bound {bound:?} (half of claim_timeout_ms = {CLAIM_TIMEOUT_MS}): it waited for a worker claim"
    );
}

#[test]
fn parked_loader_is_504_and_static_routes_still_answer() {
    let (fake, _gate) = FakeBun::gated(default_loader, default_jobs);
    let s = boot_with(fake, |t| {
        t.call_timeout_ms = 200;
        t.claim_timeout_ms = 150;
    });
    let (status, _, body) = get(&s, "/pokemon/a", &[]);
    assert_eq!((status, body.as_str()), (504, "call deadline exceeded"));
    assert_eq!(get(&s, "/", &[]).0, 200, "static route unaffected");
    let (status, _, body) = get(&s, "/pokemon/b", &[]);
    assert_eq!(
        (status, body.as_str()),
        (503, "all workers busy"),
        "the slot is still held"
    );
    let st = stats(&s);
    assert_eq!(st["timed_out_calls"], 1);
    assert_eq!(st["loader_calls"], 1);
}

#[test]
fn late_result_after_504_is_not_cached() {
    let (fake, gate) = FakeBun::gated(default_loader, default_jobs);
    let s = boot_with(fake, |t| t.call_timeout_ms = 100);
    assert_eq!(get(&s, "/pokemon/a", &[]).0, 504);
    gate.settle_all(); // the parked loader now returns its data
    std::thread::sleep(Duration::from_millis(100));
    let st = stats(&s);
    assert_eq!(st["l1"]["len"], 0, "nothing stored from a timed-out call");
    let (status, h, body) = get(&s, "/pokemon/a", &[]);
    assert_eq!(status, 200, "{body}");
    assert_eq!(cache_hdr(&h), Some("MISS"));
}
