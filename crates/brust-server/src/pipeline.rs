//! The native half of the request pipeline: the hyper adapter in front of
//! `brust_core::pipeline::handle`, and the worker-thread half of a planned loader call
//! (`plan_in_call`), which reads the claimed SAB slot.
use brust_core::host::RequestHead;
use brust_core::pipeline::plan_response;
use brust_core::plan::PlanCell;
use http::{Request, Response};
use hyper::body::Incoming;

use crate::config::Server;
use crate::server::body::{ResponseBody, bytes_body};

/// The hyper adapter: the request head as the core reads it, the core's answer with its body
/// boxed once.
pub(crate) async fn handle(req: Request<Incoming>, server: &Server) -> Response<ResponseBody> {
    let (parts, incoming) = req.into_parts();
    let rq = RequestHead {
        method: parts.method.as_str(),
        full: parts
            .uri
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or_else(|| parts.uri.path()),
        headers: &parts.headers,
        authority: parts.uri.authority().map(|a| a.as_str()),
    };
    server.core.handle(rq, incoming).await.map(bytes_body)
}

/// `planJobs` answer: not planned — the worker keeps its loader response in the slot and `page`
/// plans after the call (the two-call path). Never a valid `JobsRequest` JSON.
pub const PLAN_DECLINED: &str = "!";

/// The worker-thread half of a planned call (napi `planJobs(slot, len)`). Runs on the
/// worker's JS thread, synchronously inside its call for `slot`. Never panics out, never errs:
/// every failure is [`PLAN_DECLINED`] and leaves no plan behind.
pub fn plan_in_call(s: &Server, worker: u32, slot: u32, len: u32) -> String {
    plan_claimed(s, worker, slot, |entry| {
        let (ptr, cap) = entry.dispatch.buf_slot(slot);
        if len == 0 || len as usize > cap {
            return None;
        }
        // SAFETY: we run on the worker's JS thread, synchronously inside its call for `slot` (the
        // slot is claimed: `plan_claimed` found it): the worker wrote these `len` bytes on this
        // thread just before calling `planJobs`, and nothing else writes a claimed slot. `len` is
        // bounds-checked against the slot's capacity above.
        Some(unsafe { std::slice::from_raw_parts(ptr, len as usize) })
    })
}

/// L10: [`plan_in_call`] for a loader response too large for the slot (napi `planJobsBuf(slot,
/// buf)`): the worker hands the bytes over directly. Declines (like any failure) when `buf` is
/// empty or over `max_loader_response_bytes`.
pub fn plan_in_call_buf(s: &Server, worker: u32, slot: u32, buf: &[u8]) -> String {
    if buf.is_empty() || buf.len() > s.core.host.max_loader_response_bytes {
        return PLAN_DECLINED.to_string();
    }
    plan_claimed(s, worker, slot, |_| Some(buf))
}

/// The shared body of the two planning entry points: `bytes` yields the loader response.
fn plan_claimed<'a>(
    s: &Server,
    worker: u32,
    slot: u32,
    bytes: impl FnOnce(&crate::pool::WorkerEntry) -> Option<&'a [u8]>,
) -> String {
    let declined = || PLAN_DECLINED.to_string();
    let s = &s.core;
    let Some(entry) = s.host.pool.entry(worker) else {
        return declined();
    };
    let Some(cell) = entry.claimed_plan_cell(slot) else {
        return declined();
    };
    // Take the seed: from here on every decline leaves the cell empty.
    let taken = cell.lock().take();
    let seed = match taken.map(|b| b.downcast::<PlanCell>()) {
        Some(Ok(b)) => match *b {
            PlanCell::Seed(seed) => seed,
            PlanCell::Planned(_) => return declined(),
        },
        _ => return declined(),
    };
    let Some(bytes) = bytes(&entry) else {
        return declined();
    };
    let Some(route) = s.manifest.routes.get(seed.route) else {
        return declined();
    };
    let planned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        plan_response(&s.plans, &s.jobs, route, seed.base, bytes)
    }));
    match planned {
        Ok(Some((plan, misses))) => {
            *cell.lock() = Some(Box::new(PlanCell::Planned(plan)));
            entry.stamp_jobs_phase(slot);
            misses
        }
        _ => declined(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use brust_core::manifest::{Manifest, RouteRecord};
    use brust_core::pipeline::{
        CHILDREN_KEY, OWN_KEY, PlanIndex, collect_jobs, jobs_request, merge_loader_data,
        plan_stage, rehydrate,
    };
    use brust_core::plan::PlanSeed;
    use brust_jinja::ctx::{MapInner, Node};
    use serde_json::{Value, json};

    use crate::cache::job_cache::JobCache;

    fn n(v: Value) -> Node {
        Node::from(v)
    }

    fn j(n: &Node) -> Value {
        Value::from(n)
    }

    fn manifest() -> Manifest {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist");
        Manifest::load(&dir).expect("fixture manifest").manifest
    }

    fn pikachu() -> Node {
        n(json!({"pokemon": {"name": "pikachu", "stats": {"hp": 35},
                "moves": [{"name": "tackle"}, {"name": "growl"}]}}))
    }

    /// The pokedex fixture (bench `benches/fixtures/pokedex/`): every plan's
    /// call id, job key, user key and inputs, and the all-miss `JobsRequest`
    /// JSON, equal the golden computed before the m2p plan-template work
    /// (`BRUST_WRITE_PLAN_GOLDEN=1` rewrites it); and seeding + merging each
    /// plan's value rebuilds the captured merged context exactly.
    fn golden_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("benches/fixtures/pokedex")
    }

    /// The pokedex golden's manifest and, for `file`, the captured merged context
    /// and the loader context `page` plans over (the merged one minus the overlays).
    fn golden_ctx(file: &str) -> (Manifest, Node, Node) {
        let dir = golden_dir();
        let m: Manifest =
            serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        let merged: Value =
            serde_json::from_slice(&std::fs::read(dir.join("ctx").join(file)).unwrap()).unwrap();
        let merged = Node::from(merged);
        let mut ctx = merged.clone();
        for k in [OWN_KEY, CHILDREN_KEY] {
            ctx.map_mut().unwrap().remove(k);
        }
        (m, ctx, merged)
    }

    const GOLDEN_CASES: [(&str, &str); 3] = [
        ("/pokemon/{name}", "pokemon-pikachu.json"),
        ("/", "home.json"),
        ("/type-chart", "type-chart.json"),
    ];

    #[test]
    fn pokedex_plans_match_the_golden() {
        use plan_stage::Planner;
        let dir = golden_dir();
        let mut got = serde_json::Map::new();
        for (pattern, file) in GOLDEN_CASES {
            let (m, mut ctx, merged) = golden_ctx(file);
            let planner = Planner::new(&m).unwrap();
            let route = m.routes.iter().find(|r| r.pattern == pattern).unwrap();
            let plans = planner.plan(&route.chain, &ctx).unwrap();
            got.insert(
                file.into(),
                json!({"plans": plans.describe(), "request": plans.request_json()}),
            );
            let cache = JobCache::new(1024);
            plans.warm(&cache, &merged);
            let values = plans.lookup(&cache);
            assert!(
                values.iter().all(Option::is_some),
                "{file}: every plan hits"
            );
            planner.seed(&route.id, &route.chain, &mut ctx).unwrap();
            plans.merge(&mut ctx, &values);
            assert_eq!(ctx, merged, "{file}: seed + merge rebuild the captured ctx");
        }
        let got = Value::Object(got);
        let golden = dir.join("plan-golden.json");
        if std::env::var_os("BRUST_WRITE_PLAN_GOLDEN").is_some() {
            std::fs::write(&golden, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
        }
        let want: Value = serde_json::from_slice(&std::fs::read(&golden).unwrap()).unwrap();
        assert_eq!(got, want);
    }

    // ----- (4+5) the planned loader call (M3-P P6) -----

    /// The context `page` builds before the loader call for `/pokemon/<name>`.
    fn base(name: &str) -> MapInner {
        let mut m = MapInner::new();
        m.insert(
            "params".into(),
            Node::map([(Arc::from("name"), Node::str(name))].into_iter().collect()),
        );
        m.insert("path".into(), Node::str(&format!("/pokemon/{name}")));
        m
    }

    fn r2(m: &Manifest) -> &RouteRecord {
        m.routes.iter().find(|r| r.id == "r2").unwrap()
    }

    const PIKACHU: &[u8] = br#"{"ok":true,"data":{"pokemon":{"name":"pikachu","stats":{"hp":35},"moves":[{"name":"tackle"},{"name":"growl"}]}},"headers":{"x-a":"1"}}"#;

    #[test]
    fn plan_response_plans_like_page_and_returns_the_misses_request() {
        let m = manifest();
        let idx = PlanIndex::new(&m).unwrap();
        let cache = JobCache::new(64);
        let (pc, misses) = plan_response(&idx, &cache, r2(&m), base("pikachu"), PIKACHU).unwrap();
        // Same ctx and plans as the declined path: merge_loader_data + collect_jobs over it.
        let mut want = base("pikachu");
        merge_loader_data(&mut want, pikachu(), "r2");
        let want = Node::map(want);
        assert_eq!(pc.ctx, want);
        let plans = collect_jobs(&idx, &r2(&m).chain, &want).unwrap();
        assert_eq!(
            misses,
            serde_json::to_string(&jobs_request(&plans, &[0, 1, 2])).unwrap()
        );
        assert_eq!(
            pc.call_ids,
            [
                "detailPage_c3/j0",
                "detailPage_c3/moveCard_d4_1/j0/0",
                "detailPage_c3/moveCard_d4_1/j0/1"
            ]
        );
        assert_eq!(pc.lookup.misses, [0, 1, 2]);
        assert_eq!(pc.lookup.owner, [0, 1, 2]);
        assert!(pc.lookup.values.iter().all(Option::is_none));
        assert_eq!(pc.headers.get("x-a").map(String::as_str), Some("1"));
        // The owned rows rehydrate to the plans the declined path collects.
        let back = rehydrate(&idx, pc.rows);
        assert_eq!(back.len(), plans.len());
        for (b, p) in back.iter().zip(&plans) {
            assert_eq!((b.src, &b.key, b.call_id()), (p.src, &p.key, p.call_id()));
        }
    }

    #[test]
    fn plan_response_pins_hits_and_answers_empty_when_all_hit() {
        let m = manifest();
        let idx = PlanIndex::new(&m).unwrap();
        let cache = JobCache::new(64);
        let mut want = base("pikachu");
        merge_loader_data(&mut want, pikachu(), "r2");
        let plans = collect_jobs(&idx, &r2(&m).chain, &Node::map(want)).unwrap();
        for (i, p) in plans.iter().enumerate() {
            let v = Arc::new(n(json!({ "_s1": i })));
            cache.insert(
                p.key.clone(),
                v,
                p.ttl,
                p.tags,
                p.user_key.as_deref(),
                cache.read_stamp(),
            );
        }
        let (pc, misses) = plan_response(&idx, &cache, r2(&m), base("pikachu"), PIKACHU).unwrap();
        assert_eq!(misses, "");
        assert!(pc.call_ids.is_empty());
        assert!(pc.lookup.misses.is_empty());
        assert!(pc.lookup.values.iter().all(Option::is_some));
        // An invalidation after planning leaves the pinned values in the plan.
        assert_eq!(cache.invalidate_tags(&["moves".to_string()]), 2);
        assert!(cache.get(&plans[1].key).is_none());
        for (i, v) in pc.lookup.values.iter().enumerate() {
            assert_eq!(j(v.as_ref().unwrap()), json!({ "_s1": i }));
        }
    }

    #[test]
    fn plan_response_dedupes_identical_keys_like_lookup_jobs() {
        let m = manifest();
        let idx = PlanIndex::new(&m).unwrap();
        let cache = JobCache::new(64);
        let twice = br#"{"ok":true,"data":{"pokemon":{"name":"p","stats":{"hp":1},"moves":[{"name":"tackle"},{"name":"tackle"}]}}}"#;
        let (pc, misses) = plan_response(&idx, &cache, r2(&m), base("p"), twice).unwrap();
        assert_eq!(pc.lookup.owner, [0, 1, 1]);
        assert_eq!(pc.lookup.misses, [0, 1]);
        assert_eq!(pc.rows.len(), 3);
        assert_eq!(
            pc.call_ids,
            ["detailPage_c3/j0", "detailPage_c3/moveCard_d4_1/j0/0"]
        );
        let req: Value = serde_json::from_str(&misses).unwrap();
        assert_eq!(req["jobs"].as_array().unwrap().len(), 2);
        assert!(pc.headers.is_empty());
    }

    #[test]
    fn plan_response_declines_what_is_not_ok_data() {
        let m = manifest();
        let idx = PlanIndex::new(&m).unwrap();
        let cache = JobCache::new(8);
        for bad in [
            &br#"{"verdict":"notFound","data":{}}"#[..],
            br#"{"verdict":"redirect","location":"/x","status":302}"#,
            br#"{"error":"x"}"#,
            br#"{"ok":false,"data":{}}"#,
            br#"{"planned":true,"results":[]}"#,
            br#"{"error":"response too large: 300000 > 262144"}"#,
            b"not json",
            b"",
        ] {
            assert!(
                plan_response(&idx, &cache, r2(&m), base("p"), bad).is_none(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        // A planning error declines too (`page` meets it after the call: 500, "job planning
        // failed"): a chain naming a component the index does not know.
        let mut broken = r2(&m).clone();
        broken.chain.push("unknown_zz".into());
        assert!(plan_response(&idx, &cache, &broken, base("p"), PIKACHU).is_none());
    }

    /// A server on the fixture `dist/` with one `MockDispatch` worker of one slot.
    fn plan_server() -> (Arc<Server>, u32) {
        let s = crate::server::start(crate::Config {
            addr: "127.0.0.1:0".parse().unwrap(),
            dist_dir: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist"),
            ..Default::default()
        })
        .expect("start");
        let id = s.register_worker(Box::new(crate::dispatch::MockDispatch::with_slots(1)));
        (s, id)
    }

    fn claim(s: &Server) -> crate::pool::RenderClaim {
        match s.core.host.pool.try_claim_render_lockfree() {
            crate::pool::ClaimResult::Claimed(c) => c,
            _ => panic!("no claim"),
        }
    }

    fn seed(s: &Server, name: &str) -> crate::pool::PlanBox {
        let route = s
            .core
            .manifest
            .routes
            .iter()
            .position(|r| r.id == "r2")
            .unwrap();
        Box::new(PlanCell::Seed(PlanSeed {
            route,
            base: base(name),
        }))
    }

    /// Copy `bytes` into the claimed slot, as the worker's `writeSlot` does.
    fn write_slot(c: &crate::pool::RenderClaim, bytes: &[u8]) -> u32 {
        let (dst, cap) = c.entry().dispatch.buf_slot(c.slot());
        assert!(bytes.len() <= cap);
        // SAFETY: the claimed slot's in-bounds sub-region of the mock's leaked buffer.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len()) };
        bytes.len() as u32
    }

    #[test]
    fn plan_in_call_declines_an_idle_slot_a_missing_seed_and_a_len_outside_the_slot() {
        let (s, id) = plan_server();
        // Idle slot: nobody holds it, so no plan may be read or written.
        assert_eq!(plan_in_call(&s, id, 0, PIKACHU.len() as u32), PLAN_DECLINED);
        let c = claim(&s);
        let len = write_slot(&c, PIKACHU);
        // Unknown worker, slot out of range.
        assert_eq!(plan_in_call(&s, id + 1, 0, len), PLAN_DECLINED);
        assert_eq!(plan_in_call(&s, id, 1, len), PLAN_DECLINED);
        // Claimed, but no seed was put (a call `page` did not offer a plan for).
        assert_eq!(plan_in_call(&s, id, 0, len), PLAN_DECLINED);
        assert!(c.take_plan().is_none());
        // A seed, but a length outside the slot (or empty): declined, the seed is gone.
        let (_, cap) = c.entry().dispatch.buf_slot(0);
        for bad in [cap as u32 + 1, 0] {
            c.put_plan(seed(&s, "pikachu"));
            assert_eq!(plan_in_call(&s, id, 0, bad), PLAN_DECLINED);
            assert!(c.take_plan().is_none(), "len {bad}");
        }
        // A seed and bytes that are not `{ ok: true, data }`: declined, no plan left.
        c.put_plan(seed(&s, "pikachu"));
        let len = write_slot(&c, br#"{"verdict":"notFound","data":{}}"#);
        assert_eq!(plan_in_call(&s, id, 0, len), PLAN_DECLINED);
        assert!(c.take_plan().is_none());
        // A second planJobs in the same call finds a plan, not a seed: declined.
        c.put_plan(seed(&s, "pikachu"));
        let len = write_slot(&c, PIKACHU);
        assert_ne!(plan_in_call(&s, id, 0, len), PLAN_DECLINED);
        assert_eq!(plan_in_call(&s, id, 0, len), PLAN_DECLINED);
        assert!(c.take_plan().is_none());
        drop(c);
        assert_eq!(s.stats().job_calls, 0);
    }

    #[test]
    fn plan_in_call_stores_the_plan_and_returns_the_misses() {
        let (s, id) = plan_server();
        let c = claim(&s);
        c.put_plan(seed(&s, "pikachu"));
        let len = write_slot(&c, PIKACHU);
        let got = plan_in_call(&s, id, c.slot(), len);
        let mut want = base("pikachu");
        merge_loader_data(&mut want, pikachu(), "r2");
        let plans =
            collect_jobs(&s.core.plans, &r2(&s.core.manifest).chain, &Node::map(want)).unwrap();
        assert_eq!(
            got,
            serde_json::to_string(&jobs_request(&plans, &[0, 1, 2])).unwrap()
        );
        let cell = c
            .take_plan()
            .expect("a plan")
            .downcast::<PlanCell>()
            .unwrap();
        let PlanCell::Planned(pc) = *cell else {
            panic!("expected a planned cell")
        };
        assert_eq!(pc.rows.len(), 3);
        assert_eq!(pc.lookup.misses, [0, 1, 2]);
        assert!(c.take_plan().is_none(), "taken once");
        // The claim's drop leaves the slot idle and the cell empty.
        c.put_plan(seed(&s, "pikachu"));
        drop(c);
        let e = s.core.host.pool.entry(id).unwrap();
        assert!(e.slot(0).is_idle());
        assert!(e.claimed_plan_cell(0).is_none());
        assert!(e.slot(0).plan.lock().is_none());
    }
}
