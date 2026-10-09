//! React-tier SSR wire form (ruling cb881050, spec S6 amendments) against REAL
//! compiler output: `tests/fixtures/react/` holds `brustc --emit ir` (trimmed
//! to `id`/`tier`/`jobs`/`children`) and `--emit template` output of
//! `tests/fixtures/react/tsx/*.tsx`, compiled at v2 2f897a3. Each test builds a
//! `dist/` whose manifest `jobs[]` are the IR jobs copied as the build lane
//! does (`inputs`/`outputs` verbatim, `id` = `j<n>`, `kind` lowercased,
//! `target` = the react child the output names, `per_item` translated to the
//! list's context path).
mod common;

use std::path::Path;

use common::{FakeBun, boot_in, get};
use serde_json::{Value, json};

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/react")
}

fn ir(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(fixtures().join(format!("ir/{name}.json"))).unwrap())
        .unwrap()
}

/// The IR's jobs as manifest job records. `target`: the `ssr` output names
/// `_ssr_<childId>[_<k>]` (or the component's own id for its self-job);
/// `per_instance`: the caller's translation of `per_item`.
fn jobs_of(ir: &Value, per_instance: Option<&str>) -> Value {
    let own = ir["id"].as_str().unwrap();
    let mut ids: Vec<&str> = ir["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    ids.push(own);
    let jobs: Vec<Value> = ir["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(n, j)| {
            let ssr = j["kind"].get("Ssr").is_some();
            let out = j["outputs"][0].as_str().unwrap();
            let target = ssr.then(|| {
                *ids.iter()
                    .find(|id| {
                        let base = format!("_ssr_{id}");
                        out == base || out.starts_with(&format!("{base}_"))
                    })
                    .expect("output names a known component")
            });
            json!({
                "id": format!("j{n}"),
                "kind": if ssr { "ssr" } else { "precompute" },
                "inputs": j["inputs"],
                "outputs": j["outputs"],
                "target": target,
                "per_instance": if j["per_item"].is_null() { Value::Null } else { json!(per_instance.expect("per_item needs a list path")) },
                "cache": {"key": null, "tags": [], "ttl_seconds": null}
            })
        })
        .collect();
    Value::Array(jobs)
}

fn record(tier: &str, id: &str, jobs: Value) -> Value {
    json!({"tier": tier, "template": format!("jinja/{id}.jinja"), "jobs": jobs,
           "children": [], "client": null, "needs_worker": true, "use_id_slots": 0})
}

/// A `dist/` with one route `pattern` → `chain` and the given component records.
fn dist(pattern: &str, chain: &[&str], components: Value) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("jinja")).unwrap();
    std::fs::create_dir_all(d.path().join("client")).unwrap();
    std::fs::write(d.path().join("client/runtime.js"), "").unwrap();
    for id in components.as_object().unwrap().keys() {
        std::fs::copy(
            fixtures().join(format!("jinja/{id}.jinja")),
            d.path().join(format!("jinja/{id}.jinja")),
        )
        .unwrap();
    }
    let m = json!({"version": 1,
        "routes": [{"id": "r1", "pattern": pattern, "chain": chain, "loaders": ["r1"], "cache": null, "catch_all": false}],
        "components": components,
        "assets": {"runtime": "client/runtime.js", "react": null},
        "jobs_module": "jobs.js"});
    std::fs::write(
        d.path().join("manifest.json"),
        serde_json::to_vec(&m).unwrap(),
    )
    .unwrap();
    d
}

const REVIEWS: &str = "reviews_71ee8d8c";

/// The react child's own record: island host, self-job `inputs: ["*"]`.
fn reviews_record() -> Value {
    record("react", REVIEWS, jobs_of(&ir("Reviews"), None))
}

/// A fake worker whose loader returns `data` and whose ssr job renders
/// `<i>{target}:{productId}</i>`; `productId` comes from the inputs the
/// server sent (`props` map / `*`), else from the parent-scope inputs (`a`,
/// `b`, `items[row].id`). Records every job call.
fn react_fake(data: Value) -> std::sync::Arc<FakeBun> {
    FakeBun::new(
        move |_| json!({"ok": true, "data": data.clone()}),
        |req: Value| {
            let results: Vec<Value> = req["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let i = &c["inputs"];
                    let pid = if let Some(p) = i.get("productId") {
                        p.clone()
                    } else if let Some(row) = c["row"].as_u64() {
                        i["items"][row as usize]["id"].clone()
                    } else {
                        i.as_object().unwrap().values().next().cloned().unwrap()
                    };
                    let html = format!(
                        "<i>{}:{}</i>",
                        c["target"].as_str().unwrap_or("?"),
                        pid.as_str().unwrap_or("?")
                    );
                    json!({"id": c["id"], "value": html})
                })
                .collect();
            json!({ "results": results })
        },
    )
}

fn calls(f: &FakeBun) -> Vec<Value> {
    f.last_jobs()
        .map_or(vec![], |r| r["jobs"].as_array().unwrap().clone())
}

/// `<Reviews productId={a}/><Reviews productId={b}/>`: two ssr jobs in the
/// PARENT's `jobs[]` (outputs `_ssr_<id>`, `_ssr_<id>_2`); each island prints
/// its own HTML, and `target` reaches the JobCall.
#[test]
fn react_child_used_twice_gets_two_islands() {
    let parent = "twiceReact_42d42134";
    let d = dist(
        "/",
        &[parent],
        json!({ parent: record("static", parent, jobs_of(&ir("twice-react"), None)), REVIEWS: reviews_record() }),
    );
    let f = react_fake(json!({"a": "p1", "b": "p2"}));
    let s = boot_in(f.clone(), d.path());
    let (st, _, b) = get(&s, "/", &[]);
    assert_eq!(st, 200, "{b}");
    assert!(
        b.contains(r#"x-props='{&quot;productId&quot;:&quot;p1&quot;}'><i>reviews_71ee8d8c:p1</i></brust-island>"#),
        "{b}"
    );
    assert!(
        b.contains(r#"x-props='{&quot;productId&quot;:&quot;p2&quot;}'><i>reviews_71ee8d8c:p2</i></brust-island>"#),
        "{b}"
    );
    let c = calls(&f);
    assert_eq!(c.len(), 2);
    for (call, input) in c.iter().zip([json!({"a": "p1"}), json!({"b": "p2"})]) {
        assert_eq!(call["target"], REVIEWS);
        assert_eq!(call["componentId"], parent);
        assert_eq!(call["kind"], "ssr");
        assert_eq!(call["inputs"], input, "parent-scope inputs as the IR emits");
        assert!(call.get("row").is_none());
    }

    // With a `props` map (v2 extension) the worker gets the child's props.
    let mut jobs = jobs_of(&ir("twice-react"), None);
    jobs[0]["props"] = json!({"productId": "a"});
    jobs[1]["props"] = json!({"productId": "b"});
    let d = dist(
        "/",
        &[parent],
        json!({ parent: record("static", parent, jobs), REVIEWS: reviews_record() }),
    );
    let f = react_fake(json!({"a": "p1", "b": "p2"}));
    let s = boot_in(f.clone(), d.path());
    let (st, _, b) = get(&s, "/", &[]);
    assert_eq!(st, 200, "{b}");
    assert!(
        b.contains("<i>reviews_71ee8d8c:p1</i>") && b.contains("<i>reviews_71ee8d8c:p2</i>"),
        "{b}"
    );
    let c = calls(&f);
    assert_eq!(c[0]["inputs"], json!({"productId": "p1"}));
    assert_eq!(c[1]["inputs"], json!({"productId": "p2"}));
}

/// `items.map(it => <li key={it.id}><Reviews productId={it.id}/></li>)`: one
/// `per_instance` ssr job; `outputs[0]` is an array indexed by row, which the
/// template reads as `_ssr_<id>[_i1]`.
#[test]
fn react_child_in_keyed_row_gets_its_own_html() {
    let parent = "rowReact_631ddf5f";
    let items = json!({"items": [{"id": "x"}, {"id": "y"}, {"id": "x"}]});
    let want = "<li><brust-island data-id=\"reviews_71ee8d8c\" x-props='{&quot;productId&quot;:&quot;x&quot;}'><i>reviews_71ee8d8c:x</i></brust-island></li>\
                <li><brust-island data-id=\"reviews_71ee8d8c\" x-props='{&quot;productId&quot;:&quot;y&quot;}'><i>reviews_71ee8d8c:y</i></brust-island></li>\
                <li><brust-island data-id=\"reviews_71ee8d8c\" x-props='{&quot;productId&quot;:&quot;x&quot;}'><i>reviews_71ee8d8c:x</i></brust-island></li>";

    // As the IR emits it: parent-scope inputs (`items`) + the row.
    let d = dist(
        "/",
        &[parent],
        json!({ parent: record("static", parent, jobs_of(&ir("row-react"), Some("items"))), REVIEWS: reviews_record() }),
    );
    let f = react_fake(items.clone());
    let s = boot_in(f.clone(), d.path());
    let (st, _, b) = get(&s, "/", &[]);
    assert_eq!(st, 200, "{b}");
    assert!(b.contains(want), "{b}");
    let c = calls(&f);
    let rows: Vec<&Value> = c.iter().map(|c| &c["row"]).collect();
    assert_eq!(rows, [&json!(0), &json!(1), &json!(2)]);
    assert!(c.iter().all(|c| c["target"] == REVIEWS));

    // With a `props` map each row sends `{productId}`; equal rows share one call.
    let mut jobs = jobs_of(&ir("row-react"), Some("items"));
    jobs[0]["props"] = json!({"productId": "items[idx].id"});
    let d = dist(
        "/",
        &[parent],
        json!({ parent: record("static", parent, jobs), REVIEWS: reviews_record() }),
    );
    let f = react_fake(items);
    let s = boot_in(f.clone(), d.path());
    let (st, _, b) = get(&s, "/", &[]);
    assert_eq!(st, 200, "{b}");
    assert!(b.contains(want), "{b}");
    let inputs: Vec<Value> = calls(&f).iter().map(|c| c["inputs"].clone()).collect();
    assert_eq!(
        inputs,
        [json!({"productId": "x"}), json!({"productId": "y"})]
    );
}

/// A react PAGE (chain entry) reads `inputs: ["*"]` = the whole loader
/// context: two params → two job keys and two HTMLs; the same param again is a
/// job-cache hit. Its island host prints `_props`.
#[test]
fn react_page_star_inputs_key_on_all_props() {
    let d = dist("/r/{id}", &[REVIEWS], json!({ REVIEWS: reviews_record() }));
    let f = FakeBun::new(
        |req: Value| json!({"ok": true, "data": {"productId": req["params"]["id"]}}),
        |req: Value| {
            let c = &req["jobs"][0];
            json!({"results": [{"id": c["id"], "value": format!("<i>{}</i>", c["inputs"]["productId"].as_str().unwrap())}]})
        },
    );
    let s = boot_in(f.clone(), d.path());
    for (path, pid, jobs_calls) in [("/r/p1", "p1", 1), ("/r/p2", "p2", 2), ("/r/p1", "p1", 2)] {
        let (st, _, b) = get(&s, path, &[]);
        assert_eq!(st, 200, "{b}");
        assert!(
            b.contains(&format!("><i>{pid}</i></brust-island>")),
            "{path}: {b}"
        );
        assert!(
            b.contains(&format!("&quot;productId&quot;:&quot;{pid}&quot;")),
            "{b}"
        );
        assert_eq!(f.counts().1, jobs_calls, "{path}");
    }
    let c = calls(&f);
    assert_eq!(c[0]["target"], REVIEWS);
    assert_eq!(
        c[0]["inputs"],
        json!({"params": {"id": "p2"}, "path": "/r/p2", "productId": "p2"})
    );
}

/// A client-only react page (`window` in render): the IR's self-job reads
/// `"*"`; the host prints the real props, never `null`.
#[test]
fn client_only_host_prints_real_props() {
    let id = "clientonly_bcdcff03";
    let d = dist(
        "/c",
        &[id],
        json!({ id: record("react", id, jobs_of(&ir("clientonly"), None)) }),
    );
    let f = FakeBun::new(
        |_| json!({"ok": true, "data": {"who": "w"}}),
        |req: Value| json!({"results": [{"id": req["jobs"][0]["id"], "value": ""}]}),
    );
    let s = boot_in(f.clone(), d.path());
    let (st, _, b) = get(&s, "/c", &[]);
    assert_eq!(st, 200, "{b}");
    assert!(
        b.contains(r#"<brust-island data-id="clientonly_bcdcff03" x-props='{&quot;params&quot;:{},&quot;path&quot;:&quot;/c&quot;,&quot;who&quot;:&quot;w&quot;}'></brust-island>"#),
        "{b}"
    );
    // `*` is every prop, not a key literally named "*".
    assert_eq!(
        calls(&f)[0]["inputs"],
        json!({"params": {}, "path": "/c", "who": "w"})
    );
}
