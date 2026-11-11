//! F529 D9 + A2: a WebSocket upgrade under the actions prefix is a GET with `Upgrade: websocket`, judged like a
//! mutation under `cross_site = "reject"`; the worker's 101 reply leaves core as a 101 carrying a `WsAccepted`
//! extension. Drives `Core<TestHost>` (the same `pipeline::handle` every host shares) with a host whose app answers
//! a fixed `fetch` reply.
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::pin::pin;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};

use brust_core::cache::local::{LocalJobs, LocalL1};
use brust_core::config::{ActionsConfig, CorsConfig, CrossSite};
use brust_core::core::{Core, CoreConfig};
use brust_core::host::{
    ActionCall, ActionReply, CallError, Clock, Host, ManualClock, ReadErr, RequestHead, StaticRoot,
};
use brust_core::manifest::Manifest;
use brust_core::plan::{PlanSeed, PlannedCall};
use brust_core::protocol::{
    FetchResponse, JobsRequest, JobsResponse, LoaderRequest, LoaderResponse, WsAccept, WsAccepted,
};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue};

/// The "app": answers every action call with `reply`, and counts how many reached it.
#[derive(Default)]
struct TestHost {
    clock: ManualClock,
    reply: Mutex<Option<FetchResponse>>,
    calls: Mutex<u32>,
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
        *self.calls.lock().unwrap() += 1;
        Ok(ActionReply::Fetch(
            self.reply.lock().unwrap().clone().expect("a reply"),
        ))
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

const WS: &str = "/_brust/action/chat";
const ORIGIN: &str = "https://evil.example";

fn core_with(mode: CrossSite, cors: Option<CorsConfig>, reply: FetchResponse) -> Core<TestHost> {
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
    let host = TestHost::default();
    *host.reply.lock().unwrap() = Some(reply);
    let cfg = CoreConfig {
        l1_capacity: 16,
        job_cache_capacity: 16,
        cors,
        actions: Some(ActionsConfig {
            cross_site: mode,
            ..Default::default()
        }),
        ..Default::default()
    };
    Core::new(host, loaded, cfg).unwrap()
}

fn ok_reply() -> FetchResponse {
    FetchResponse {
        status: 200,
        headers: vec![],
        body: Bytes::from_static(b"plain"),
        ws: None,
    }
}

fn accept(id: u32) -> WsAccept {
    WsAccept {
        id,
        max_payload: None,
        idle_timeout: None,
        backpressure_limit: None,
        close_on_backpressure_limit: None,
        publish_to_self: None,
        send_pings: None,
    }
}

fn upgrade_reply() -> FetchResponse {
    FetchResponse {
        status: 101,
        headers: vec![
            ("set-cookie".into(), "sid=1".into()),
            ("upgrade".into(), "websocket".into()),
            ("connection".into(), "Upgrade".into()),
            ("Sec-WebSocket-Accept".into(), "forged".into()),
        ],
        body: Bytes::from_static(b"ignored"),
        ws: Some(WsAccept {
            max_payload: Some(512),
            send_pings: Some(true),
            ..accept(9)
        }),
    }
}

fn upgrade_headers(origin: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("host", HeaderValue::from_static("app.example"));
    h.insert("upgrade", HeaderValue::from_static("WebSocket"));
    h.insert("connection", HeaderValue::from_static("Upgrade"));
    if let Some(o) = origin {
        h.insert("origin", HeaderValue::from_str(o).unwrap());
    }
    h
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

fn calls(core: &Core<TestHost>) -> u32 {
    *core.host.calls.lock().unwrap()
}

fn cors(origins: &[&str]) -> Option<CorsConfig> {
    Some(CorsConfig {
        origins: origins.iter().map(|s| s.to_string()).collect(),
        methods: None,
        headers: None,
        expose_headers: None,
        credentials: false,
        max_age_seconds: None,
    })
}

#[test]
fn a_foreign_origin_upgrade_is_403_before_the_worker_is_called() {
    let core = core_with(CrossSite::Reject, None, upgrade_reply());
    let r = get(&core, WS, &upgrade_headers(Some(ORIGIN)));
    assert_eq!(r.status(), 403);
    let b = std::str::from_utf8(r.body()).unwrap();
    assert!(b.contains("CrossSiteRejected"), "{b}");
    assert!(b.contains("WebSocket upgrade"), "{b}");
    assert_eq!(calls(&core), 0);
    assert!(r.extensions().get::<WsAccepted>().is_none());
}

#[test]
fn sec_fetch_site_cross_site_without_origin_is_403() {
    let core = core_with(CrossSite::Reject, None, upgrade_reply());
    let mut h = upgrade_headers(None);
    h.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
    assert_eq!(get(&core, WS, &h).status(), 403);
    assert_eq!(calls(&core), 0);
}

#[test]
fn an_upgrade_without_an_origin_reaches_the_worker() {
    let core = core_with(CrossSite::Reject, None, upgrade_reply());
    let r = get(&core, WS, &upgrade_headers(None));
    assert_eq!(r.status(), 101);
    assert_eq!(calls(&core), 1);
}

#[test]
fn a_same_origin_upgrade_reaches_the_worker() {
    let core = core_with(CrossSite::Reject, None, upgrade_reply());
    let r = get(&core, WS, &upgrade_headers(Some("https://app.example")));
    assert_eq!(r.status(), 101);
    assert_eq!(calls(&core), 1);
}

#[test]
fn a_listed_cors_origin_upgrade_is_allowed_and_a_wildcard_is_not() {
    let listed = core_with(CrossSite::Reject, cors(&[ORIGIN]), upgrade_reply());
    assert_eq!(
        get(&listed, WS, &upgrade_headers(Some(ORIGIN))).status(),
        101
    );
    let other = core_with(
        CrossSite::Reject,
        cors(&["https://ok.example"]),
        upgrade_reply(),
    );
    assert_eq!(
        get(&other, WS, &upgrade_headers(Some(ORIGIN))).status(),
        403
    );
    let star = core_with(CrossSite::Reject, cors(&["*"]), upgrade_reply());
    assert_eq!(get(&star, WS, &upgrade_headers(Some(ORIGIN))).status(), 403);
}

#[test]
fn cross_site_allow_forwards_a_foreign_upgrade() {
    let core = core_with(CrossSite::Allow, None, upgrade_reply());
    assert_eq!(get(&core, WS, &upgrade_headers(Some(ORIGIN))).status(), 101);
}

#[test]
fn a_plain_get_with_a_foreign_origin_is_unchanged() {
    let core = core_with(CrossSite::Reject, None, ok_reply());
    let mut h = HeaderMap::new();
    h.insert("host", HeaderValue::from_static("app.example"));
    h.insert("origin", HeaderValue::from_static(ORIGIN));
    h.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
    let r = get(&core, WS, &h);
    assert_eq!(r.status(), 200);
    assert_eq!(r.body(), &Bytes::from_static(b"plain"));
    // `Upgrade: h2c` and a missing token list are not a WebSocket upgrade either
    h.insert("upgrade", HeaderValue::from_static("h2c"));
    assert_eq!(get(&core, WS, &h).status(), 200);
    assert_eq!(calls(&core), 2);
}

#[test]
fn the_upgrade_token_is_found_in_a_list_case_insensitively() {
    let core = core_with(CrossSite::Reject, None, upgrade_reply());
    let mut h = upgrade_headers(Some(ORIGIN));
    h.insert("upgrade", HeaderValue::from_static("h2c, WEBSOCKET"));
    assert_eq!(get(&core, WS, &h).status(), 403);
}

#[test]
fn a_101_carries_the_accept_as_an_extension_and_no_handshake_headers() {
    let core = core_with(CrossSite::Reject, None, upgrade_reply());
    let r = get(&core, WS, &upgrade_headers(None));
    assert_eq!(r.status(), 101);
    let w = r.extensions().get::<WsAccepted>().expect("WsAccepted");
    assert_eq!(w.worker_local_id, 9);
    assert_eq!(w.opts.max_payload, Some(512));
    assert_eq!(w.opts.send_pings, Some(true));
    assert_eq!(r.headers().get("set-cookie").unwrap(), "sid=1");
    // Rust owns the handshake: nothing the worker said about it survives
    for k in ["upgrade", "connection", "sec-websocket-accept"] {
        assert!(r.headers().get(k).is_none(), "{k}");
    }
    assert!(r.body().is_empty());
}

#[test]
fn a_101_without_a_ws_accept_is_500() {
    let reply = FetchResponse {
        ws: None,
        ..upgrade_reply()
    };
    let core = core_with(CrossSite::Reject, None, reply);
    let r = get(&core, WS, &upgrade_headers(None));
    assert_eq!(r.status(), 500);
    assert!(r.extensions().get::<WsAccepted>().is_none());
}

#[test]
fn a_ws_accept_on_another_status_is_ignored() {
    let reply = FetchResponse {
        status: 401,
        ..upgrade_reply()
    };
    let core = core_with(CrossSite::Reject, None, reply);
    let r = get(&core, WS, &upgrade_headers(None));
    assert_eq!(r.status(), 401);
    assert!(r.extensions().get::<WsAccepted>().is_none());
}
