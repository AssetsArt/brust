//! M3-P P7 (R2): the coarse sharded timer behind hyper's `header_read_timeout`.
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Wake, Waker};
use std::time::{Duration, Instant};

use brust_server::server::coarse_timer::CoarseTimer;
use hyper::rt::{Sleep, Timer};

#[derive(Default)]
struct CountWaker(AtomicUsize);

impl Wake for CountWaker {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn poll_once(s: &mut Pin<Box<dyn Sleep>>, w: &Waker) -> Poll<()> {
    s.as_mut().poll(&mut Context::from_waker(w))
}

#[tokio::test]
async fn a_sleep_fires_after_its_deadline_and_within_two_ticks() {
    let t = CoarseTimer::new(Duration::from_millis(20));
    let _ticker = t.spawn_ticker();
    let start = Instant::now();
    let mut s = t.sleep_until(start + Duration::from_millis(150));
    tokio::time::sleep_until((start + Duration::from_millis(100)).into()).await;
    assert!(poll_once(&mut s, Waker::noop()).is_pending(), "fired early");
    assert_eq!(t.registered(), 1);
    tokio::time::timeout_at((start + Duration::from_millis(210)).into(), s)
        .await
        .expect("not fired within deadline + 3 ticks");
    assert!(start.elapsed() >= Duration::from_millis(150));
    assert_eq!(t.registered(), 0);
}

#[tokio::test]
async fn the_ticker_wakes_a_pending_sleep() {
    let t = CoarseTimer::new(Duration::from_millis(10));
    let _ticker = t.spawn_ticker();
    let cw = Arc::new(CountWaker::default());
    let w = Waker::from(Arc::clone(&cw));
    let mut s = t.sleep(Duration::from_millis(30));
    assert!(poll_once(&mut s, &w).is_pending());
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(cw.0.load(Ordering::SeqCst), 1, "woken exactly once");
    assert!(poll_once(&mut s, &w).is_ready());
    assert_eq!(t.registered(), 0);
}

#[tokio::test]
async fn a_dropped_sleep_is_never_woken() {
    let t = CoarseTimer::new(Duration::from_millis(10));
    let _ticker = t.spawn_ticker();
    let cw = Arc::new(CountWaker::default());
    let w = Waker::from(Arc::clone(&cw));
    let mut s = t.sleep(Duration::from_millis(20));
    assert!(poll_once(&mut s, &w).is_pending());
    assert_eq!(t.registered(), 1);
    drop(s);
    assert_eq!(t.registered(), 0);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(cw.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn reset_to_a_later_deadline_does_not_fire_early() {
    let t = CoarseTimer::new(Duration::from_millis(10));
    let _ticker = t.spawn_ticker();
    let start = Instant::now();
    let mut s = t.sleep_until(start + Duration::from_millis(30));
    assert!(poll_once(&mut s, Waker::noop()).is_pending());
    t.reset(&mut s, start + Duration::from_millis(150));
    assert_eq!(t.registered(), 0, "reset unregisters until the next poll");
    tokio::time::sleep_until((start + Duration::from_millis(100)).into()).await;
    assert!(
        poll_once(&mut s, Waker::noop()).is_pending(),
        "fired at the old deadline"
    );
    tokio::time::timeout_at((start + Duration::from_millis(200)).into(), s)
        .await
        .expect("reset sleep never fired");
    assert!(start.elapsed() >= Duration::from_millis(150));
    assert_eq!(t.registered(), 0);
}

#[tokio::test]
async fn reset_of_a_fired_sleep_rearms_it() {
    let t = CoarseTimer::new(Duration::from_millis(10));
    let _ticker = t.spawn_ticker();
    let mut s = t.sleep(Duration::from_millis(5));
    (&mut s).await;
    let start = Instant::now();
    t.reset(&mut s, start + Duration::from_millis(40));
    assert!(poll_once(&mut s, Waker::noop()).is_pending());
    tokio::time::timeout(Duration::from_millis(100), s)
        .await
        .expect("re-armed sleep never fired");
    assert!(start.elapsed() >= Duration::from_millis(40));
}

#[test]
fn eight_threads_register_and_drop_without_leaking_entries() {
    let t = CoarseTimer::new(Duration::from_millis(100));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let t = t.clone();
            std::thread::spawn(move || {
                for _ in 0..10_000 {
                    let mut s = t.sleep_until(Instant::now() + Duration::from_secs(1));
                    assert!(poll_once(&mut s, Waker::noop()).is_pending());
                    drop(s);
                }
            })
        })
        .collect();
    for th in threads {
        th.join().unwrap();
    }
    assert_eq!(t.registered(), 0);
}

#[test]
fn a_sleep_past_its_deadline_is_ready_without_registering() {
    let t = CoarseTimer::new(Duration::from_millis(100));
    let mut s = t.sleep_until(Instant::now());
    assert!(poll_once(&mut s, Waker::noop()).is_ready());
    assert_eq!(t.registered(), 0);
}
