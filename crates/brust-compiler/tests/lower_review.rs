//! Regressions from the pre-READY review of the M1c lane: each test pins one
//! shape that used to lower to wrong or broken output.
mod lower_common;
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use lower_common::lower;
use std::path::PathBuf;

/// (id, jinja, chunk) of every compiled component, root first.
fn tree_in(name: &str, files: &[(&str, &str)]) -> Vec<(String, String, Option<String>)> {
    let dir = std::env::temp_dir().join(format!("brustc-m1c-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (p, t) in files {
        let f = dir.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, t).unwrap();
    }
    run_on_compiler_thread(move || {
        compile_tree(
            "P.tsx",
            None,
            &AnalyzeOptions {
                root: dir,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .into_iter()
        .map(|l| (l.ir.id.clone(), l.artifacts.jinja, l.artifacts.client_js))
        .collect()
    })
}

fn render(jinja: &str, ctx: serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, minijinja::Value::from_serialize(ctx))
        .unwrap()
}

const STATE: &str = "import { useState, useEffect } from 'react'\n";

/// Finding 1: a static child that a parent links still gets its chunk.
#[test]
fn a_linked_static_child_gets_a_chunk() {
    let t = tree_in(
        "linked",
        &[
            (
                "Badge.tsx",
                "export default function Badge({ n }: any) { return <b>{n}</b> }",
            ),
            (
                "P.tsx",
                "import { useState } from 'react'\nimport Badge from './Badge'\nexport default function P() { const [n, setN] = useState(1); return <div onClick={() => setN(n + 1)}><Badge n={n} /></div> }",
            ),
        ],
    );
    let badge = t.iter().find(|c| c.0.starts_with("badge_")).unwrap();
    let chunk = badge.2.as_ref().expect("linked static child has a chunk");
    assert!(
        chunk.contains("const _c1 = computed(() => __text(props().n))"),
        "{chunk}"
    );
    assert!(
        t[0].1.contains("x-props-bind=\"_p1\" x-text=\"_c1\""),
        "{}",
        t[0].1
    );
}

/// Finding 2: `{children}` is markup in both the instance and the child's own
/// chunk, so member numbers agree.
#[test]
fn children_markup_does_not_shift_member_numbers() {
    let t = tree_in(
        "children",
        &[
            (
                "Box.tsx",
                "import { useState } from 'react'\nexport default function Box({ children, label }: any) { const [n, setN] = useState(0); return <div>{children}<b>{label}</b><button onClick={() => setN(n + 1)}>{n}</button></div> }",
            ),
            (
                "P.tsx",
                "import Box from './Box'\nexport default function P({ t }: any) { return <main><Box label={t}><i>hi</i></Box></main> }",
            ),
        ],
    );
    let boxc = t.iter().find(|c| c.0.starts_with("box_")).unwrap();
    let chunk = boxc.2.as_ref().unwrap();
    assert!(!chunk.contains("children"), "{chunk}");
    assert!(
        chunk.contains("const _c1 = computed(() => __text(props().label))"),
        "{chunk}"
    );
    assert!(t[0].1.contains("<i>hi</i><b x-text=\"_c1\">"), "{}", t[0].1);
    assert!(
        t[0].1
            .contains("<button x-on-click=\"_h1\" x-text=\"_c2\">"),
        "{}",
        t[0].1
    );
}

/// Finding 3: a prop read in a row without x-for gets no item binding.
#[test]
fn prop_reads_in_static_rows_have_no_bindings() {
    let a = lower(&format!(
        "{STATE}export default function T({{ items, base }}: any) {{ const [n, setN] = useState(0); return <div onClick={{() => setN(1)}}>{{n}}{{items.map((p: any) => <a key={{p.slug}} href={{`${{base}}/${{p.slug}}`}}>x</a>)}}</div> }}"
    ));
    assert!(!a.jinja.contains(":p\""), "{}", a.jinja);
}

/// Finding 4: a key reading the index falls back to item identity.
#[test]
fn index_keys_fall_back_to_item_identity() {
    let a = lower(&format!(
        "{STATE}export default function T({{ items }}: any) {{ const [n, setN] = useState(0); return <ul>{{items.map((x: any, i: number) => <li key={{i}} onClick={{() => setN(i)}}>{{x}}</li>)}}</ul> }}"
    ));
    let c = a.client_js.unwrap();
    assert!(c.contains("const _k1 = (x) => x"), "{c}");
    assert!(a.diagnostics.iter().any(|d| d.rule == "key-not-item"));
}

/// Finding 5: destructuring defaults apply on the server, in the job and on
/// the client.
#[test]
fn prop_defaults_apply_everywhere() {
    let a = lower(&format!(
        "{STATE}import {{ fmt }} from './money'\nexport default function T({{ size = 3 }}: any) {{ const [n, setN] = useState(0); return <p onClick={{() => setN(1)}}>{{size * 2}}{{fmt(size)}}{{n}}</p> }}"
    ));
    assert!(
        render(&a.jinja, serde_json::json!({ "_s1": "x" })).contains(">6</span>"),
        "{}",
        a.jinja
    );
    assert!(a.server_ts.unwrap().contains("const { size = 3 } = props"));
    assert!(
        a.client_js
            .unwrap()
            .contains("(props()[\"size\"] === undefined ? 3 : props()[\"size\"])")
    );
}

/// Finding 8: a slot in a branch is evaluated only when the branch renders.
#[test]
fn job_slots_in_branches_are_guarded() {
    let job = lower(
        "import { fmt } from './money'\nexport default function G({ user }: any) { return <div>{user && <b>{fmt(user.balance)}</b>}</div> }",
    )
    .server_ts
    .unwrap();
    assert!(
        job.contains("_s1: ((user) ? fmt(user.balance) : undefined)"),
        "{job}"
    );
}

/// Finding 9: an effect with deps re-runs on the deps only.
#[test]
fn effect_deps_are_honoured() {
    let c = lower(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(0); useEffect(() => {{ setN(n + 1) }}, []); return <b>{{n}}</b> }}"
    ))
    .client_js
    .unwrap();
    assert!(
        c.contains("__effect(() => { void []; return untracked(() =>"),
        "{c}"
    );
}

/// Finding 10: hidden copies reuse island outputs.
#[test]
fn hidden_copies_reuse_island_outputs() {
    let a = lower(&format!(
        "{STATE}import Reviews from '../react-child/Reviews'\nexport default function T() {{ const [o, setO] = useState(true); return <div onClick={{() => setO(!o)}}>{{o && <section><Reviews productId=\"a\" /></section>}}<Reviews productId=\"b\" /></div> }}"
    ));
    assert!(a.jinja.contains("_ssr_reviews_ec5de4c5_2"), "{}", a.jinja);
    assert!(!a.jinja.contains("_ssr_reviews_ec5de4c5_3"), "{}", a.jinja);
}

/// Finding 11: `x?.length` on a missing value renders empty, not an error.
#[test]
fn optional_length_on_missing_value() {
    let a =
        lower("export default function T({ items }: any) { return <p>{items?.length ?? 0}</p> }");
    assert!(
        render(&a.jinja, serde_json::json!({})).contains("<p>0</p>"),
        "{}",
        a.jinja
    );
}

/// Finding 12: SVG attribute case, range inputs, reserved context names.
#[test]
fn svg_names_range_inputs_and_reserved_names() {
    let a = lower(&format!(
        "{STATE}export default function T() {{ const [v, setV] = useState(1); const ref = 2; return <div><svg viewBox=\"0 0 1 1\" strokeWidth={{2}} /><input type=\"range\" onChange={{(e) => setV(e.target.value)}} />{{v + ref}}</div> }}"
    ));
    assert!(
        a.jinja.contains("viewBox=") && a.jinja.contains("stroke-width="),
        "{}",
        a.jinja
    );
    assert!(a.jinja.contains("x-on-input="), "{}", a.jinja);
    let c = a.client_js.unwrap();
    assert!(c.contains("ref: __ref"), "{c}");
}

#[allow(dead_code)]
fn _unused(_: PathBuf) {}
