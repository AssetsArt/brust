//! F585: a job slot the wrapper tagged (NaN, ±Infinity, a bigint) is decoded where the job results are taken, before the
//! job cache, on the host shape of the Workers build (`LocalJobs`, the same `pipeline::handle` the wasm / Cloudflare host
//! and the native server share): the first render and a render from the cached value print what JS prints.
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::pin::pin;
use std::sync::atomic::{AtomicUsize, Ordering};
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

struct TestHost {
    clock: ManualClock,
    slot: serde_json::Value,
    calls: AtomicUsize,
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
        let r = serde_json::from_value(serde_json::json!({
            "ok": true,
            "data": { "pokemon": { "name": "p", "stats": 1, "moves": [] } }
        }))
        .unwrap();
        Ok((r, None))
    }
    async fn jobs(&self, req: &JobsRequest<'_>) -> Result<JobsResponse, CallError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let results = req
            .jobs
            .iter()
            .map(|j| serde_json::json!({ "id": j.id, "value": { "_s1": self.slot } }))
            .collect::<Vec<_>>();
        Ok(serde_json::from_value(serde_json::json!({ "results": results })).unwrap())
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

fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    match f.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("the future waited: this test host does no I/O"),
    }
}

fn core_with(slot: serde_json::Value) -> Core<TestHost> {
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
    // The detail page's one job slot, printed as text, as an attribute, and tested.
    files.insert(
        "jinja/detailPage_c3.jinja".into(),
        "<main title=\"{{ _s1 | attr_str }}\">{{ _s1 | e }}|{% if _s1 | truthy %}T{% else %}F{% endif %}</main>".into(),
    );
    let loaded = Manifest::from_parts(&json, &files).unwrap();
    let cfg = CoreConfig {
        l1_capacity: 16,
        job_cache_capacity: 16,
        ..Default::default()
    };
    let host = TestHost {
        clock: ManualClock::default(),
        slot,
        calls: AtomicUsize::new(0),
    };
    Core::new(host, loaded, cfg).unwrap()
}

fn get(core: &Core<TestHost>, path: &str) -> String {
    let headers = HeaderMap::new();
    let rq = RequestHead {
        method: "GET",
        full: path,
        headers: &headers,
        authority: None,
    };
    let r = block_on(core.handle(rq, ()));
    assert_eq!(r.status(), 200, "{path}");
    let body = String::from_utf8(r.body().to_vec()).unwrap();
    let at = body.find("<main").unwrap();
    body[at..body.find("</main>").unwrap() + 7].to_string()
}

#[test]
fn tagged_slots_render_as_js_prints_them_fresh_and_from_the_job_cache() {
    let tag = brust_jinja::ctx::JS_TAG;
    for (t, want) in [
        ("NaN", "<main title=\"NaN\">NaN|F</main>"),
        ("Infinity", "<main title=\"Infinity\">Infinity|T</main>"),
        ("-Infinity", "<main title=\"-Infinity\">-Infinity|T</main>"),
        ("10n", "<main title=\"10\">10|T</main>"),
        ("0n", "<main title=\"0\">0|F</main>"),
    ] {
        let core = core_with(serde_json::json!({ tag: t }));
        assert_eq!(get(&core, "/pokemon/a"), want, "{t}");
        // Another page (no page-cache hit), same job inputs: the job is not called again; the cached value is decoded.
        assert_eq!(get(&core, "/pokemon/b"), want, "{t} cached");
        assert_eq!(core.host.calls.load(Ordering::SeqCst), 1, "{t}");
    }
    // An escaped app object is its own object again (never read as a tag).
    let core = core_with(serde_json::json!({ tag: { "o": { tag: "NaN" } } }));
    assert!(!get(&core, "/pokemon/a").contains(">NaN|"));
}
