//! Proves the shared `FakeBun` double end-to-end through the real `WorkerPool`
//! and `call_worker` (the only SAB reader), before any server test consumes it.

mod common;

use std::sync::Arc;
use std::time::Duration;

use brust_server::dispatch::{CallError, CallKind, call_worker};
use brust_server::pool::WorkerPool;
use brust_server::protocol::{JobCall, JobsRequest, JobsResponse, LoaderResponse};
use common::{FakeBun, FakeBunHandle};
use serde_json::{Value, json};

#[tokio::test(flavor = "current_thread")]
async fn fake_bun_round_trips_loader_and_jobs_through_call_worker() {
    let fake = FakeBun::new(
        |req| json!({"ok": true, "data": {"route": req["routeId"].clone()}}),
        |req| {
            let results: Vec<Value> = req["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|j| json!({"id": j["id"].clone(), "value": {"_s1": "v"}}))
                .collect();
            json!({ "results": results })
        },
    );
    let pool = Arc::new(WorkerPool::new());
    pool.register(Box::new(FakeBunHandle(Arc::clone(&fake))));
    let t = Duration::from_millis(200);

    let r: LoaderResponse = call_worker(&pool, t, t, CallKind::Loader, &json!({"routeId": "r2"}))
        .await
        .unwrap();
    let LoaderResponse::Ok { data, .. } = r else {
        panic!("expected Ok, got {r:?}")
    };
    assert_eq!(data, json!({"route": "r2"}));

    let req = JobsRequest {
        jobs: vec![JobCall {
            id: "detailPage_c3/j0".into(),
            component_id: "detailPage_c3".into(),
            kind: serde_json::from_value(json!("precompute")).unwrap(),
            inputs: json!({}),
            target: None,
            row: None,
        }],
    };
    let r: JobsResponse = call_worker(&pool, t, t, CallKind::Jobs, &req)
        .await
        .unwrap();
    assert_eq!(r.results.len(), 1);
    assert_eq!(r.results[0].id, "detailPage_c3/j0");

    assert_eq!(fake.counts(), (1, 1));
    assert_eq!(fake.last_loader().unwrap()["routeId"], "r2");
    assert_eq!(
        fake.last_jobs().unwrap()["jobs"][0]["componentId"],
        "detailPage_c3"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn never_complete_fake_holds_the_claim_so_the_next_call_times_out() {
    let fake = FakeBun::with(|_| json!({}), |_| json!({}), true);
    let pool = Arc::new(WorkerPool::new());
    pool.register(Box::new(FakeBunHandle(Arc::clone(&fake))));

    let p = Arc::clone(&pool);
    let stuck = tokio::spawn(async move {
        let _ = call_worker::<_, Value>(
            &p,
            Duration::from_secs(5),
            Duration::from_secs(5),
            CallKind::Loader,
            &json!({}),
        )
        .await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    let r = call_worker::<_, Value>(
        &pool,
        Duration::from_millis(50),
        Duration::from_secs(5),
        CallKind::Loader,
        &json!({}),
    )
    .await;
    assert!(matches!(r, Err(CallError::Timeout)), "{r:?}");
    assert_eq!(fake.counts(), (1, 0));
    stuck.abort();
}
