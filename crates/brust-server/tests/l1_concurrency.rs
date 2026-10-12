//! F81 — the two L1 concurrency probes from the m3p-c spot-check (b1f95371), made deterministic:
//! progress + consistency, no latency oracles. A deadlock is caught by the 30 s watchdog, never by timing an op.
use brust_server::cache::l1::{CacheKey, L1Cache, RenderedBody};
use bytes::Bytes;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Sizes are the original probes' (12 readers vs 300 writer ops; 8 owners x 3000 rounds): both tests finish well under 5 s.
const READERS: usize = 12;
const WRITER_OPS: usize = 300;
const OWNERS: usize = 8;
const ROUNDS: usize = 3000;
const CLEARS: usize = 5;
const CAP_SMALL: u64 = 64;
const CAP_LARGE: u64 = 500;
const CEILING: Duration = Duration::from_secs(30);
const TTL: Duration = Duration::from_secs(60);

fn key(path: &str) -> CacheKey {
    CacheKey {
        prefix: String::new(),
        method: "GET".into(),
        path: path.into(),
        sorted_query: String::new(),
    }
}

fn body(s: &str) -> Arc<RenderedBody> {
    Arc::new(RenderedBody {
        status: 200,
        headers: http::HeaderMap::new(),
        html: Bytes::from(s.to_owned()),
        gzip: OnceLock::new(),
    })
}

fn html(b: &RenderedBody) -> String {
    String::from_utf8(b.html.to_vec()).unwrap()
}

fn tags(t: &[&str]) -> Vec<String> {
    t.iter().map(|s| (*s).to_owned()).collect()
}

/// Aborts the process if the test is still running after `CEILING` (a deadlock would otherwise hang CI).
struct Watchdog(Arc<AtomicBool>);
impl Watchdog {
    fn start(name: &'static str) -> Self {
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        std::thread::spawn(move || {
            let t = Instant::now();
            while !flag.load(Ordering::Relaxed) {
                if t.elapsed() > CEILING {
                    eprintln!("watchdog: {name} exceeded {CEILING:?} (deadlock?)");
                    std::process::abort();
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        Watchdog(done)
    }
}
impl Drop for Watchdog {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

#[test]
fn hot_key_writer_makes_progress_under_twelve_readers() {
    let _wd = Watchdog::start("hot_key");
    let cache = L1Cache::new();
    let hot = key("/hot");
    let stop = AtomicBool::new(false);
    // Highest op index the writer has started inserting: a reader may never see a value beyond it.
    let max_started = AtomicUsize::new(0);
    let mut last_insert = None;
    let mut invalidated_after_last = false;
    std::thread::scope(|sc| {
        for _ in 0..READERS {
            sc.spawn(|| {
                while !stop.load(Ordering::Relaxed) {
                    if let Some(b) = cache.get(&hot) {
                        let s = html(&b);
                        let i: usize = s
                            .strip_prefix('v')
                            .and_then(|n| n.parse().ok())
                            .unwrap_or_else(|| panic!("foreign body {s:?}"));
                        assert!(
                            i <= max_started.load(Ordering::SeqCst),
                            "value {i} was never inserted yet"
                        );
                    }
                }
            });
        }
        let w = sc.spawn(|| {
            let (mut last, mut inv) = (None, false);
            for i in 0..WRITER_OPS {
                if i % 7 == 6 {
                    cache.invalidate_path("GET", "/hot");
                    inv = true;
                } else {
                    max_started.store(i, Ordering::SeqCst);
                    cache.insert(
                        hot.clone(),
                        body(&format!("v{i}")),
                        TTL,
                        &tags(&["hot"]),
                        cache.read_stamp(),
                    );
                    last = Some(i);
                    inv = false;
                }
            }
            stop.store(true, Ordering::Relaxed);
            (last, inv)
        });
        let t = Instant::now();
        (last_insert, invalidated_after_last) = w.join().unwrap();
        assert!(t.elapsed() < CEILING);
    });
    let got = cache.get(&hot).map(|b| html(&b));
    if invalidated_after_last {
        assert_eq!(got, None);
    } else {
        assert_eq!(got, Some(format!("v{}", last_insert.unwrap())));
    }
    assert!(cache.stats().len <= 1);
}

fn churn(cap: u64) {
    let cache = L1Cache::with_capacity(cap);
    let progress = AtomicUsize::new(0);
    let total = OWNERS * ROUNDS;
    std::thread::scope(|sc| {
        for o in 0..OWNERS {
            let (cache, progress) = (&cache, &progress);
            sc.spawn(move || {
                let own = format!("owner{o}");
                for j in 0..ROUNDS {
                    let k = key(&format!("/o{o}/k{j}"));
                    let v = format!("{o}-{j}");
                    cache.insert(
                        k.clone(),
                        body(&v),
                        TTL,
                        &[own.clone(), "all".to_owned()],
                        cache.read_stamp(),
                    );
                    // Admission or a concurrent tag/clear may drop it; a DIFFERENT body is never legal.
                    if let Some(b) = cache.get(&k) {
                        assert_eq!(html(&b), v, "cap {cap}: stale/foreign body");
                    }
                    if j % 3 == 0 {
                        cache.invalidate_path("GET", &k.path);
                        assert!(
                            cache.get(&k).is_none(),
                            "cap {cap}: readable after invalidate_path"
                        );
                    }
                    if j % 50 == 49 {
                        cache.invalidate_tags(&tags(&["all"]));
                    }
                    progress.fetch_add(1, Ordering::Relaxed);
                }
            });
        }
        // Fixed stride, no RNG: clear() each time the owners have done another 1/(CLEARS+1) of the work.
        sc.spawn(|| {
            for n in 1..=CLEARS {
                while progress.load(Ordering::Relaxed) < total * n / (CLEARS + 1) {
                    std::thread::yield_now();
                }
                cache.clear();
            }
        });
    });
    cache.clear();
    for o in 0..OWNERS {
        for j in (0..ROUNDS).step_by(ROUNDS / 6 + 1) {
            assert!(cache.get(&key(&format!("/o{o}/k{j}"))).is_none());
        }
    }
    assert_eq!(cache.stats().len, 0);
}

#[test]
fn owners_churn_under_capacity_with_tag_invalidation_and_clear() {
    let _wd = Watchdog::start("owners_churn");
    churn(CAP_SMALL);
    churn(CAP_LARGE);
}
