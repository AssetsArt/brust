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

#[test]
fn no_workers_is_503_immediately() {
    let mut cfg = config(&fx());
    cfg.expected_workers = 0;
    let s = start(cfg).expect("start");

    let t0 = Instant::now();
    let (status, _, body) = get(&s, "/pokemon/a", &[]);
    let elapsed = t0.elapsed();
    assert_eq!((status, body.as_str()), (503, "no workers"));
    assert!(elapsed < Duration::from_millis(50), "{elapsed:?}");
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
