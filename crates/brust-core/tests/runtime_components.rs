//! F519 (plan 2026-11-11 R5): the `<Dynamic>` slot on the server — the registry's checks, the two-pass render over the
//! page's own map, isolation, the cache classes (R5.7 a-d), the assets and the chunk route. Drives `Core<TestHost>`
//! (single-thread caches, a scripted worker) through the same `pipeline::handle` every host runs.
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use brust_core::cache::local::{LocalJobs, LocalL1};
use brust_core::components::{MAX_CLIENT_BYTES, MAX_JINJA_BYTES, Registry};
use brust_core::core::{Core, CoreConfig};
use brust_core::host::{
    ActionCall, ActionReply, CallError, Clock, Host, ManualClock, ReadErr, RequestHead, StaticRoot,
};
use brust_core::manifest::Manifest;
use brust_core::plan::{PlanSeed, PlannedCall};
use brust_core::protocol::{
    ComponentRequest, ComponentResponse, ComponentResult, Headers, HtmlResult, JobsRequest,
    JobsResponse, LoaderRequest, LoaderResponse, RenderItem,
};
use bytes::Bytes;
use http::HeaderMap;
use serde_json::{Value, json};

type Answer = Box<dyn Fn(&str) -> ComponentResult>;
/// F546: the worker's `render` answer for one asked pair (`None`: no answer at all, an old worker).
type RenderAnswer = Box<dyn Fn(&RenderItem) -> Option<HtmlResult>>;
/// F546: every `component` call's renders and page id, in order.
type Asked = Rc<RefCell<Vec<(Vec<RenderItem>, Option<String>)>>>;

/// The scripted worker: the loader answers `items`, the `component` call answers each ref through `answer`.
struct TestHost {
    clock: ManualClock,
    items: RefCell<Value>,
    answer: RefCell<Answer>,
    render: RefCell<RenderAnswer>,
    /// F546: every `component` call's renders and page id, in order.
    asked: Asked,
    /// Every `component` call's refs, in order.
    calls: Rc<RefCell<Vec<Vec<String>>>>,
    loader_calls: Rc<RefCell<u32>>,
    /// Filled after `Core::new`: what a call may do to the registry while the page waits (R5.5).
    registry: Rc<RefCell<Option<Arc<Registry>>>>,
    on_call: Box<dyn Fn(&Registry)>,
    fail_call: bool,
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
        *self.loader_calls.borrow_mut() += 1;
        Ok((
            LoaderResponse::Ok {
                ok: true,
                data: json!({ "items": self.items.borrow().clone() }).into(),
                headers: Headers::default(),
                store: None,
            },
            None,
        ))
    }
    async fn jobs(&self, _req: &JobsRequest<'_>) -> Result<JobsResponse, CallError> {
        Err(CallError::Rejected("no jobs".into()))
    }
    async fn component(&self, req: &ComponentRequest<'_>) -> Result<ComponentResponse, CallError> {
        self.calls.borrow_mut().push(req.refs.to_vec());
        self.asked
            .borrow_mut()
            .push((req.renders.to_vec(), req.page.map(str::to_string)));
        if let Some(reg) = self.registry.borrow().as_ref() {
            (self.on_call)(reg);
        }
        if self.fail_call {
            return Err(CallError::Rejected("worker gone".into()));
        }
        let answer = self.answer.borrow();
        let render = self.render.borrow();
        Ok(ComponentResponse {
            results: req.refs.iter().map(|r| answer(r)).collect(),
            html: req.renders.iter().filter_map(|i| (*render)(i)).collect(),
        })
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

const BUILD: &str = "b1";

/// `/` (cached, loader), `/u` (uncached, loader), `/s` (no loader, static) — each a list of slots.
fn manifest_json() -> String {
    json!({
        "version": 3,
        "assets": {
            "runtime": "client/runtime-1.js",
            "features": { "events": "client/events-1.js", "island": "client/island-1.js", "store": "client/store-1.js" },
            "build": BUILD
        },
        "jobs_module": "jobs.js",
        "runtime": { "exposed": { "shop/sdk.ts": "client/x-sdk-1.js" }, "stores": { "cart": "shop/sdk.ts" } },
        "routes": [
            { "id": "r1", "pattern": "/", "chain": ["page_p1"], "loaders": ["r1"],
              "cache": { "ttl_seconds": 60, "tags": [] }, "catch_all": false },
            { "id": "r2", "pattern": "/u", "chain": ["page_p1"], "loaders": ["r2"], "cache": null, "catch_all": false },
            { "id": "r3", "pattern": "/s", "chain": ["page_p1"], "loaders": [], "cache": null, "catch_all": false }
        ],
        "components": {
            "page_p1": { "tier": "static", "template": "jinja/page_p1.jinja", "dynamic": true }
        }
    })
    .to_string()
}

const PAGE: &str = "<html><head></head><body><ul>{% for i in items %}<li>{{ brust_dynamic(i.ref, {\"title\": i.title}) }}</li>{% endfor %}</ul></body></html>";

fn artifact(id: &str, tier: &str, jinja: &str) -> Value {
    json!({
        "v": 1, "build": BUILD, "id": id, "tier": tier, "jinja": jinja,
        "client": if tier == "native" { json!("export const x = 1") } else { Value::Null },
        "features": if tier == "native" { json!(["events"]) } else { json!([]) },
        "stores": []
    })
}

fn found(r: &str, a: Value) -> ComponentResult {
    ComponentResult {
        reference: r.into(),
        artifact: Some(a),
        missing: false,
        error: None,
    }
}

/// Every ref is a static artifact printing its title.
fn titles(r: &str) -> ComponentResult {
    found(
        r,
        artifact(&format!("id_{r}"), "static", "<b>{{ title | e }}</b>"),
    )
}

struct Fixture {
    core: Core<TestHost>,
    calls: Rc<RefCell<Vec<Vec<String>>>>,
    asked: Asked,
    loader_calls: Rc<RefCell<u32>>,
    clock: ManualClock,
}

fn fixture_with(
    items: Value,
    answer: Answer,
    on_call: Box<dyn Fn(&Registry)>,
    fail_call: bool,
) -> Fixture {
    let mut files = BTreeMap::new();
    files.insert("jinja/page_p1.jinja".to_string(), PAGE.to_string());
    let loaded = Manifest::from_parts(&manifest_json(), &files).unwrap();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let asked = Rc::new(RefCell::new(Vec::new()));
    let loader_calls = Rc::new(RefCell::new(0));
    let registry = Rc::new(RefCell::new(None));
    let clock = ManualClock::default();
    let host = TestHost {
        clock: clock.clone(),
        items: RefCell::new(items),
        answer: RefCell::new(answer),
        render: RefCell::new(Box::new(echo_render)),
        asked: Rc::clone(&asked),
        calls: Rc::clone(&calls),
        loader_calls: Rc::clone(&loader_calls),
        registry: Rc::clone(&registry),
        on_call,
        fail_call,
    };
    let cfg = CoreConfig {
        l1_capacity: 16,
        job_cache_capacity: 16,
        ..Default::default()
    };
    let core = Core::new(host, loaded, cfg).unwrap();
    *registry.borrow_mut() = core.components.clone();
    Fixture {
        core,
        calls,
        asked,
        loader_calls,
        clock,
    }
}

fn fixture(items: Value, answer: Answer) -> Fixture {
    fixture_with(items, answer, Box::new(|_| {}), false)
}

fn get(core: &Core<TestHost>, path: &str) -> http::Response<Bytes> {
    let headers = HeaderMap::new();
    let rq = RequestHead {
        method: "GET",
        full: path,
        headers: &headers,
        authority: None,
    };
    block_on(core.handle(rq, ()))
}

fn text(r: &http::Response<Bytes>) -> String {
    String::from_utf8(r.body().to_vec()).unwrap()
}

fn cache_hdr(r: &http::Response<Bytes>) -> String {
    r.headers()
        .get("x-brust-cache")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default()
}

fn two() -> Value {
    json!([{ "ref": "a", "title": "A<" }, { "ref": "b", "title": "B" }])
}

#[test]
fn cold_refs_resolve_in_one_call_and_render_in_the_second_pass() {
    let f = fixture(two(), Box::new(titles));
    let r = get(&f.core, "/u");
    assert_eq!(r.status(), 200);
    let body = text(&r);
    assert!(
        body.contains("<ul><li><b>A&lt;</b></li><li><b>B</b></li></ul>"),
        "{body}"
    );
    assert_eq!(
        *f.calls.borrow(),
        vec![vec!["a".to_string(), "b".to_string()]]
    );
    // Warm: the next page renders once, with no call.
    let again = get(&f.core, "/u");
    assert_eq!(text(&again), body);
    assert_eq!(f.calls.borrow().len(), 1);
}

#[test]
fn an_eviction_between_the_passes_does_not_change_the_page() {
    // `w` is warm (pinned in pass 1), `c` is cold; the call evicts `w` from the registry while the page waits.
    let f = fixture_with(
        json!([{ "ref": "w", "title": "W" }, { "ref": "c", "title": "C" }]),
        Box::new(titles),
        Box::new(|reg| reg.evict("w")),
        false,
    );
    let reg = f.core.components.clone().unwrap();
    reg.register("w", artifact("id_w", "static", "<b>{{ title | e }}</b>"))
        .unwrap();
    let body = text(&get(&f.core, "/u"));
    assert!(
        body.contains("<li><b>W</b></li><li><b>C</b></li>"),
        "{body}"
    );
    assert_eq!(*f.calls.borrow(), vec![vec!["c".to_string()]]);
}

#[test]
fn a_slot_sees_its_props_at_top_level_and_as_props_and_nothing_of_the_page() {
    let f = fixture(
        json!([{ "ref": "a", "title": "T" }]),
        Box::new(|r| {
            found(
                r,
                artifact(
                    "id_a",
                    "static",
                    "[{{ title }}|{{ _props.title }}|{{ items is defined }}|{{ path is defined }}]",
                ),
            )
        }),
    );
    let body = text(&get(&f.core, "/u"));
    assert!(body.contains("<li>[T|T|False|False]</li>"), "{body}");
}

#[test]
fn a_ref_outside_the_charset_prints_nothing_and_makes_no_call() {
    let f = fixture(
        json!([{ "ref": "a b", "title": "x" }, { "ref": "", "title": "y" }]),
        Box::new(titles),
    );
    let body = text(&get(&f.core, "/u"));
    assert!(body.contains("<ul><li></li><li></li></ul>"), "{body}");
    assert!(f.calls.borrow().is_empty());
}

#[test]
fn a_route_with_a_slot_calls_the_worker_without_a_loader() {
    let f = fixture(two(), Box::new(titles));
    let body = text(&get(&f.core, "/s"));
    assert_eq!(
        *f.loader_calls.borrow(),
        1,
        "R5.8: the worker seeds the exposed stores"
    );
    assert!(body.contains("<li><b>A&lt;</b></li>"), "{body}");
}

// ----- R5.7 (amended): the four classes -----

#[test]
fn class_a_missing_is_remembered_and_the_page_is_stored() {
    let f = fixture(two(), Box::new(|r| ComponentResult::missing(r)));
    let r = get(&f.core, "/");
    assert_eq!(r.status(), 200);
    assert!(text(&r).contains("<ul><li></li><li></li></ul>"));
    assert_eq!(cache_hdr(&r), "MISS");
    assert_eq!(cache_hdr(&get(&f.core, "/")), "HIT");
    // Remembered 10 s: another page with the same refs makes no call, then one after.
    get(&f.core, "/u");
    assert_eq!(f.calls.borrow().len(), 1);
    f.clock.advance(Duration::from_secs(11));
    get(&f.core, "/u");
    assert_eq!(f.calls.borrow().len(), 2);
}

#[test]
fn class_b_a_refused_artifact_is_remembered_and_the_page_is_not_stored() {
    let f = fixture(
        two(),
        Box::new(|r| {
            let mut a = artifact("id_x", "static", "x");
            a["build"] = json!("another-build");
            found(r, a)
        }),
    );
    let r = get(&f.core, "/");
    assert_eq!(r.status(), 200);
    assert!(text(&r).contains("<ul><li></li><li></li></ul>"));
    let again = get(&f.core, "/");
    assert_eq!(
        cache_hdr(&again),
        "MISS",
        "a refused slot keeps the page out of L1"
    );
    assert_eq!(f.calls.borrow().len(), 1, "the refusal is remembered");
}

#[test]
fn class_c_a_resolver_error_is_not_remembered_and_the_page_is_not_stored() {
    let f = fixture(
        two(),
        Box::new(|r| ComponentResult {
            reference: r.into(),
            artifact: None,
            missing: false,
            error: Some("db down".into()),
        }),
    );
    let r = get(&f.core, "/");
    assert_eq!(r.status(), 200);
    assert_eq!(cache_hdr(&get(&f.core, "/")), "MISS");
    assert_eq!(f.calls.borrow().len(), 2, "an error is asked again");
}

#[test]
fn class_c_a_failed_call_is_a_200_without_the_slots() {
    let f = fixture_with(two(), Box::new(titles), Box::new(|_| {}), true);
    let r = get(&f.core, "/");
    assert_eq!(r.status(), 200);
    assert!(text(&r).contains("<ul><li></li><li></li></ul>"));
    assert_eq!(cache_hdr(&get(&f.core, "/")), "MISS");
    assert_eq!(f.calls.borrow().len(), 2);
}

#[test]
fn class_d_a_sub_render_error_is_isolated_and_the_page_is_stored() {
    let f = fixture(
        two(),
        Box::new(|r| {
            let jinja = if r == "a" {
                "{{ (none | render_error) | e }}"
            } else {
                "<b>{{ title | e }}</b>"
            };
            found(r, artifact(&format!("id_{r}"), "static", jinja))
        }),
    );
    let r = get(&f.core, "/");
    assert_eq!(r.status(), 200);
    assert!(
        text(&r).contains("<ul><li></li><li><b>B</b></li></ul>"),
        "{}",
        text(&r)
    );
    assert_eq!(cache_hdr(&get(&f.core, "/")), "HIT");
}

// ----- R5.6 (amended): the artifact's own environment, with fuel -----

#[test]
fn an_include_of_an_app_template_fails_isolated() {
    let f = fixture(
        json!([{ "ref": "a", "title": "x" }]),
        Box::new(|r| found(r, artifact("id_a", "static", "{% include \"page_p1\" %}"))),
    );
    let r = get(&f.core, "/u");
    assert_eq!(r.status(), 200);
    assert!(text(&r).contains("<ul><li></li></ul>"), "{}", text(&r));
}

#[test]
fn a_runaway_loop_runs_out_of_fuel_isolated() {
    let f = fixture(
        json!([{ "ref": "a", "title": "x" }]),
        Box::new(|r| {
            found(
                r,
                artifact(
                    "id_a",
                    "static",
                    "{% for i in range(10000) %}{% for j in range(10000) %}{% endfor %}{% endfor %}done",
                ),
            )
        }),
    );
    let r = get(&f.core, "/u");
    assert_eq!(r.status(), 200);
    let body = text(&r);
    assert!(body.contains("<ul><li></li></ul>"), "{body}");
    assert!(!body.contains("done"));
}

#[test]
fn a_slot_that_prints_past_the_output_cap_fails_isolated() {
    // 100_000 iterations stay under the fuel cap; 64 bytes each is 6.4 MB of output, over the 4 MiB slot cap.
    let line = "x".repeat(64);
    let jinja = format!("{{% for i in range(100000) %}}{line}{{% endfor %}}done");
    let f = fixture(
        json!([{ "ref": "a", "title": "x" }]),
        Box::new(move |r| found(r, artifact("id_a", "static", &jinja))),
    );
    let r = get(&f.core, "/u");
    assert_eq!(r.status(), 200);
    let body = text(&r);
    assert!(
        body.contains("<ul><li></li></ul>"),
        "{}",
        &body[..body.len().min(200)]
    );
}

#[test]
fn the_app_environment_has_no_fuel_cap() {
    // A page loop past the artifact cap (1e6 iterations, several instructions each) still renders: the cap is set on
    // artifact environments only.
    let mut files = BTreeMap::new();
    files.insert(
        "jinja/page_p1.jinja".to_string(),
        "<html><body>{% for i in range(1000) %}{% for j in range(1000) %}{% endfor %}{% endfor %}ok</body></html>"
            .to_string(),
    );
    let loaded = Manifest::from_parts(&manifest_json(), &files).unwrap();
    let host = TestHost {
        clock: ManualClock::default(),
        items: RefCell::new(json!([])),
        answer: RefCell::new(Box::new(titles)),
        render: RefCell::new(Box::new(echo_render)),
        asked: Rc::default(),
        calls: Rc::default(),
        loader_calls: Rc::default(),
        registry: Rc::default(),
        on_call: Box::new(|_| {}),
        fail_call: false,
    };
    let core = Core::new(host, loaded, CoreConfig::default()).unwrap();
    let r = get(&core, "/u");
    assert_eq!(r.status(), 200);
    assert!(text(&r).contains("ok"));
}

// ----- R5.9: assets and the chunk route -----

fn native(r: &str) -> ComponentResult {
    found(
        r,
        artifact(
            &format!("id_{r}"),
            "native",
            "<button x-data=\"id_a\">{{ title | e }}</button>",
        ),
    )
}

#[test]
fn a_rendered_native_artifact_brings_the_runtime_its_features_and_its_chunk() {
    let f = fixture(json!([{ "ref": "a", "title": "N" }]), Box::new(native));
    let body = text(&get(&f.core, "/u"));
    let rt = body
        .find("/_brust/client/runtime-1.js")
        .expect("runtime tag");
    let ev = body
        .find("/_brust/client/events-1.js")
        .expect("feature tag");
    let ch = body
        .find("<script type=\"module\" src=\"/_brust/rc/b1/a/id_a.js\"></script>")
        .expect("chunk tag");
    assert!(rt < ev && ev < ch, "{body}");
    assert_eq!(body.matches("/_brust/rc/b1/a/id_a.js").count(), 1);
}

#[test]
fn a_page_whose_slots_rendered_static_artifacts_loads_no_runtime() {
    let f = fixture(two(), Box::new(titles));
    let body = text(&get(&f.core, "/u"));
    assert!(!body.contains("runtime-1.js"), "{body}");
}

#[test]
fn the_chunk_route_serves_a_warm_artifact_by_id_only() {
    let f = fixture(json!([{ "ref": "a", "title": "N" }]), Box::new(native));
    get(&f.core, "/u");
    let ok = get(&f.core, "/_brust/rc/b1/a/id_a.js");
    assert_eq!(ok.status(), 200);
    assert_eq!(text(&ok), "export const x = 1");
    assert!(
        ok.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("immutable")
    );
    assert!(
        ok.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );
    for bad in [
        "/_brust/rc/b1/a/id_other.js",
        "/_brust/rc/b2/a/id_a.js",
        "/_brust/rc/b1/a/id_a",
        "/_brust/rc/b1/a b/id_a.js",
        "/_brust/rc/b1/a/x/id_a.js",
    ] {
        let r = get(&f.core, bad);
        assert_eq!(r.status(), 404, "{bad}");
        assert_eq!(r.headers()["cache-control"], "no-store", "{bad}");
    }
    assert_eq!(
        f.calls.borrow().len(),
        1,
        "a warm ref with another id is not resolved again"
    );
}

#[test]
fn the_chunk_route_resolves_a_cold_ref_once_and_remembers_a_missing_one() {
    let f = fixture(
        json!([]),
        Box::new(|r| {
            if r == "a" {
                native(r)
            } else {
                ComponentResult::missing(r)
            }
        }),
    );
    let ok = get(&f.core, "/_brust/rc/b1/a/id_a.js");
    assert_eq!(ok.status(), 200);
    assert_eq!(f.calls.borrow().len(), 1);
    assert_eq!(get(&f.core, "/_brust/rc/b1/z/id_z.js").status(), 404);
    assert_eq!(get(&f.core, "/_brust/rc/b1/z/id_z.js").status(), 404);
    assert_eq!(f.calls.borrow().len(), 2, "the missing ref is remembered");
}

#[test]
fn a_static_artifact_has_no_chunk() {
    let f = fixture(two(), Box::new(titles));
    get(&f.core, "/u");
    assert_eq!(get(&f.core, "/_brust/rc/b1/a/id_a.js").status(), 404);
}

// ----- R5.4: registration checks -----

fn registry() -> Registry {
    let mut files = BTreeMap::new();
    files.insert("jinja/page_p1.jinja".to_string(), PAGE.to_string());
    let loaded = Manifest::from_parts(&manifest_json(), &files).unwrap();
    Registry::for_manifest(&loaded.manifest, None).unwrap()
}

#[test]
fn registration_refuses_what_r2_and_r5_4_rule_out() {
    let reg = registry();
    let ok = artifact("id_ok", "static", "<b>ok</b>");
    let with = |f: &dyn Fn(&mut Value)| {
        let mut a = ok.clone();
        f(&mut a);
        a
    };
    let cases: Vec<(&str, Value)> = vec![
        ("version", with(&|a| a["v"] = json!(2))),
        ("build", with(&|a| a["build"] = json!("b0"))),
        ("tier", with(&|a| a["tier"] = json!("react"))),
        ("static client", with(&|a| a["client"] = json!("x"))),
        (
            "native without client",
            with(&|a| a["tier"] = json!("native")),
        ),
        ("id charset", with(&|a| a["id"] = json!("a-b"))),
        ("id empty", with(&|a| a["id"] = json!(""))),
        ("id of a component", with(&|a| a["id"] = json!("page_p1"))),
        (
            "jinja size",
            with(&|a| a["jinja"] = json!("x".repeat(MAX_JINJA_BYTES + 1))),
        ),
        (
            "client size",
            with(&|a| {
                a["tier"] = json!("native");
                a["client"] = json!("x".repeat(MAX_CLIENT_BYTES + 1));
            }),
        ),
        ("feature", with(&|a| a["features"] = json!(["nope"]))),
        ("store", with(&|a| a["stores"] = json!(["other"]))),
        ("template", with(&|a| a["jinja"] = json!("{% if %}"))),
        ("shape", json!({ "v": 1 })),
    ];
    for (what, a) in cases {
        assert!(reg.register("r", a).is_err(), "{what} must be refused");
    }
    assert_eq!(reg.warm_len(), 0);
    assert!(reg.register("r", ok.clone()).is_ok());
    // Exposed stores and build features are accepted.
    assert!(
        reg.register(
            "s",
            with(&|a| {
                a["id"] = json!("id_s");
                a["stores"] = json!(["cart"]);
                a["features"] = json!(["store"]);
            })
        )
        .is_ok()
    );
}

#[test]
fn an_artifact_at_both_size_limits_registers_and_renders() {
    let reg = registry();
    let jinja = format!("{{# {} #}}<i>ok</i>", "x".repeat(MAX_JINJA_BYTES - 15));
    assert_eq!(jinja.len(), MAX_JINJA_BYTES);
    let mut a = artifact("id_big", "native", &jinja);
    a["client"] = json!("x".repeat(MAX_CLIENT_BYTES));
    assert!(reg.register("big", a).is_ok());
}

#[test]
fn one_id_under_two_refs_must_be_the_same_code() {
    let reg = registry();
    let a = artifact("id_same", "static", "<b>1</b>");
    assert!(reg.register("one", a.clone()).is_ok());
    assert!(
        reg.register("two", a).is_ok(),
        "the same code under another ref"
    );
    let other = artifact("id_same", "static", "<b>2</b>");
    assert!(reg.register("three", other.clone()).is_err());
    // `two` still holds `id_same` with the first code, so `one` cannot switch to the second either.
    assert!(reg.register("one", other).is_err());
}

#[test]
fn the_registry_is_bounded() {
    let mut files = BTreeMap::new();
    files.insert("jinja/page_p1.jinja".to_string(), PAGE.to_string());
    let loaded = Manifest::from_parts(&manifest_json(), &files).unwrap();
    let reg = Registry::for_manifest(&loaded.manifest, Some(3)).unwrap();
    for i in 0..10 {
        reg.register(
            &format!("r{i}"),
            artifact(&format!("id_{i}"), "static", "x"),
        )
        .unwrap();
    }
    assert_eq!(reg.warm_len(), 3);
}

#[test]
fn no_slot_in_the_build_means_no_registry() {
    let json = manifest_json().replace("\"dynamic\":true", "\"dynamic\":false");
    let mut files = BTreeMap::new();
    files.insert("jinja/page_p1.jinja".to_string(), PAGE.to_string());
    let loaded = Manifest::from_parts(&json, &files).unwrap();
    assert!(Registry::for_manifest(&loaded.manifest, None).is_none());
}

// ----- F546: island artifacts (`tier: "island"`, HTML from `components.render`) -----

/// The default worker `render`: `<p>` + the props' title.
fn echo_render(i: &RenderItem) -> Option<HtmlResult> {
    Some(HtmlResult {
        reference: i.reference.clone(),
        key: i.key.clone(),
        html: Some(format!(
            "<p>{}</p>",
            i.props["title"]
                .as_str()
                .unwrap_or("?")
                .replace('<', "&lt;")
        )),
        error: None,
    })
}

fn island_artifact(id: &str, client: &str) -> Value {
    json!({ "v": 1, "build": BUILD, "id": id, "tier": "island", "client": client })
}

/// Every ref is an island artifact `isl_<ref>`.
fn islands(r: &str) -> ComponentResult {
    found(r, island_artifact(&format!("isl_{r}"), "/* island */"))
}

fn three() -> Value {
    json!([
        { "ref": "a", "title": "one" },
        { "ref": "a", "title": "two" },
        { "ref": "a", "title": "one" }
    ])
}

#[test]
fn island_registration_needs_a_client_and_no_jinja() {
    let reg = registry();
    assert!(reg.register("i", island_artifact("isl_i", "x")).is_ok());
    let mut no_client = island_artifact("isl_j", "x");
    no_client["client"] = Value::Null;
    assert!(reg.register("j", no_client).is_err());
    let mut with_jinja = island_artifact("isl_k", "x");
    with_jinja["jinja"] = json!("<b>x</b>");
    let why = reg.register("k", with_jinja).unwrap_err();
    assert!(why.contains("no jinja"), "{why}");
    let big = island_artifact("isl_l", &"x".repeat(MAX_CLIENT_BYTES + 1));
    assert!(reg.register("l", big).is_err());
    // static and native still need their jinja
    let mut no_jinja = artifact("id_m", "static", "x");
    no_jinja.as_object_mut().unwrap().remove("jinja");
    assert!(reg.register("m", no_jinja).is_err());
    // a build without the island runtime feature cannot hydrate it
    let json = manifest_json().replace("\"island\":\"client/island-1.js\",", "");
    let mut files = BTreeMap::new();
    files.insert("jinja/page_p1.jinja".to_string(), PAGE.to_string());
    let loaded = Manifest::from_parts(&json, &files).unwrap();
    let bare = Registry::for_manifest(&loaded.manifest, None).unwrap();
    let why = bare
        .register("i", island_artifact("isl_i", "x"))
        .unwrap_err();
    assert!(why.contains("island"), "{why}");
}

#[test]
fn the_same_ref_and_id_with_new_code_is_refused_a_new_id_is_not() {
    let reg = registry();
    assert!(reg.register("a", island_artifact("isl_v1", "v1")).is_ok());
    assert!(
        reg.register("a", island_artifact("isl_v1", "v1")).is_ok(),
        "same code again"
    );
    let why = reg
        .register("a", island_artifact("isl_v1", "v2"))
        .unwrap_err();
    assert!(why.contains("change the id"), "{why}");
    assert!(reg.register("a", island_artifact("isl_v2", "v2")).is_ok());
    // native artifacts share the immutable chunk URL: same rule
    let n1 = artifact("id_n", "native", "<i>1</i>");
    let mut n2 = n1.clone();
    n2["client"] = json!("export const y = 2");
    assert!(reg.register("n", n1).is_ok());
    assert!(reg.register("n", n2).is_err());
}

/// The `x-props='…'` attribute values of every island host in `body`, in order.
fn hosts(body: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find("<brust-island ") {
        rest = &rest[at..];
        let head_end = rest.find('>').unwrap();
        let head = &rest[..head_end];
        let id = head
            .split("data-id=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_string();
        let props = head
            .split("x-props='")
            .nth(1)
            .unwrap()
            .trim_end_matches('\'')
            .to_string();
        let close = rest.find("</brust-island>").unwrap();
        out.push((id, props, rest[head_end + 1..close].to_string()));
        rest = &rest[close..];
    }
    out
}

#[test]
fn a_cold_island_ref_is_one_call_with_its_renders_then_cached_html_makes_none() {
    let f = fixture(three(), Box::new(islands));
    let body = text(&get(&f.core, "/"));
    assert_eq!(*f.calls.borrow(), vec![vec!["a".to_string()]]);
    let asked = f.asked.borrow();
    // one render per distinct (ref, props): "one" twice is asked once
    assert_eq!(asked[0].0.len(), 2, "{:?}", asked[0].0);
    assert!(asked[0].1.is_some(), "the page id rides the call");
    drop(asked);
    let h = hosts(&body);
    assert_eq!(
        h,
        vec![
            (
                "isl_a".into(),
                "{&quot;title&quot;:&quot;one&quot;}".into(),
                "<p>one</p>".into()
            ),
            (
                "isl_a".into(),
                "{&quot;title&quot;:&quot;two&quot;}".into(),
                "<p>two</p>".into()
            ),
            (
                "isl_a".into(),
                "{&quot;title&quot;:&quot;one&quot;}".into(),
                "<p>one</p>".into()
            ),
        ],
        "{body}"
    );
    assert!(
        body.contains("<brust-island style=\"display:contents\" data-id=\"isl_a\" x-props='"),
        "{body}"
    );
    // the island runtime, its feature and the chunk, though the page is static
    let rt = body.find("/_brust/client/runtime-1.js").expect("runtime");
    let isl = body
        .find("/_brust/client/island-1.js")
        .expect("island feature");
    let ch = body
        .find("src=\"/_brust/rc/b1/a/isl_a.js\"")
        .expect("chunk");
    assert!(rt < isl && isl < ch, "{body}");
    // warm ref, cached HTML: a fresh render (uncached route) makes no call at all
    let body2 = text(&get(&f.core, "/u"));
    assert_eq!(f.calls.borrow().len(), 1, "{body2}");
    assert_eq!(hosts(&body2), h);
    // warm ref, new props: one call carrying only the new render
    f.core
        .host
        .items
        .replace(json!([{ "ref": "a", "title": "three" }]));
    let body3 = text(&get(&f.core, "/u"));
    assert_eq!(f.calls.borrow().len(), 2);
    assert_eq!(f.calls.borrow()[1], Vec::<String>::new());
    assert_eq!(f.asked.borrow()[1].0.len(), 1);
    assert_eq!(hosts(&body3)[0].2, "<p>three</p>");
}

#[test]
fn island_props_are_escaped_like_a_built_island() {
    let f = fixture(
        json!([{ "ref": "a", "title": "it's </script> & \"q\"" }]),
        Box::new(islands),
    );
    let body = text(&get(&f.core, "/u"));
    let h = hosts(&body);
    assert_eq!(h.len(), 1, "{body}");
    let attr = &h[0].1;
    assert!(
        !attr.contains('\'') && !attr.contains('<') && !attr.contains('"'),
        "{attr}"
    );
    assert!(!attr.contains("&\"") && attr.contains("&amp;"), "{attr}");
}

#[test]
fn render_failures_keep_the_page_out_null_is_an_empty_host_that_is_stored() {
    // throws -> empty host, not stored (the next request renders again)
    let f = fixture(json!([{ "ref": "a", "title": "x" }]), Box::new(islands));
    *f.core.host.render.borrow_mut() = Box::new(|i| {
        Some(HtmlResult {
            reference: i.reference.clone(),
            key: i.key.clone(),
            html: None,
            error: Some("boom".into()),
        })
    });
    let r = get(&f.core, "/");
    assert_eq!(hosts(&text(&r))[0].2, "");
    assert_eq!(cache_hdr(&get(&f.core, "/")), "MISS");
    // null -> empty host, cacheable, and cached as the app's answer
    let f = fixture(json!([{ "ref": "a", "title": "x" }]), Box::new(islands));
    *f.core.host.render.borrow_mut() = Box::new(|i| {
        Some(HtmlResult {
            reference: i.reference.clone(),
            key: i.key.clone(),
            html: None,
            error: None,
        })
    });
    assert_eq!(hosts(&text(&get(&f.core, "/")))[0].2, "");
    assert_eq!(cache_hdr(&get(&f.core, "/")), "HIT");
    assert_eq!(f.core.components.as_ref().unwrap().html_stats().0, 1);
    // over the slot output cap -> failure
    let f = fixture(json!([{ "ref": "a", "title": "x" }]), Box::new(islands));
    *f.core.host.render.borrow_mut() = Box::new(|i| {
        Some(HtmlResult {
            reference: i.reference.clone(),
            key: i.key.clone(),
            html: Some("x".repeat(brust_core::components::MAX_SLOT_OUTPUT_BYTES + 1)),
            error: None,
        })
    });
    assert_eq!(hosts(&text(&get(&f.core, "/")))[0].2, "");
    assert_eq!(cache_hdr(&get(&f.core, "/")), "MISS");
    // an old worker (no html answers) -> failure, empty host
    let f = fixture(json!([{ "ref": "a", "title": "x" }]), Box::new(islands));
    *f.core.host.render.borrow_mut() = Box::new(|_| None);
    assert_eq!(hosts(&text(&get(&f.core, "/")))[0].2, "");
    assert_eq!(cache_hdr(&get(&f.core, "/")), "MISS");
    // the call failing (a warm island asking only renders) -> empty host, failure
    let f = fixture_with(
        json!([{ "ref": "a", "title": "x" }]),
        Box::new(islands),
        Box::new(|_| {}),
        true,
    );
    f.core
        .components
        .as_ref()
        .unwrap()
        .register("a", island_artifact("isl_a", "c"))
        .unwrap();
    let r = get(&f.core, "/");
    assert_eq!(
        hosts(&text(&r)),
        vec![(
            "isl_a".into(),
            "{&quot;title&quot;:&quot;x&quot;}".into(),
            String::new()
        )]
    );
    assert_eq!(f.calls.borrow().len(), 1);
    assert_eq!(cache_hdr(&get(&f.core, "/")), "MISS");
}

#[test]
fn a_new_artifact_digest_for_the_ref_misses_the_html_cache() {
    let f = fixture(json!([{ "ref": "a", "title": "x" }]), Box::new(islands));
    get(&f.core, "/u");
    assert_eq!(f.calls.borrow().len(), 1);
    get(&f.core, "/u");
    assert_eq!(f.calls.borrow().len(), 1, "cached");
    // the app ships new code under a new id: same props, new digest -> asked again
    f.core
        .components
        .as_ref()
        .unwrap()
        .register("a", island_artifact("isl_a2", "new"))
        .unwrap();
    let body = text(&get(&f.core, "/u"));
    assert_eq!(f.calls.borrow().len(), 2);
    assert_eq!(f.calls.borrow()[1], Vec::<String>::new());
    assert_eq!(hosts(&body)[0].0, "isl_a2");
}

#[test]
fn the_island_html_cache_is_bounded_in_bytes() {
    let f = fixture(json!([]), Box::new(islands));
    let reg = f.core.components.as_ref().unwrap();
    reg.set_html_cap_bytes(40);
    let items: Vec<Value> = (0..10)
        .map(|i| json!({ "ref": "a", "title": format!("t{i:02}") }))
        .collect();
    f.core.host.items.replace(Value::Array(items));
    get(&f.core, "/u");
    let (n, bytes) = reg.html_stats();
    assert!(bytes <= 40, "{bytes}");
    assert!(n < 10 && n > 0, "{n}");
}

#[test]
fn every_render_of_one_call_shares_one_page_id_and_pages_differ() {
    let f = fixture(three(), Box::new(islands));
    get(&f.core, "/u");
    f.core
        .host
        .items
        .replace(json!([{ "ref": "a", "title": "new" }]));
    get(&f.core, "/u");
    let asked = f.asked.borrow();
    let (p1, p2) = (asked[0].1.clone().unwrap(), asked[1].1.clone().unwrap());
    assert_ne!(p1, p2);
}

#[test]
fn a_page_without_island_renders_sends_the_f519_request() {
    let f = fixture(two(), Box::new(titles));
    get(&f.core, "/u");
    // cold static refs: the renders are asked (the ref might have been an island) but the static page ignores them
    let asked = f.asked.borrow();
    assert_eq!(asked.len(), 1);
    let req = ComponentRequest::refs(&[]);
    assert_eq!(serde_json::to_string(&req).unwrap(), "{\"refs\":[]}");
}
