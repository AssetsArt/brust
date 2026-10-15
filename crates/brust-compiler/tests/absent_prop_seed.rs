//! F234: the `x-props` seed of a native child leaves out a prop the call site omits or passes as `undefined`, so the
//! chunk's destructuring default applies as in React; an explicit `null` stays null. A member-read object prop that is
//! absent stays absent (never a `{}`). Served: `tests/server/absent-prop-seed.chromium.test.ts`.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// The page's jinja rendered like the server (no props).
fn rendered() -> String {
    run_on_compiler_thread(|| {
        let tree = compile_tree(
            "tests/fixtures/shadcn/repro/absent-prop-page.tsx",
            None,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let mut env = minijinja::Environment::new();
        brust_jinja::register(&mut env);
        // Slots the per-request jobs fill: any value; the seed does not read them.
        let mut ctx = serde_json::json!({ "_props": {} });
        for l in &tree {
            for k in 1..=8 {
                ctx[format!("__{}_{k}", l.ir.id)] = serde_json::json!({ "_s1": "" });
            }
        }
        env.render_str(&tree[0].artifacts.jinja, brust_jinja::value_of(ctx))
            .unwrap()
    })
}

/// The decoded `x-props` of the element with `data-testid="<id>"`.
fn seed(html: &str, id: &str) -> serde_json::Value {
    let at = html.find(&format!("data-testid=\"{id}\"")).expect(id);
    let open = html[..at].rfind('<').unwrap();
    let tag = &html[open..at];
    let s = tag.find("x-props='").expect("x-props") + "x-props='".len();
    let json = &tag[s..s + tag[s..].find('\'').unwrap()];
    serde_json::from_str(&json.replace("&quot;", "\"").replace("&amp;", "&")).unwrap()
}

#[test]
fn an_omitted_or_undefined_prop_is_left_out_of_the_seed() {
    let html = rendered();
    for id in ["omitted", "undef"] {
        let s = seed(&html, id);
        assert!(s.get("defaultOpen").is_none(), "{id}: {s}");
        assert_eq!(s["id"], id);
    }
}

#[test]
fn an_explicit_null_stays_null_and_a_value_stays_given() {
    let html = rendered();
    assert_eq!(seed(&html, "null")["defaultOpen"], serde_json::Value::Null);
    assert_eq!(seed(&html, "true")["defaultOpen"], true);
}

#[test]
fn an_absent_object_prop_read_by_member_stays_absent() {
    let s = seed(&rendered(), "who");
    assert!(s.get("user").is_none(), "{s}");
}

#[test]
fn a_linked_prop_seeds_its_server_value() {
    let s = seed(&rendered(), "show");
    assert_eq!(s["v"], "set");
    assert_eq!(s["user"]["name"], "ann");
}
