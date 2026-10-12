//! `dangerouslySetInnerHTML` on every tier: the reader keeps it as `Attr::InnerHtml`,
//! the printer writes it through the one raw sink (`html_raw`), and a reactive value
//! also gets `x-html`. Everything else the template paints stays `| e`.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// (jinja, client chunk, tier of the root).
fn lower(src: &str) -> (String, String, Tier) {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "tests/fixtures/parent-counter/T.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        (
            a.jinja.clone(),
            a.client_js.clone().unwrap_or_default(),
            tree[0].ir.tier.clone(),
        )
    })
}

fn render(jinja: &str, ctx: serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx))
        .unwrap()
        .trim()
        .to_string()
}

const STATE: &str = "import { useState } from 'react'\n";

#[test]
fn static_literal_renders_raw_inner_html() {
    let (j, c, tier) = lower(
        "export default function T() { return <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} /> }",
    );
    assert_eq!(tier, Tier::Static);
    assert!(c.is_empty(), "{c}");
    assert_eq!(render(&j, serde_json::json!({})), "<div><b>x</b></div>");
    assert!(!j.contains("x-html"), "{j}");
}

#[test]
fn null_undefined_and_number_values() {
    let (j, _, tier) = lower(
        "export default function T({ h }: any) { return <div dangerouslySetInnerHTML={{ __html: h }} /> }",
    );
    assert_eq!(tier, Tier::Static);
    assert_eq!(render(&j, serde_json::json!({ "h": null })), "<div></div>");
    assert_eq!(render(&j, serde_json::json!({})), "<div></div>");
    assert_eq!(render(&j, serde_json::json!({ "h": 7 })), "<div>7</div>");
    assert_eq!(
        render(&j, serde_json::json!({ "h": "<i>y</i>" })),
        "<div><i>y</i></div>"
    );
}

#[test]
fn identifier_shape_reads_dunder_html_and_tolerates_absence() {
    let (j, _, _) = lower(
        "export default function T({ o }: any) { return <div dangerouslySetInnerHTML={o} /> }",
    );
    assert_eq!(
        render(&j, serde_json::json!({ "o": { "__html": "<u>z</u>" } })),
        "<div><u>z</u></div>"
    );
    assert_eq!(render(&j, serde_json::json!({})), "<div></div>");
    assert_eq!(render(&j, serde_json::json!({ "o": null })), "<div></div>");
}

#[test]
fn reactive_value_stays_native_with_x_html() {
    let (j, c, tier) = lower(&format!(
        "{STATE}export default function T() {{ const [b, setB] = useState(true); return <div onClick={{() => setB(!b)}} dangerouslySetInnerHTML={{{{ __html: b ? '<b>on</b>' : '<i>off</i>' }}}} /> }}"
    ));
    assert_eq!(tier, Tier::Native);
    assert!(j.contains(" x-html=\"_c1\""), "{j}");
    assert!(j.contains("| html_raw }}</div>"), "{j}");
    assert!(c.contains("const _c1 = computed(() =>"), "{c}");
    assert!(
        render(&j, serde_json::json!({})).contains("<b>on</b></div>"),
        "{j}"
    );
}

/// A prop is a signal in a native component (a linked parent can change it), so its
/// inner HTML is reactive too.
#[test]
fn prop_value_in_a_native_component_is_reactive() {
    let (j, _, tier) = lower(&format!(
        "{STATE}export default function T({{ h }}: any) {{ const [n, setN] = useState(0); return <div onClick={{() => setN(n + 1)}}><p dangerouslySetInnerHTML={{{{ __html: h }}}} /></div> }}"
    ));
    assert_eq!(tier, Tier::Native);
    assert!(
        j.contains("<p x-html=\"_c1\">{{ h | html_raw }}</p>"),
        "{j}"
    );
}

#[test]
fn constant_value_in_a_native_component_has_no_x_html() {
    let (j, _, tier) = lower(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(0); return <div onClick={{() => setN(n + 1)}}><p dangerouslySetInnerHTML={{{{ __html: '<i>k</i>' }}}} /><b>{{n}}</b></div> }}"
    ));
    assert_eq!(tier, Tier::Native);
    assert!(j.contains("html_raw"), "{j}");
    assert!(!j.contains("x-html"), "{j}");
}

/// The raw sink is only the InnerHtml body: sibling text and attributes keep `| e`,
/// and a hand-written `x-html` attribute is refused, never printed.
#[test]
fn only_the_inner_html_body_is_raw() {
    let (j, _, _) = lower(
        "export default function T({ h, t, a }: any) { return <section title={a}><p dangerouslySetInnerHTML={{ __html: h }} /><p>{t}</p></section> }",
    );
    assert_eq!(j.matches("html_raw").count(), 1, "{j}");
    assert!(j.contains("{{ t | e }}"), "{j}");
    assert!(j.contains("{{ a | attr_str | e }}"), "{j}");
    let out = render(
        &j,
        serde_json::json!({ "h": "<b>ok</b>", "t": "<b>no</b>", "a": "\"><x>" }),
    );
    assert!(out.contains("<p><b>ok</b></p>"), "{out}");
    assert!(out.contains("<p>&lt;b&gt;no&lt;/b&gt;</p>"), "{out}");
    assert!(!out.contains("<x>"), "{out}");
}

#[test]
fn hand_written_x_html_attribute_is_not_rendered() {
    let (j, _, _) = lower(
        "export default function T({ v }: any) { return <div><p x-html=\"alert(1)\">a</p><p x-html={v}>b</p></div> }",
    );
    assert!(!j.contains("x-html"), "{j}");
    assert!(!j.contains("html_raw"), "{j}");
    assert_eq!(
        render(&j, serde_json::json!({ "v": "<b>" })),
        "<div><p>a</p><p>b</p></div>"
    );
}

#[test]
fn inner_html_beside_react_only_construct_still_builds() {
    let (_, _, tier) = lower(&format!(
        "{STATE}export default function T({{ h }}: any) {{ const [n] = useState(0); const w = window.innerWidth; return <div title={{String(w + n)}} dangerouslySetInnerHTML={{{{ __html: h }}}} /> }}"
    ));
    assert!(matches!(tier, Tier::React { .. }), "{tier:?}");
}

#[test]
fn script_body_keeps_working() {
    let (j, _, _) = lower(
        "export default function T({ h }: any) { return <script type=\"application/ld+json\" dangerouslySetInnerHTML={{ __html: h }} /> }",
    );
    assert_eq!(
        render(&j, serde_json::json!({ "h": "{\"a\":1}" })),
        "<script type=\"application/ld+json\">{\"a\":1}</script>"
    );
}

#[test]
fn list_rows_render_raw_and_native_rows_get_x_html() {
    let (j, _, tier) = lower(
        "export default function T({ xs }: any) { return <ul>{xs.map((x: any) => <li key={x.id} dangerouslySetInnerHTML={{ __html: x.h }} />)}</ul> }",
    );
    assert_eq!(tier, Tier::Static);
    assert_eq!(
        render(
            &j,
            serde_json::json!({ "xs": [{ "id": 1, "h": "<b>a</b>" }, { "id": 2, "h": "c" }] })
        ),
        "<ul><li><b>a</b></li><li>c</li></ul>"
    );
    // Same rule as `x-text` in a row: a row binds directives only when its source or a
    // painted value reads state; a prop-only list prints plain rows.
    let (j, _, tier) = lower(&format!(
        "{STATE}export default function T({{ xs }}: any) {{ const [n, setN] = useState(0); return <ul onClick={{() => setN(n + 1)}}>{{xs.map((x: any) => <li key={{x.id}}>{{x.h}}</li>)}}</ul> }}"
    ));
    assert_eq!(tier, Tier::Native);
    assert!(!j.contains("x-text"), "{j}");
    let (j, _, _) = lower(&format!(
        "{STATE}export default function T({{ xs }}: any) {{ const [n, setN] = useState(0); return <ul onClick={{() => setN(n + 1)}}>{{xs.map((x: any) => <li key={{x.id}} dangerouslySetInnerHTML={{{{ __html: x.h }}}} />)}}</ul> }}"
    ));
    assert!(!j.contains("x-html"), "{j}");
}

#[test]
fn state_driven_list_rows_get_x_html() {
    let (j, c, tier) = lower(&format!(
        "{STATE}export default function T() {{ const [xs, setXs] = useState([{{ id: 1, h: '<b>a</b>' }}]); return <ul onClick={{() => setXs([])}}>{{xs.map((x) => <li key={{x.id}} dangerouslySetInnerHTML={{{{ __html: x.h }}}} />)}}</ul> }}"
    ));
    assert_eq!(tier, Tier::Native);
    assert!(j.contains("x-for="), "{j}");
    assert!(j.contains("x-html=\"_c"), "{j}");
    assert!(c.contains("x.h"), "{c}");
}
