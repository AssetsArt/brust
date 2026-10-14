//! M3-P P7 (R3): the loader-call deadline lives in the claimed slot and one sweeper per pool fires
//! it (within one 10 ms tick after it passed), instead of a tokio timer per call.
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::fake_bun::FakeBun;
use common::*;

#[test]
fn a_parked_call_is_504_on_time_and_its_slot_stays_held_until_the_late_settle() {
    let (fake, gate) = FakeBun::gated(default_loader, default_jobs);
    let s = boot_with(Arc::clone(&fake), |t| {
        t.call_timeout_ms = 100;
        t.claim_timeout_ms = 50;
    });
    let t0 = Instant::now();
    let (status, _, body) = get(&s, "/pokemon/a", &[]);
    let ms = t0.elapsed().as_millis();
    assert_eq!((status, body.as_str()), (504, "call deadline exceeded"));
    // deadline + 2 sweeper ticks, plus the test client's own request overhead.
    assert!((100..160).contains(&ms), "504 after {ms} ms");

    // The detached remainder still owns the only slot: the next page waits for a claim, not a call.
    let (status, _, body) = get(&s, "/pokemon/b", &[]);
    assert_eq!((status, body.as_str()), (503, "all workers busy"));

    gate.settle_all();
    // The sweeper releases the slot once the late settle lands: retry while the pool still answers "busy" instead of
    // sleeping a fixed 50 ms (the bound only ends a hang).
    let deadline = Instant::now() + Duration::from_secs(30);
    let (status, _, body) = loop {
        let r = get(&s, "/pokemon/c", &[]);
        if r.0 != 503 || Instant::now() > deadline {
            break r;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(status, 200, "slot released after the late settle: {body}");
    let st = stats(&s);
    assert_eq!(st["timed_out_calls"], 1, "{st}");
}

#[test]
fn many_fast_calls_under_a_long_deadline_never_time_out() {
    let s = boot_with(fake(), |t| t.call_timeout_ms = 1_000);
    let addr = s.local_addr();
    // One keep-alive connection per thread (a connection per request exhausts ephemeral ports).
    let threads: Vec<_> = (0..8)
        .map(|th| {
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async move {
                    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
                    let (mut tx, conn) =
                        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp))
                            .await
                            .unwrap();
                    tokio::spawn(conn);
                    for i in 0..1_000 {
                        tx.ready().await.unwrap();
                        let req = http::Request::get(format!("/pokemon/t{th}x{i}"))
                            .header("host", "fx")
                            .body(http_body_util::Empty::<bytes::Bytes>::new())
                            .unwrap();
                        let resp = tx.send_request(req).await.unwrap();
                        let status = resp.status().as_u16();
                        let body = http_body_util::BodyExt::collect(resp.into_body())
                            .await
                            .unwrap()
                            .to_bytes();
                        assert_eq!(status, 200, "{body:?}");
                    }
                })
            })
        })
        .collect();
    for th in threads {
        th.join().unwrap();
    }
    let st = stats(&s);
    assert_eq!(st["timed_out_calls"], 0, "{st}");
    assert_eq!(s.plan_cells_in_use(), 0);
}
