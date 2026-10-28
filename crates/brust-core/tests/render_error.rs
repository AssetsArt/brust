//! W1d PR 3 (ruling A, condition 4): a component that threw while rendering (`render_error`, the end of an early-return
//! chain that ends in `throw new Error(…)`) is the host's own 500 on every target. This drives `Core<TestHost>`, the host
//! shape of the Workers build (single-thread `LocalL1` / `LocalJobs`, no workers, no I/O): the same `brust_jinja::register`
//! and the same `pipeline::handle` the wasm/CF host and the native server share, so the answer is checked where it is made.
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use brust_core::cache::local::{LocalJobs, LocalL1};
use brust_core::core::{Core, CoreConfig};
use brust_core::host::{
    ActionCall, ActionReply, CallError, Clock, Host, ManualClock, ReadErr, RequestHead, StaticRoot,
};
use brust_core::manifest::Manifest;
use brust_core::plan::{PlanSeed, PlannedCall};
use brust_core::protocol::{JobsRequest, JobsResponse, LoaderRequest, LoaderResponse};
use bytes::Bytes;
use http::HeaderMap;

/// A host with no app behind it: the fixture route has no loader and no job.
#[derive(Default)]
struct TestHost {
    clock: ManualClock,
}

impl Clock for TestHost {
    fn now_ns(&self) -> u64 {
        self.clock.now_ns()
    }
}

impl Host for TestHost {
    type Body = ();
    type L1 = LocalL1<ManualClock>;
    type Jobs = LocalJobs<ManualClock>;
    const PLAN_OFFER: bool = false;

    async fn loader(
        &self,
        _req: &LoaderRequest<'_>,
        _offer: Option<PlanSeed>,
    ) -> Result<(LoaderResponse, Option<PlannedCall>), CallError> {
        Err(CallError::Rejected("no loader".into()))
    }
    async fn jobs(&self, _req: &JobsRequest<'_>) -> Result<JobsResponse, CallError> {
        Err(CallError::Rejected("no jobs".into()))
    }
    async fn read_body(&self, _body: (), _cap: usize) -> Result<Bytes, ReadErr> {
        Ok(Bytes::new())
    }
    async fn action(&self, _call: ActionCall<'_, ()>) -> Result<ActionReply, CallError> {
        Err(CallError::Rejected("no actions".into()))
    }
    async fn static_file(
        &self,
        _root: StaticRoot,
        _rel: &str,
        _headers: &HeaderMap,
        _head: bool,
    ) -> Option<http::Response<Bytes>> {
        None
    }
}

/// Everything here resolves without waiting: poll once with a waker that does nothing.
fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    match f.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("the future waited: this test host does no I/O"),
    }
}

fn core_with(home: &str) -> Core<TestHost> {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../brust-server/tests/fixtures/dist");
    let json = std::fs::read_to_string(dist.join("manifest.json")).unwrap();
    let mut files = BTreeMap::new();
    for e in std::fs::read_dir(dist.join("jinja")).unwrap() {
        let name = e.unwrap().file_name().into_string().unwrap();
        files.insert(
            format!("jinja/{name}"),
            std::fs::read_to_string(dist.join("jinja").join(&name)).unwrap(),
        );
    }
    files.insert("jinja/homePage_b2.jinja".into(), home.into());
    let loaded = Manifest::from_parts(&json, &files).unwrap();
    let cfg = CoreConfig {
        l1_capacity: 16,
        job_cache_capacity: 16,
        ..Default::default()
    };
    Core::new(TestHost::default(), loaded, cfg).unwrap()
}

fn get(core: &Core<TestHost>) -> http::Response<Bytes> {
    let headers = HeaderMap::new();
    let rq = RequestHead {
        method: "GET",
        full: "/",
        headers: &headers,
        authority: None,
    };
    block_on(core.handle(rq, ()))
}

#[test]
fn a_page_that_reaches_a_render_error_is_the_hosts_own_500_with_no_message() {
    // the arm is an error only where it is reached
    let fine = core_with(
        "<main>{% if false %}{{ (none | render_error) | e }}{% else %}ok{% endif %}</main>",
    );
    let r = get(&fine);
    assert_eq!(r.status(), 200);
    assert!(
        std::str::from_utf8(r.body())
            .unwrap()
            .contains("<main>ok</main>")
    );

    let boom = core_with("<main>{{ (none | render_error) | e }}</main>");
    let r = get(&boom);
    assert_eq!(r.status(), 500);
    assert_eq!(r.body().as_ref(), b"500 Internal Server Error");
}
