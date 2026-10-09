//! M1c Tasks 3–4: the template backend — structure, directives, host
//! attributes, child inlining. Review Focus 1, 2, 4, 5 (3 with the escaper).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Lowers `src` as a module next to the parent-counter fixture (so
/// `./Counter` resolves); returns (jinja, client chunk).
fn lower(src: &str) -> (String, String) {
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
        (a.jinja.clone(), a.client_js.clone().unwrap_or_default())
    })
}

fn render(jinja: &str, ctx: serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx)).unwrap()
}

const STATE: &str = "import { useState } from 'react'\n";

/// Review Focus 1: a reactive slot with siblings is wrapped; a lone one puts
/// x-text on its parent.
#[test]
fn state_slots_with_and_without_siblings() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(1); return <div onClick={{() => setN(n + 1)}}><p>Total: {{n}}</p><b>{{n}}</b></div> }}"
    ));
    assert!(
        j.contains("<p>Total: <span x-text=\"_c1\">{{ n | e }}</span></p>"),
        "{j}"
    );
    assert!(j.contains("<b x-text=\"_c2\">{{ n | e }}</b>"), "{j}");
}

/// Review Focus 2: an x-if branch that is not one element gets a wrapper.
#[test]
fn if_branches_that_are_not_one_element_are_wrapped() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T() {{ const [open, setOpen] = useState(false); return <div onClick={{() => setOpen(!open)}}>{{open && <>a<b/></>}}</div> }}"
    ));
    assert!(
        j.contains("{% if (open) | truthy %}<brust-if style=\"display:contents\" x-if=\"_c1\">a<b></b></brust-if>{% else %}<!--x-if--><brust-if style=\"display:contents\" x-if=\"_c1\" hidden>a<b></b></brust-if>{% endif %}"),
        "{j}"
    );
    // Renders as valid jinja either way.
    assert!(render(&j, serde_json::json!({})).contains("hidden"));
}

/// Review Focus 4: a boolean attribute renders present/absent.
#[test]
fn boolean_attribute_from_a_server_expression() {
    let (j, _) = lower(
        "export default function T({ ok }: any) { return <button disabled={!ok}>x</button> }",
    );
    assert!(
        j.contains("{% if ((not (ok | truthy))) | truthy %} disabled{% endif %}"),
        "{j}"
    );
    assert!(!j.contains("disabled=\""), "{j}");
    assert_eq!(
        render(&j, serde_json::json!({ "ok": false }))
            .lines()
            .last()
            .unwrap(),
        "<button disabled>x</button>"
    );
    assert_eq!(
        render(&j, serde_json::json!({ "ok": true }))
            .lines()
            .last()
            .unwrap(),
        "<button>x</button>"
    );
}

/// Review Focus 5: two instances of one native child: two hosts of the same
/// behavior, two links.
#[test]
fn a_native_child_inlined_twice() {
    let (j, c) = lower(&format!(
        "{STATE}import Counter from './Counter'\nexport default function T() {{ const [a, setA] = useState(1); const [b, setB] = useState(2); return <div><Counter n={{a}} onReset={{() => setA(0)}} /><Counter n={{b}} onReset={{() => setB(0)}} /></div> }}"
    ));
    assert_eq!(j.matches("x-data=\"counter_1f1ff519\"").count(), 2, "{j}");
    assert!(
        j.contains("x-props-bind=\"_p1\"") && j.contains("x-props-bind=\"_p2\""),
        "{j}"
    );
    assert!(
        c.contains("const _p1 = computed(() => ({ n: a(), onReset: () => a.set(0) }))"),
        "{c}"
    );
    assert!(
        c.contains("const _p2 = computed(() => ({ n: b(), onReset: () => b.set(0) }))"),
        "{c}"
    );
    // Each instance paints its own seed.
    let html = render(&j, serde_json::json!({}));
    assert!(
        html.contains(">1</button>") && html.contains(">2</button>"),
        "{html}"
    );
}

/// Review Focus 3 (template half): static text and attributes, and JSON in
/// x-props, survive quotes and `</script>`; `{` never reaches jinja.
#[test]
fn escaping_of_static_text_attributes_and_props_json() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T({{ item }}: any) {{ const [n, setN] = useState(0); return <p title='a\"b</script>' onClick={{() => setN(1)}}>{{'{{{{ x }}}}'}} {{item.name}}{{n}}</p> }}"
    ));
    assert!(j.contains("title=\"a&quot;b&lt;/script&gt;\""), "{j}");
    assert!(j.contains("&#123;&#123; x }}"), "{j}");
    let html = render(
        &j,
        serde_json::json!({ "item": { "name": "a\"b</script>" } }),
    );
    let props = html
        .split("x-props='")
        .nth(1)
        .and_then(|s| s.split('\'').next())
        .unwrap();
    assert!(!props.contains('<') && !props.contains('\''), "{props}");
    let unq = props
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let v: serde_json::Value = serde_json::from_str(&unq).unwrap();
    assert_eq!(v["item"]["name"], "a\"b</script>");
    assert!(html.contains("a&quot;b&lt;/script&gt;"), "{html}");
}

/// The controlled-input pair is x-model; other onChange are DOM events by
/// field kind (F16).
#[test]
fn model_pair_and_change_events() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T({{ f }}: any) {{ const [q, setQ] = useState(''); return <form><input value={{q}} onChange={{(e) => setQ(e.target.value)}} /><input onChange={{f}} /><input type=\"checkbox\" onChange={{f}} /></form> }}"
    ));
    assert!(j.contains("x-model=\"q\""), "{j}");
    assert_eq!(j.matches("x-on-input=").count(), 1, "{j}");
    assert_eq!(j.matches("x-on-change=").count(), 1, "{j}");
}

/// Spec §9 rule: `lower/` never names a Bun type.
#[test]
fn lower_sources_do_not_name_bun() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lower");
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("bun_"), "{} names a Bun crate", p.display());
    }
}

/// Security review: a `javascript:` URL never renders, inline handler and
/// srcdoc attributes are dropped, and x-props seeds only the paths painted.
#[test]
fn urls_handlers_and_seeds_are_guarded() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T({{ url, user }}: any) {{ const [n, setN] = useState(0); return <a href={{url}} onclick=\"alert(1)\" srcDoc=\"x\" title={{user.name}} onClick={{() => setN(n + 1)}}>{{n}}<img src=\"javascript:alert(1)\" /></a> }}"
    ));
    assert!(
        !j.contains("onclick=") && !j.contains("srcdoc") && !j.contains("javascript"),
        "{j}"
    );
    let html = render(
        &j,
        serde_json::json!({ "url": "java\tscript:alert(1)", "user": { "name": "Ada", "secret": "s3" } }),
    );
    assert!(!html.contains(" href=\""), "{html}");
    assert!(
        !html.contains("s3"),
        "x-props leaked an unread field: {html}"
    );
    assert!(html.contains("&quot;name&quot;:&quot;Ada&quot;"), "{html}");
    let html = render(
        &j,
        serde_json::json!({ "url": "/docs?a=1", "user": { "name": "Ada" } }),
    );
    assert!(html.contains("href=\"/docs?a=1\""), "{html}");
}

/// Security review: an IR with an Error is never lowered.
#[test]
fn an_ir_with_errors_is_not_lowered() {
    let s = "import { useState } from 'react'\nimport { readFileSync } from 'node:fs'\nexport default function L() { const [t, setT] = useState(''); return <b onClick={() => setT(readFileSync('/x', 'utf8'))}>{t}</b> }".to_string();
    let r = brust_compiler::parse::run_on_compiler_thread(move || {
        brust_compiler::pipeline::compile_tree(
            "T.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions::default(),
            DEFAULT_RUNTIME_IMPORT,
        )
        .map(|_| ())
    });
    assert_eq!(r.unwrap_err().rule, "server-only-in-client");
}

/// Security review: the attribute guards ignore case (`ONCLICK`, `HREF`).
#[test]
fn attribute_guards_ignore_case() {
    let (j, _) = lower(
        "export default function T({ u }: any) { return <a ONCLICK=\"alert(1)\" HREF={u} SRC=\"javascript:x\">x</a> }",
    );
    assert!(
        !j.to_ascii_lowercase().contains("onclick=") && !j.contains("javascript"),
        "{j}"
    );
    let html = render(&j, serde_json::json!({ "u": "javascript:alert(1)" }));
    assert!(!html.to_ascii_lowercase().contains(" href="), "{html}");
}

/// F36: a style that may be undefined omits the attribute, as React does.
#[test]
fn undefined_style_omits_the_attribute() {
    let (j, _) = lower(
        "export default function T({ c }: any) { return <p style={c ? { color: 'red' } : undefined}>x</p> }",
    );
    let off = render(&j, serde_json::json!({ "c": false }));
    assert!(!off.contains("style"), "{off}");
    let on = render(&j, serde_json::json!({ "c": true }));
    assert!(on.contains("style=\"color:red"), "{on}");
}

/// Lowers the root of fixture `name` (`tests/fixtures/<name>/input.tsx`); returns its jinja.
fn lowered_jinja(name: &str) -> String {
    let file = format!("tests/fixtures/{name}/input.tsx");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &file,
            None,
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        tree[0].artifacts.jinja.clone()
    })
}

/// S9: the document is ordinary JSX; the title is an escaped text binding and the host is the root.
#[test]
fn document_root_is_a_plain_host_with_escaped_title() {
    let jinja = lowered_jinja("document-root");
    assert!(
        jinja.contains("\n<html x-data=\"input_"),
        "root element is the host: {jinja}"
    );
    assert!(
        jinja.contains("<title x-text=\"") && jinja.contains(" | e }}</title>"),
        "title is an escaped text binding: {jinja}"
    );
    assert!(
        !jinja.contains("<script"),
        "the compiler never injects scripts (S9): {jinja}"
    );
}

#[test]
fn outlet_lowers_to_the_outlet_slot() {
    let jinja = lowered_jinja("outlet-layout");
    assert!(
        jinja.contains("<main>{{ __outlet | safe }}</main>"),
        "{jinja}"
    );
}

/// S12: a react child is wrapped in the island host the runtime hydrates; SSR HTML goes inside it.
#[test]
fn react_child_gets_the_island_host() {
    let jinja = lowered_jinja("react-child");
    assert!(
        jinja.contains("<brust-island data-id=\"reviews_"),
        "{jinja}"
    );
    assert!(
        jinja.contains("x-props='{{ {"),
        "props JSON on the host: {jinja}"
    );
    assert!(
        jinja.contains("| json_attr }}'>{{ _ssr_reviews_"),
        "ssr slot inside the host: {jinja}"
    );
    assert!(jinja.contains("| safe }}</brust-island>"), "{jinja}");
    assert!(
        !jinja.contains("data-brust-island"),
        "old attribute name must be gone: {jinja}"
    );
}

#[test]
fn client_only_page_gets_an_empty_island_host() {
    let jinja = lowered_jinja("client-only");
    assert!(
        jinja.contains("<brust-island data-id=\"input_")
            && jinja.contains("x-props='{{ _props | json_attr }}'></brust-island>"),
        "empty host: {jinja}"
    );
}

#[test]
fn react_page_gets_the_island_host_around_its_ssr_slot() {
    let jinja = lowered_jinja("react-hook");
    assert!(
        jinja.contains("x-props='{{ _props | json_attr }}'>{{ _ssr_input_")
            && jinja.ends_with("| safe }}</brust-island>"),
        "{jinja}"
    );
}

/// F39: `useId()` reads the server-seeded `_id0`; the client gets it through props.
#[test]
fn use_id_is_seeded_in_the_template_and_the_client_props() {
    let (jinja, client) = lower(
        "import { useId, useState } from 'react'\nexport default function Field(props: { label: string }) { const id = useId(); const [v, setV] = useState(''); return <div><label htmlFor={id}>{props.label}</label><input id={id} value={v} onChange={e => setV(e.target.value)} /></div> }",
    );
    assert!(
        !jinja.contains("{% set id"),
        "no shadowing variable: {jinja}"
    );
    assert!(
        jinja.contains("for=\"{{ _id0 | attr_str | e }}\"")
            || jinja.contains("for=\"{{ (_id0) | attr_str | e }}\""),
        "{jinja}"
    );
    assert!(
        jinja.contains("\"_id0\": _id0"),
        "x-props carries the id: {jinja}"
    );
    assert!(client.contains("._id0"), "{client}");
    let html = render(
        &jinja,
        serde_json::json!({ "label": "L", "_id0": "brust-r-0-0" }),
    );
    assert!(
        html.contains("for=\"brust-r-0-0\"") && html.contains("id=\"brust-r-0-0\""),
        "{html}"
    );
}

/// F39: a child with `useId` inside a keyed row gets one id per row, read from the instance's
/// per-row slot object (`__<child>_<k>[row]["_id0"]`), so ids differ per row and the server owns them.
#[test]
fn use_id_in_a_keyed_row_is_indexed_by_the_loop_path() {
    let jinja = lowered_jinja("use-id-row");
    assert!(jinja.contains("[_i1][\"_id0\"]"), "{jinja}");
    let html = render(
        &jinja,
        serde_json::json!({
            "fields": [{ "key": "a", "label": "A" }, { "key": "b", "label": "B" }],
            "__field_603ad356_1": [{ "_id0": "id-a" }, { "_id0": "id-b" }],
        }),
    );
    assert!(
        html.contains("for=\"id-a\"") && html.contains("for=\"id-b\""),
        "{html}"
    );
}

/// F34 (compiler half): an inlined child with its own job inside a list is recorded as a
/// per-row instance, and the printed slot key comes from the same ordinal.
#[test]
fn inlined_child_with_a_job_inside_a_list_is_recorded_as_a_per_row_instance() {
    let file = "tests/fixtures/keyed-list-child-job/input.tsx".to_string();
    let ir = run_on_compiler_thread(move || {
        brust_compiler::analyze::component::analyze_file(
            &file,
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
        )
        .unwrap()
    });
    let inst = ir
        .instances
        .iter()
        .find(|i| i.child_id.starts_with("priceRow_"))
        .expect("instance");
    assert_eq!(inst.loops, vec![Some("items".to_string())]);
    assert_eq!(inst.props["item"].as_deref(), Some("items[idx]"));
    assert_eq!(inst.props["unit"].as_deref(), Some("unit"));
    let jinja = lowered_jinja("keyed-list-child-job");
    assert!(
        jinja.contains(&format!("__{}_{}[", inst.child_id, inst.k)),
        "{jinja}"
    );
    let json = serde_json::to_value(&ir).unwrap();
    assert_eq!(json["instances"][0]["k"], 1);
}

/// F32: a single-element row/branch carries `x-for` / `x-if` itself, so `<table>` children stay `<tr>`.
#[test]
fn single_root_row_and_branch_carry_the_directive_without_a_wrapper() {
    let jinja = lowered_jinja("table-rows");
    assert!(jinja.contains("<tr x-if=\""), "x-if on the tr: {jinja}");
    assert!(
        !jinja.contains("<brust-row") && !jinja.contains("<brust-if"),
        "no wrapper for a single-root row or branch: {jinja}"
    );
}

/// A row whose root is an inlined host keeps its `<brust-row>` wrapper: a host carrying `x-for`
/// is bound by the child's own instance when its chunk registers before the parent's.
#[test]
fn a_host_row_keeps_the_wrapper() {
    let jinja = lowered_jinja("keyed-list-child");
    assert!(jinja.contains("<brust-row"), "{jinja}");
    assert!(
        !jinja.contains("<li x-data=\"row_8f35bb06\" x-props")
            || jinja.contains("<brust-row style=\"display:contents\" x-for"),
        "{jinja}"
    );
}

/// Static text in <style>/<script> is printed verbatim (browsers do not decode entities there).
#[test]
fn static_raw_text_is_not_entity_escaped() {
    let (j, _) = lower(
        "export default function T() { return <div><style>{`.a > b{color:red}`}</style><script>{\"if (a && b) { go('x') }\"}</script></div> }",
    );
    let html = render(&j, serde_json::json!({}));
    assert!(html.contains("<style>.a > b{color:red}</style>"), "{html}");
    assert!(
        html.contains("<script>if (a && b) { go('x') }</script>"),
        "{html}"
    );
}

/// A prop read only as `list.length` seeds the count, not the list (its items stay on the server).
#[test]
fn list_length_seeds_the_count_and_not_the_items() {
    let jinja = lowered_jinja("table-rows");
    let html = render(
        &jinja,
        serde_json::json!({ "rows": [{ "id": "a", "name": "secret-a" }, { "id": "b", "name": "B" }] }),
    );
    let props = html
        .split("x-props='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    assert_eq!(
        props.replace("&quot;", "\""),
        r#"{"rows":{"length":2}}"#,
        "{html}"
    );
    assert!(
        !html
            .split("x-props='")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap()
            .contains("secret"),
        "{html}"
    );
}

/// Compiles fixture `name` and returns the lowering error, if any.
fn lower_err(name: &str) -> Option<brust_compiler::ir::Diagnostic> {
    let file = format!("tests/fixtures/{name}/input.tsx");
    run_on_compiler_thread(move || {
        compile_tree(
            &file,
            None,
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .err()
    })
}

/// Spot-check 05c677eb: a react child under two loops cannot be served (one-level rule) -> Error, not a 2-D slot.
#[test]
fn react_child_in_nested_lists_is_a_nested_instance_error() {
    let err = lower_err("react-child-nested").expect("lowering must fail");
    assert_eq!(err.rule, "nested-instance", "{err:?}");
    // and one level still works
    let jinja = lowered_jinja("react-child-row");
    assert!(jinja.contains("_ssr_reviews_"), "{jinja}");
}
