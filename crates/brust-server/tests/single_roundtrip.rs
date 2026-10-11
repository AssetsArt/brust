//! M3-P P6: one worker round trip per loader page (the planned loader call). The default
//! `fake()` is bound by `boot()` and takes the plan offer like the real worker; a fake that
//! is registered by hand and never bound ignores it (the two-call path).
mod common;

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock, Weak, mpsc};
use std::time::{Duration, Instant};

use brust_server::dispatch::{CallKind, DispatchError, RenderDispatch};
use brust_server::{Config, InvalidateArgs, Server, Tuning, start};
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

/// A job batch that fails as a whole (the worker's `{error}` reply: a throw or a slot overflow)
/// inside a planned call is a 500 that still counts as a job batch, as on the two-call path.
#[test]
fn a_failed_job_batch_inside_a_planned_call_counts_like_the_two_call_path() {
    let failing = |_req: Value| json!({"error": "boom"});
    for planned in [true, false] {
        let f = FakeBun::new(default_loader, failing);
        let s = if planned {
            boot(f.clone())
        } else {
            boot_declining(f.clone())
        };
        let (st, _, _) = get(&s, "/pokemon/pikachu", &[]);
        assert_eq!(st, 500, "planned={planned}");
        let st = stats(&s);
        assert_eq!(
            (st["loader_calls"].as_u64(), st["job_calls"].as_u64()),
            (Some(1), Some(1)),
            "planned={planned}"
        );
        assert_eq!(s.plan_cells_in_use(), 0);
    }
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

// ----------------------------------------------------------------------------
// Stress: 8 worker threads plan while tokio inserts and invalidates
// ----------------------------------------------------------------------------

type Reply = (CallKind, String, u32, tokio::sync::oneshot::Sender<u32>);
type Binding = Arc<OnceLock<(Weak<Server>, u32)>>;

const STRESS_SLOT: usize = 64 * 1024;
const STRESS_SLOTS: usize = 2;

/// A [`RenderDispatch`] backed by its own OS thread, like a Bun Worker: `call()` hands the
/// request to the thread and awaits the reply length; the thread answers the planned protocol
/// (Task 6 Step 4), calling `plan_in_call` FROM THAT THREAD, and writes its leaked 2-slot buffer.
struct ThreadWorker {
    tx: mpsc::Sender<Reply>,
    ptr: *mut u8,
    /// `jobs` calls received (the two-call path; M3-P P7's adaptive offer, ruling R1).
    jobs_calls: Arc<AtomicU32>,
    /// Loader calls that were not offered the plan (their route had stopped offering).
    unoffered: Arc<AtomicU32>,
}

// SAFETY: the buffer is leaked; slot `i` is only written by the worker thread while tokio holds
// that slot's claim, and read by tokio after the reply length arrived (the oneshot is the
// happens-before), as with the production SAB.
unsafe impl Send for ThreadWorker {}
unsafe impl Sync for ThreadWorker {}

struct SendPtr(*mut u8);
// SAFETY: see `ThreadWorker`.
unsafe impl Send for SendPtr {}

fn stress_hp(i: usize) -> usize {
    10 + (i * 7919) % 90
}

fn stress_loader(req: &Value) -> Value {
    let name = req["params"]["name"].as_str().expect("name param");
    let i: usize = name
        .strip_prefix('n')
        .and_then(|n| n.parse().ok())
        .expect("n<i>");
    json!({"ok": true, "data": {"pokemon": {
        "name": name,
        "stats": {"hp": stress_hp(i)},
        "moves": [{"name": format!("m-{name}-a")}, {"name": format!("m-{name}-b")}]
    }}})
}

fn stress_jobs(req: &Value) -> Value {
    let results: Vec<Value> = req["jobs"]
        .as_array()
        .expect("jobs array")
        .iter()
        .map(|call| {
            let value = match call["componentId"].as_str() {
                Some("detailPage_c3") => json!({"_s1": format!(
                    "HP {}",
                    call["inputs"]["pokemon"]["stats"]["hp"].as_u64().expect("hp input")
                )}),
                Some("moveCard_d4") => json!({"_s1": format!(
                    "MOVE {}",
                    call["inputs"]["move"]["name"].as_str().expect("move input")
                )}),
                other => panic!("stress jobs: unexpected component {other:?}"),
            };
            json!({"id": call["id"], "value": value})
        })
        .collect();
    json!({ "results": results })
}

impl ThreadWorker {
    fn spawn(bound: Binding) -> Self {
        Self::spawn_with(bound, Duration::ZERO, Duration::ZERO)
    }

    /// `loader_delay` before the loader answers; `jobs_delay` before a planned call's misses run.
    fn spawn_with(bound: Binding, loader_delay: Duration, jobs_delay: Duration) -> Self {
        let ptr = Box::leak(vec![0u8; STRESS_SLOT * STRESS_SLOTS].into_boxed_slice()).as_mut_ptr();
        let (tx, rx) = mpsc::channel::<Reply>();
        let base = SendPtr(ptr);
        let unoffered = Arc::new(AtomicU32::new(0));
        let unoffered_w = Arc::clone(&unoffered);
        std::thread::spawn(move || {
            let base = base;
            let write = |slot: u32, bytes: &[u8]| {
                assert!(bytes.len() <= STRESS_SLOT, "reply {} > slot", bytes.len());
                // SAFETY: in-bounds sub-region of the leaked buffer for a claimed slot.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        bytes.as_ptr(),
                        base.0.add(slot as usize * STRESS_SLOT),
                        bytes.len(),
                    )
                };
            };
            while let Ok((kind, json, slot, done)) = rx.recv() {
                let req: Value = serde_json::from_str(&json).expect("request is JSON");
                let bytes = match kind {
                    CallKind::Jobs => serde_json::to_vec(&stress_jobs(&req)).unwrap(),
                    CallKind::Loader => {
                        std::thread::sleep(loader_delay);
                        let first = serde_json::to_vec(&stress_loader(&req)).unwrap();
                        let (s, id) = bound
                            .get()
                            .and_then(|(w, id)| w.upgrade().map(|s| (s, *id)))
                            .expect("bound before the first request");
                        if req["plan"] != true {
                            unoffered_w.fetch_add(1, Ordering::SeqCst);
                            first
                        } else {
                            write(slot, &first);
                            let misses =
                                brust_server::plan_in_call(&s, id, slot, first.len() as u32);
                            if misses == brust_server::PLAN_DECLINED {
                                first
                            } else {
                                let results = if misses.is_empty() {
                                    json!([])
                                } else {
                                    let jr: Value = serde_json::from_str(&misses).unwrap();
                                    std::thread::sleep(jobs_delay);
                                    stress_jobs(&jr)["results"].clone()
                                };
                                serde_json::to_vec(&json!({"planned": true, "results": results}))
                                    .unwrap()
                            }
                        }
                    }
                };
                write(slot, &bytes);
                let _ = done.send(bytes.len() as u32);
            }
        });
        Self {
            tx,
            ptr,
            jobs_calls: Default::default(),
            unoffered,
        }
    }
}

impl RenderDispatch for ThreadWorker {
    fn call(
        &self,
        kind: CallKind,
        request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
        if kind == CallKind::Jobs {
            self.jobs_calls.fetch_add(1, Ordering::SeqCst);
        }
        let (done, rx) = tokio::sync::oneshot::channel();
        let sent = self.tx.send((kind, request_json, slot, done));
        Box::pin(async move {
            sent.map_err(|e| DispatchError::EnqueueFailed(e.to_string()))?;
            rx.await
                .map_err(|_| DispatchError::PromiseRejected("worker thread died".into()))
        })
    }

    fn slot_count(&self) -> usize {
        STRESS_SLOTS
    }

    fn buf(&self) -> (*mut u8, usize) {
        (self.ptr, STRESS_SLOT * STRESS_SLOTS)
    }
}

/// One keep-alive connection; `paths` in order; every (status, body).
async fn client_run(addr: std::net::SocketAddr, paths: Vec<String>) -> Vec<(String, u16, String)> {
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut sender, conn) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp))
            .await
            .unwrap();
    tokio::spawn(conn);
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        sender.ready().await.unwrap();
        let req = http::Request::builder()
            .method("GET")
            .uri(&path)
            .header("host", "fx")
            .body(http_body_util::Empty::<bytes::Bytes>::new())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = http_body_util::BodyExt::collect(body)
            .await
            .unwrap()
            .to_bytes();
        out.push((
            path,
            parts.status.as_u16(),
            String::from_utf8_lossy(&bytes).into_owned(),
        ));
    }
    out
}

/// 8 worker threads × 1000 pages: `plan_in_call` reads the job cache from 8 OS threads while
/// tokio inserts results and a task invalidates the "moves" tag every millisecond. Every page
/// must render the values of ITS OWN inputs (no torn or crossed entries), no call may fail, and
/// no plan may be left in a slot. The first half of the pages runs with the invalidator paused,
/// so the route provably stops offering the plan (R1); the second half starts with an
/// invalidation, so the two-call path provably runs on any host speed.
#[test]
fn eight_workers_plan_while_tokio_inserts_and_invalidates() {
    const WORKERS: usize = 8;
    const PAGES: usize = 1000;
    const NAMES: usize = 40;
    const CLIENTS: usize = 64;
    let mut cfg = Config {
        expected_workers: WORKERS as u32,
        ..config(&fx())
    };
    // 64 clients queue on 16 slots; a debug build must never hit the claim deadline.
    cfg.tuning = Tuning {
        claim_timeout_ms: 30_000,
        ..cfg.tuning
    };
    let s = start(cfg).unwrap();
    let (mut jobs_calls, mut unoffered) = (Vec::new(), Vec::new());
    for _ in 0..WORKERS {
        let bound: Binding = Default::default();
        let w = ThreadWorker::spawn(bound.clone());
        jobs_calls.push(Arc::clone(&w.jobs_calls));
        unoffered.push(Arc::clone(&w.unoffered));
        let id = s.register_worker(Box::new(w));
        bound.set((Arc::downgrade(&s), id)).unwrap();
    }
    let t0 = std::time::Instant::now();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let sum = |v: &[Arc<AtomicU32>]| -> u64 {
        v.iter().map(|c| u64::from(c.load(Ordering::SeqCst))).sum()
    };
    let invalidate = |s: &Server| {
        s.invalidate(InvalidateArgs {
            tags: vec!["moves".into()],
            ..Default::default()
        })
    };
    let invalidations = rt.block_on(async {
        let (stop, paused) = (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(true)),
        );
        let inv = {
            let (s, stop, paused) = (Arc::clone(&s), stop.clone(), paused.clone());
            tokio::spawn(async move {
                let mut n = 0u64;
                while !stop.load(Ordering::SeqCst) {
                    if !paused.load(Ordering::SeqCst) {
                        invalidate(&s);
                        n += 1;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                n
            })
        };
        let per = WORKERS * PAGES / CLIENTS;
        let paths = |c: usize, ks: std::ops::Range<usize>| -> Vec<String> {
            ks.map(|k| {
                let r = c * per + k;
                format!("/pokemon/n{}?q={r}", r % NAMES)
            })
            .collect()
        };
        let run = |ks: std::ops::Range<usize>| {
            let clients: Vec<_> = (0..CLIENTS)
                .map(|c| tokio::spawn(client_run(s.local_addr(), paths(c, ks.clone()))))
                .collect();
            async move {
                for c in clients {
                    for (path, status, body) in c.await.unwrap() {
                        let i: usize = path["/pokemon/n".len()..path.find('?').unwrap()]
                            .parse()
                            .unwrap();
                        assert_eq!(status, 200, "{path}: {body}");
                        assert!(
                            body.contains(&format!("<p>HP {}</p>", stress_hp(i))),
                            "{path}: {body}"
                        );
                        assert!(
                            body.contains(&format!(
                                "<li>m-n{i}-a: MOVE m-n{i}-a</li><li>m-n{i}-b: MOVE m-n{i}-b</li>"
                            )),
                            "{path}: {body}"
                        );
                    }
                }
            }
        };
        // Phase 1, invalidator paused: each client sees all NAMES within its first NAMES pages,
        // then only hits, so the route reaches 64 consecutive all-hit planned calls and stops
        // offering the plan.
        run(0..per / 2).await;
        assert!(
            sum(&unoffered) > 0,
            "the route stopped offering the plan after the quiet phase"
        );
        // Phase 2: invalidate before any page runs, then every millisecond. The first miss lands
        // on a route that is not offering, so it takes the two-call path.
        invalidate(&s);
        paused.store(false, Ordering::SeqCst);
        run(per / 2..per).await;
        stop.store(true, Ordering::SeqCst);
        inv.await.unwrap() + 1
    });
    let wall = t0.elapsed();
    let st = stats(&s);
    eprintln!(
        "stress: {} pages in {wall:?}, {invalidations} invalidations, job {}",
        WORKERS * PAGES,
        st["job"]
    );
    assert_eq!(st["loader_calls"], (WORKERS * PAGES) as u64);
    // Every page is one loader round trip, plus one `jobs` round trip only when its route had
    // stopped offering the plan (64 all-hit planned calls, M3-P P7 ruling R1) and a job missed.
    let jobs_calls = sum(&jobs_calls);
    eprintln!("stress: {jobs_calls} two-call pages (adaptive offer)");
    assert!(
        0 < jobs_calls && jobs_calls <= (WORKERS * PAGES) as u64,
        "the two-call path ran: {jobs_calls}"
    );
    assert_eq!(
        st["worker_calls"],
        (WORKERS * PAGES) as u64 + jobs_calls,
        "one round trip per page, two only on a miss while not offered"
    );
    assert!(
        st["job"]["hits"].as_u64().unwrap() > 0 && st["job"]["misses"].as_u64().unwrap() > 0,
        "{st}"
    );
    assert_eq!(s.plan_cells_in_use(), 0);
}

/// One planned call keeps the old per-phase deadlines: the loader phase gets `call_timeout`, the
/// jobs phase `call_timeout` from when `planJobs` handed out the misses (lead ruling on
/// challenge 23e71e74). Two calls of 0.6 T each used to succeed and still do; a phase over T is
/// a 504 near the end of THAT phase's budget.
#[test]
fn a_planned_call_times_the_loader_and_the_jobs_phase_separately() {
    const T: u64 = 400;
    let cases = [
        (240, 240, 200, (T, 2 * T)),
        (440, 0, 504, (T, T + T / 2)),
        (0, 440, 504, (T, T + T / 2)),
    ];
    for (i, (loader_ms, jobs_ms, want, (lo, hi))) in cases.into_iter().enumerate() {
        let mut cfg = config(&fx());
        cfg.tuning = Tuning {
            call_timeout_ms: T,
            ..cfg.tuning
        };
        let s = start(cfg).unwrap();
        let bound: Binding = Default::default();
        let w = ThreadWorker::spawn_with(
            bound.clone(),
            Duration::from_millis(loader_ms),
            Duration::from_millis(jobs_ms),
        );
        let id = s.register_worker(Box::new(w));
        bound.set((Arc::downgrade(&s), id)).unwrap();
        let t0 = Instant::now();
        let (st, _, body) = get(&s, &format!("/pokemon/n{i}?q=t"), &[]);
        let ms = t0.elapsed().as_millis() as u64;
        assert_eq!(
            st, want,
            "loader {loader_ms} ms + jobs {jobs_ms} ms: {body}"
        );
        if want == 200 {
            assert!(
                body.contains(&format!("<p>HP {}</p>", stress_hp(i))),
                "{body}"
            );
            assert!(ms < hi, "{ms} ms");
        } else {
            assert!(
                (lo..hi).contains(&ms),
                "504 after {ms} ms, want [{lo}, {hi})"
            );
        }
    }
}
