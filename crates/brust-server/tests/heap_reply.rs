//! L10: loader / jobs / planned replies too large for the SAB slot cross by heap (`putFetchReply`
//! + the 5-byte marker `[0x00][u32 LE n]`), capped by `max_loader_response_bytes`.
mod common;

use brust_server::Server;
use common::*;
use serde_json::{Value, json};

/// Over the fake worker's 256 KiB slot.
const PAD: usize = 300_000;

fn pad() -> String {
    "p".repeat(PAD)
}

fn loader_with_pad(req: Value) -> Value {
    let mut r = default_loader(req);
    r["data"]["pad"] = json!(pad());
    r
}

/// The default job rules, except the page's `_s1` carries `pad`.
fn jobs_with_pad(req: Value) -> Value {
    let mut r = default_jobs(req);
    for res in r["results"].as_array_mut().unwrap() {
        if res["value"]["_s1"] == "HP 35" {
            res["value"]["_s1"] = json!(format!("HP 35 {}", pad()));
        }
    }
    r
}

fn idle(s: &Server) {
    assert_eq!((s.plan_cells_in_use(), s.heap_replies_in_use()), (0, 0));
}

/// A planned call with a 300 KB loader ctx plans from the bytes (`planJobsBuf`): one worker call.
#[test]
fn a_planned_call_with_an_oversized_ctx_is_still_one_worker_call() {
    let f = FakeBun::new(loader_with_pad, default_jobs);
    let s = boot(f.clone());
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(body.contains("<p>HP 35</p>"), "{body}");
    assert_eq!(f.counts(), (1, 1));
    assert_eq!(stats(&s)["worker_calls"].as_u64(), Some(1));
    idle(&s);
}

/// The final `{planned, results}` reply over the slot also crosses by heap.
#[test]
fn an_oversized_planned_reply_crosses_by_heap() {
    let f = FakeBun::new(default_loader, jobs_with_pad);
    let s = boot(f.clone());
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(
        body.contains(&format!("HP 35 {}", pad())),
        "page carries the big result"
    );
    assert_eq!(f.counts(), (1, 1));
    idle(&s);
}

/// The two-call path: a big verdict-less loader reply (planning declined) and a big `jobs` reply.
#[test]
fn oversized_loader_and_jobs_replies_cross_by_heap_on_the_two_call_path() {
    let f = FakeBun::new(loader_with_pad, jobs_with_pad).declining_plan();
    let s = boot(f.clone());
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(body.contains(&format!("HP 35 {}", pad())));
    assert_eq!(f.counts(), (1, 1));
    assert_eq!(stats(&s)["worker_calls"].as_u64(), Some(2), "loader + jobs");
    idle(&s);
}

/// A planned ctx over the cap: planning declines, the heap put is declined too → the worker's
/// `{error}` → 500. The slot is clean after.
#[test]
fn a_reply_over_max_loader_response_bytes_is_declined() {
    let f = FakeBun::new(loader_with_pad, default_jobs);
    let s = boot_with(f.clone(), |t| t.max_loader_response_bytes = 262_144);
    let (st, _, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 500);
    idle(&s);
    // The same server keeps serving a small page.
    let g = FakeBun::new(default_loader, default_jobs);
    let s2 = boot_with(g, |t| t.max_loader_response_bytes = 262_144);
    assert_eq!(get(&s2, "/pokemon/pikachu", &[]).0, 200);
}

/// `put_fetch_reply` on an idle slot, or past the cap, is declined; nothing is left behind.
#[test]
fn put_on_an_idle_slot_is_declined() {
    let f = fake();
    let s = boot(f.clone());
    assert!(!brust_server::put_fetch_reply(&s, f.worker_id(), 0, b"abc"));
    assert!(!brust_server::put_fetch_reply(&s, f.worker_id(), 7, b"abc"));
    assert!(!brust_server::put_fetch_reply(&s, 99, 0, b"abc"));
    idle(&s);
}

/// The limit is validated at boot: 256 KiB..=64 MiB.
#[test]
fn max_loader_response_bytes_is_range_checked_at_start() {
    for bad in [0usize, 262_143, 64 * 1024 * 1024 + 1] {
        let mut cfg = config(&fx());
        cfg.tuning.max_loader_response_bytes = bad;
        let e = brust_server::start(cfg).err().expect("must not boot");
        assert_eq!(
            e,
            format!("tuning: max_loader_response_bytes must be in 262144..=67108864 (got {bad})")
        );
    }
    for ok in [262_144usize, 64 * 1024 * 1024] {
        let mut cfg = config(&fx());
        cfg.tuning.max_loader_response_bytes = ok;
        assert!(brust_server::start(cfg).is_ok(), "{ok}");
    }
}
