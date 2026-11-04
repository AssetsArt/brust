//! F508: every 200 of `/_brust/cache/stats` carries `cache-control: no-store`, in both modes that serve it. This drives
//! `Core<TestHost>`, the host shape of the Workers build: the same `pipeline::handle` the native server shares, so the
//! header is checked where it is made, once, for every host. A request that is not allowed gets the unknown-path 404,
//! which is not the stats response and carries nothing of it.
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use brust_core::cache::local::{LocalJobs, LocalL1};
use brust_core::config::StatsAccess;
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

fn core_with(stats: StatsAccess) -> Core<TestHost> {
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
    let loaded = Manifest::from_parts(&json, &files).unwrap();
    let cfg = CoreConfig {
        l1_capacity: 16,
        job_cache_capacity: 16,
        stats,
        ..Default::default()
    };
    Core::new(TestHost::default(), loaded, cfg).unwrap()
}

fn get(core: &Core<TestHost>, path: &str, headers: &HeaderMap) -> http::Response<Bytes> {
    let rq = RequestHead {
        method: "GET",
        full: path,
        headers,
        authority: None,
    };
    block_on(core.handle(rq, ()))
}

const PATH: &str = "/_brust/cache/stats";

fn bearer(token: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        http::header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    h
}

#[test]
fn a_public_stats_response_is_never_stored() {
    let r = get(&core_with(StatsAccess::Public), PATH, &HeaderMap::new());
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers().get("cache-control").unwrap(), "no-store");
    assert_eq!(r.headers().get("content-type").unwrap(), "application/json");
    assert!(
        std::str::from_utf8(r.body())
            .unwrap()
            .contains("loader_calls")
    );
}

#[test]
fn a_token_stats_response_is_never_stored_and_a_refusal_is_not_the_stats_answer() {
    let core = core_with(StatsAccess::Token("s3cret".into()));
    let ok = get(&core, PATH, &bearer("s3cret"));
    assert_eq!(ok.status(), 200);
    assert_eq!(ok.headers().get("cache-control").unwrap(), "no-store");
    let refused = get(&core, PATH, &bearer("wrong"));
    assert_eq!(refused.status(), 404);
    assert!(
        !std::str::from_utf8(refused.body())
            .unwrap()
            .contains("loader_calls")
    );
}

#[test]
fn an_off_stats_path_answers_404() {
    let r = get(&core_with(StatsAccess::Off), PATH, &HeaderMap::new());
    assert_eq!(r.status(), 404);
}
