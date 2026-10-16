//! shadcn S1.2 (R34.14-R34.17): `...rest` in the props pattern and JSX spreads with React's
//! semantics. Known keys (an inlined instance's call site) expand at compile time into ordinary
//! attributes; keys known only at render go through `spread_attrs` (brust-jinja).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Out {
    jinja: String,
    chunk: String,
    tier: Tier,
    diags: Vec<(DiagClass, String)>,
}

/// Compiles `src` as `tests/fixtures/rest-props/<file>` (siblings in that directory resolve).
fn lower(file: &str, src: &str) -> Out {
    let s = src.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/rest-props/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        Out {
            jinja: a.jinja.clone(),
            chunk: a.client_js.clone().unwrap_or_default(),
            tier: tree[0].ir.tier.clone(),
            diags: tree[0]
                .ir
                .diagnostics
                .iter()
                .chain(&a.diagnostics)
                .map(|d| (d.class, d.rule.clone()))
                .collect(),
        }
    })
}

/// Renders like the server: props are top-level variables and `_props` is the whole object.
fn render(jinja: &str, props: serde_json::Value) -> String {
    let mut ctx = props.clone();
    ctx["_props"] = props;
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx))
        .unwrap()
        .trim()
        .to_string()
}

#[test]
fn rest_pattern_reads_and_unknown_spread_at_the_root() {
    let o = lower(
        "T.tsx",
        "export default function T({ title, ...rest }: any) { return <div className=\"base\" {...rest}><h1>{title}</h1><i>{rest.note}</i><b>{rest.title}</b></div> }",
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    let html = render(
        &o.jinja,
        serde_json::json!({ "title": "T", "note": "n", "className": "mine", "id": "x", "onClick": "alert(1)", "x-on-click": "f" }),
    );
    assert_eq!(
        html,
        "<div class=\"mine\" id=\"x\" note=\"n\"><h1>T</h1><i>n</i><b></b></div>"
    );
}

#[test]
fn known_shape_expands_at_compile_time_with_react_order() {
    let o = lower(
        "P.tsx",
        "import Card from './Card'\nimport First from './First'\nimport Box from './Box'\nexport default function P() { return <main><Card className=\"c\" id=\"x\" aria-label=\"L\" data-k={1} hidden={true} style={{ color: 'red' }}>kids</Card><First role=\"x\" title=\"t\" /><Box id=\"b\">ignored</Box></main> }",
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    // No runtime merge: every key was known at the call site.
    assert!(!o.jinja.contains("spread_attrs"), "{}", o.jinja);
    assert_eq!(
        render(&o.jinja, serde_json::json!({})),
        "<main><div data-slot=\"card\" class=\"c\" id=\"x\" aria-label=\"L\" data-k=\"1\" hidden style=\"color:red\">kids</div>\
<span role=\"note\" title=\"t\"></span><section id=\"b\">own</section></main>"
    );
}

fn has(o: &Out, class: DiagClass, rule: &str) -> bool {
    o.diags.iter().any(|(c, r)| *c == class && r == rule)
}

const STATE: &str = "import { useState } from 'react'\n";

#[test]
fn a_state_value_into_a_spread_is_bound_by_the_parent_but_a_merging_key_keeps_react() {
    // An event handler is bound by the parent since S1.3 (tests/spread_handlers.rs).
    let f = lower(
        "P.tsx",
        &format!(
            "{STATE}import Card from './Card'\nexport default function P() {{ const [n, setN] = useState(0); return <Card id=\"a\" onClick={{() => setN(n + 1)}} /> }}"
        ),
    );
    assert_eq!(f.tier, Tier::Native, "{:?}", f.diags);
    assert!(f.jinja.contains(" x-on-click=\"_h1\""), "{}", f.jinja);
    // A state value that lands in the spread is bound by the parent too (2b-handlers, R34.18 extended): the
    // attribute a hand-written `<div title={n}>` would carry, and the child stays unlinked.
    let s = lower(
        "P.tsx",
        &format!(
            "{STATE}import Card from './Card'\nexport default function P() {{ const [n, setN] = useState(0); return <div><button onClick={{() => setN(n + 1)}}>+</button><Card title={{n}} /></div> }}"
        ),
    );
    assert_eq!(s.tier, Tier::Native, "{:?}", s.diags);
    let html = render(&s.jinja, serde_json::json!({}));
    assert!(html.contains(" x-bind-title="), "{html}");
    assert!(!html.contains("x-props-bind"), "{html}");
    // `style` is bound too (F296, spread-live): React replaces the element's own `style` with the spread's, it never
    // merges, so the parent's binding is what the element prints.
    let c = lower(
        "P.tsx",
        &format!(
            "{STATE}import Card from './Card'\nexport default function P() {{ const [n, setN] = useState(0); return <div><button onClick={{() => setN(n + 1)}}>+</button><Card style={{{{ color: n > 0 ? 'red' : 'blue' }}}} /></div> }}"
        ),
    );
    assert_eq!(c.tier, Tier::Native, "{:?}", c.diags);
    assert!(c.jinja.contains(" x-bind-style="), "{}", c.jinja);
    // `value` is set as a property by the binder: it is not bound through a spread, and the parent stays on React.
    let c = lower(
        "P.tsx",
        &format!(
            "{STATE}import Card from './Card'\nexport default function P() {{ const [n, setN] = useState(0); return <div><button onClick={{() => setN(n + 1)}}>+</button><Card value={{n}} /></div> }}"
        ),
    );
    assert!(matches!(c.tier, Tier::React { .. }), "{:?}", c.diags);
    // A state value the child binds by name is the ordinary linked-prop path: native.
    let named = lower(
        "P.tsx",
        &format!(
            "{STATE}import Pill from './Pill'\nexport default function P() {{ const [n, setN] = useState(0); return <div><button onClick={{() => setN(n + 1)}}>+</button><Pill open={{n > 0}} id=\"x\" /></div> }}"
        ),
    );
    assert_eq!(named.tier, Tier::Native, "{:?}", named.diags);
    let html = render(&named.jinja, serde_json::json!({}));
    assert!(html.contains(" x-bind-data-open="), "{html}");
    assert!(html.contains(" id=\"x\""), "{html}");
    assert!(!named.chunk.is_empty());
}

#[test]
fn unknown_keys_through_a_parent_spread_and_b_spread_child() {
    let o = lower(
        "R.tsx",
        "import Card from './Card'\nexport default function R(props: any) { return <Card {...props} className=\"k\" /> }",
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert_eq!(
        render(
            &o.jinja,
            serde_json::json!({ "className": "x", "id": "i", "onClick": "alert(1)" })
        ),
        "<div data-slot=\"card\" class=\"k\" id=\"i\"></div>"
    );
    // The battery's b-spread-child: the child reads `props.a`, which the spread carries.
    let b = lower(
        "R.tsx",
        "import Leaf from './Leaf'\nexport default function R(props: any) { return <Leaf {...props} /> }",
    );
    assert_eq!(b.tier, Tier::Static, "{:?}", b.diags);
    assert_eq!(
        render(&b.jinja, serde_json::json!({ "a": "A" })),
        "<b>A</b>"
    );
    // A later named prop wins over the spread; an earlier one loses to it.
    let w = lower(
        "R.tsx",
        "import Leaf from './Leaf'\nexport default function R(props: any) { return <i><Leaf a=\"first\" {...props} /><Leaf {...props} a=\"last\" /></i> }",
    );
    assert_eq!(
        render(&w.jinja, serde_json::json!({ "a": "A" })),
        "<i><b>A</b><b>last</b></i>"
    );
    assert_eq!(
        render(&w.jinja, serde_json::json!({})),
        "<i><b>first</b><b>last</b></i>"
    );
}

#[test]
fn security_names_urls_directives() {
    // Hostile object keys in a literal spread are dropped with a warning (R34.17). Bun inlines a
    // literal spread into the props object, so this also covers a quote in a key.
    let q = lower(
        "T.tsx",
        "export default function T() { return <p {...{ 'x\" onmouseover=\"alert(1)': 1 }}>x</p> }",
    );
    assert_eq!(render(&q.jinja, serde_json::json!({})), "<p>x</p>");
    let lit = lower(
        "T.tsx",
        "export default function T() { return <p {...{ 'onmouseover=alert(1) x': 'y', 'data-ok': 'v', key: 'k' }} /> }",
    );
    assert!(
        has(&lit, DiagClass::Warning, "unsafe-attr"),
        "{:?}",
        lit.diags
    );
    assert_eq!(
        render(&lit.jinja, serde_json::json!({})),
        "<p data-ok=\"v\"></p>"
    );
    // javascript: URLs and x-* through a known-shape spread: the url rule, reserved-attr.
    let k = lower(
        "P.tsx",
        "import Link from './Link'\nexport default function P({ u }: any) { return <Link label=\"go\" href={u} x-on-click=\"f\" data-q=\"&quot;\" /> }",
    );
    assert!(
        has(&k, DiagClass::Warning, "reserved-attr"),
        "{:?}",
        k.diags
    );
    assert_eq!(
        render(&k.jinja, serde_json::json!({ "u": "javascript:alert(1)" })),
        "<a data-q=\"&quot;\">go</a>"
    );
    assert_eq!(
        render(&k.jinja, serde_json::json!({ "u": "/ok\"x" })),
        "<a href=\"/ok&quot;x\" data-q=\"&quot;\">go</a>"
    );
    // The same through unknown keys (the route's props).
    let u = lower(
        "R.tsx",
        "import Link from './Link'\nexport default function R(props: any) { return <Link {...props} /> }",
    );
    assert_eq!(
        render(
            &u.jinja,
            serde_json::json!({ "label": "go", "href": "javascript:x", "x-html": "<b>", "a b": "1", "title": "t\"<" })
        ),
        "<a title=\"t&quot;&lt;\">go</a>"
    );
}

#[test]
fn rest_read_as_a_value_falls_back() {
    let v = lower(
        "T.tsx",
        "export default function T({ a, ...rest }: any) { return <p>{Object.keys(rest).length}{a}</p> }",
    );
    assert!(
        has(&v, DiagClass::Fallback, "prop-pattern"),
        "{:?}",
        v.diags
    );
    let h = lower(
        "T.tsx",
        &format!(
            "{STATE}export default function T({{ a, ...rest }}: any) {{ const [n, setN] = useState(0); return <button onClick={{() => {{ setN(n + 1); console.log(rest) }}}}>{{a}}</button> }}"
        ),
    );
    assert!(
        has(&h, DiagClass::Fallback, "prop-pattern"),
        "{:?}",
        h.diags
    );
    // `rest.k` is an ordinary prop read, in a handler too.
    let ok = lower(
        "T.tsx",
        &format!(
            "{STATE}export default function T({{ a, ...rest }}: any) {{ const [n, setN] = useState(0); return <button onClick={{() => setN(n + rest.step)}}>{{a}}{{n}}</button> }}"
        ),
    );
    assert_eq!(ok.tier, Tier::Native, "{:?}", ok.diags);
    assert!(ok.chunk.contains("props().step"), "{}", ok.chunk);
}

/// Ruling on challenge 4dc45c45 (F142): a fed child in a list over a local array is an island, not
/// a build error; over a props path it stays native/static.
#[test]
fn fed_child_in_a_local_list_is_an_island_not_a_build_error() {
    // A constant list carries its rows since F142 R34.43 (tests/per_instance_jobs.rs).
    let constant = lower(
        "P.tsx",
        "import Row from './Row'\nconst rows = [{ id: 1, name: 'a' }]\nexport default function P() { return <ul>{rows.map((r) => <Row key={r.id} name={r.name} />)}</ul> }",
    );
    assert_eq!(constant.tier, Tier::Static, "{:?}", constant.diags);
    // A list that changes on the client still has no rows the server can feed.
    let local = lower(
        "P.tsx",
        "import { useState } from 'react'\nimport Row from './Row'\nexport default function P() { const [rows, setRows] = useState([{ id: 1, name: 'a' }]); return <ul><button onClick={() => setRows([])}>x</button>{rows.map((r) => <Row key={r.id} name={r.name} />)}</ul> }",
    );
    assert!(
        matches!(local.tier, Tier::React { .. }),
        "{:?}",
        local.diags
    );
    assert!(
        has(&local, DiagClass::Fallback, "instance-list-path"),
        "{:?}",
        local.diags
    );
    let props = lower(
        "P.tsx",
        "import Row from './Row'\nexport default function P({ rows }: any) { return <ul>{rows.map((r: any) => <Row key={r.id} name={r.name} />)}</ul> }",
    );
    assert!(
        !matches!(props.tier, Tier::React { .. }),
        "{:?}",
        props.diags
    );
}

/// Review F1: React/HTML aliases are one attribute through a spread, later wins, in both paths.
#[test]
fn aliases_are_one_attribute_in_both_paths() {
    let count = |html: &str, name: &str| html.matches(&format!(" {name}=")).count();
    // Keys known only at render (the route's props).
    let after = lower(
        "T.tsx",
        "export default function T(props: any) { return <label {...props} className=\"x\" htmlFor=\"a\" tabIndex={1} /> }",
    );
    let h = render(
        &after.jinja,
        serde_json::json!({ "class": "y", "for": "b", "tabindex": 9 }),
    );
    assert_eq!(
        (count(&h, "class"), count(&h, "for"), count(&h, "tabindex")),
        (1, 1, 1),
        "{h}"
    );
    assert!(
        h.contains("class=\"x\"") && h.contains("for=\"a\"") && h.contains("tabindex=\"1\""),
        "{h}"
    );
    let before = lower(
        "T.tsx",
        "export default function T(props: any) { return <label className=\"x\" htmlFor=\"a\" tabIndex={1} {...props} /> }",
    );
    let h = render(
        &before.jinja,
        serde_json::json!({ "class": "y", "for": "b", "tabindex": 9 }),
    );
    assert_eq!(
        (count(&h, "class"), count(&h, "for"), count(&h, "tabindex")),
        (1, 1, 1),
        "{h}"
    );
    assert!(
        h.contains("class=\"y\"") && h.contains("for=\"b\"") && h.contains("tabindex=\"9\""),
        "{h}"
    );
    // Keys known at the call site (an inlined child), both orders.
    let k = lower(
        "P.tsx",
        "import Card from './Card'\nimport First from './First'\nexport default function P() { return <main><Card class=\"y\" /><First class=\"y\" for=\"b\" /></main> }",
    );
    let h = render(&k.jinja, serde_json::json!({}));
    // Card: <div className={className} {...props}>: the spread's `class` comes later and wins.
    assert_eq!(
        h,
        "<main><div data-slot=\"card\" class=\"y\"></div><span class=\"y\" for=\"b\" role=\"note\"></span></main>"
    );
    let a = lower(
        "P.tsx",
        "import Alias from './Alias'\nexport default function P() { return <Alias class=\"y\" for=\"b\" /> }",
    );
    let h = render(&a.jinja, serde_json::json!({}));
    assert_eq!(h, "<label class=\"x\" for=\"a\"></label>", "{h}");
}

// B5: `{ ...rest.key, ...local, k: v }` reads the prop `key` and spreads it, as `rest.key` already does elsewhere.
#[test]
fn an_object_spread_of_a_rest_key_reads_that_prop() {
    let ok = lower(
        "T.tsx",
        &format!(
            "{STATE}export default function T({{ label, ...props }}: any) {{ const [n, setN] = useState(0); const size = {{ width: n * 10 }}; return <div onClick={{() => setN(n + 1)}}><input aria-label={{label}} style={{{{ ...props.style, ...size, position: 'absolute' }}}} /></div> }}"
        ),
    );
    assert!(
        !has(&ok, DiagClass::Fallback, "prop-pattern"),
        "{:?}",
        ok.diags
    );
    assert!(
        ok.chunk
            .contains("Object.assign({}, props().style, size(), { position: \"absolute\" })"),
        "{}",
        ok.chunk
    );
    // The whole rest object spread into an object is still a read of the rest object as a value.
    let bad = lower(
        "T.tsx",
        &format!(
            "{STATE}export default function T({{ label, ...props }}: any) {{ const [n, setN] = useState(0); return <div onClick={{() => setN(n + 1)}}><input aria-label={{label}} style={{{{ ...props, position: 'absolute' }}}} /></div> }}"
        ),
    );
    assert!(
        has(&bad, DiagClass::Fallback, "prop-pattern"),
        "{:?}",
        bad.diags
    );
}
