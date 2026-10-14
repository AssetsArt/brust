//! shadcn S1.3 (R34.18-R34.20): an event handler that reaches an element through a static
//! child's spread is hoisted by the parent as its own member and bound on that element (the
//! output equals the hand-written markup in the parent); every other shape stays fail-closed.
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

/// Compiles `src` as `tests/fixtures/spread-handlers/<file>` (siblings in that directory resolve).
fn lower(file: &str, src: &str) -> Out {
    let s = src.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/spread-handlers/{file}");
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

fn has(o: &Out, class: DiagClass, rule: &str) -> bool {
    o.diags.iter().any(|(c, r)| *c == class && r == rule)
}

const STATE: &str = "import { useState } from 'react'\n";

fn page(imports: &str, body: &str) -> Out {
    lower(
        "P.tsx",
        &format!("{STATE}{imports}\nexport default function P() {{ {body} }}"),
    )
}

/// The parent falls back to React with `rule`, and nothing is bound.
fn refused(o: &Out, rule: &str) {
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
    assert!(has(o, DiagClass::Fallback, rule), "{rule}: {:?}", o.diags);
}

#[test]
fn a_handler_through_a_static_childs_spread_binds_in_the_parent() {
    let o = page(
        "import Btn from './Btn'",
        "const [n, setN] = useState(0); return <Btn className=\"b\" onClick={() => setN(n + 1)}>{n}</Btn>",
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    // R34.18: the binding a hand-written `onClick` gets in the parent (`x-on-click` to `_h1`).
    // (The host and the children's text wrapper are how any inlined instance prints.)
    let html = render(&o.jinja, serde_json::json!({}));
    assert_eq!(
        html,
        "<brust-host x-data=\"p_ad7a9ebf\" style=\"display:contents\"><button data-slot=\"button\" data-variant=\"default\" class=\"b\" x-on-click=\"_h1\"><span x-text=\"_c1\">0</span></button></brust-host>"
    );
    let hand = page(
        "",
        "const [n, setN] = useState(0); return <button data-slot=\"button\" data-variant=\"default\" className=\"b\" onClick={() => setN(n + 1)}>{n}</button>",
    );
    assert_eq!(o.chunk, hand.chunk);
    // The handler is a member of the parent, never markup.
    assert!(!html.contains("setN") && !html.contains("=>"), "{html}");
}

#[test]
fn handlers_in_a_list_on_a_text_field_and_on_two_elements() {
    // A row's handler carries the row binding, as a hand-written one does.
    let l = page(
        "import Btn from './Btn'",
        "const [n, setN] = useState(''); return <div><p>{n}</p>{['a', 'b'].map((it) => <Btn key={it} onClick={() => setN(it)}>{it}</Btn>)}</div>",
    );
    assert_eq!(l.tier, Tier::Native, "{:?}", l.diags);
    let hand = page(
        "",
        "const [n, setN] = useState(''); return <div><p>{n}</p>{['a', 'b'].map((it) => <button key={it} data-slot=\"button\" data-variant=\"default\" onClick={() => setN(it)}>{it}</button>)}</div>",
    );
    // The row is client-rendered (`x-for`) so the runtime has `it` for the handler, as hand-written.
    let html = render(&l.jinja, serde_json::json!({}));
    assert_eq!(
        html,
        "<div x-data=\"p_ad7a9ebf\"><p x-text=\"_c1\"></p><button x-for=\"it in _l1 by _k1\" data-slot=\"button\" data-variant=\"default\" x-on-click=\"_h1:it\"><span x-text=\"_c2:it\">a</span></button><button x-for=\"it in _l1 by _k1\" data-slot=\"button\" data-variant=\"default\" x-on-click=\"_h1:it\"><span x-text=\"_c2:it\">b</span></button></div>"
    );
    assert!(render(&hand.jinja, serde_json::json!({})).contains(" x-on-click=\"_h1:it\""));
    assert_eq!(l.chunk, hand.chunk);
    // shadcn's Input: React's onChange on a text field is the input event.
    let f = page(
        "import Field from './Field'",
        "const [q, setQ] = useState(''); return <div><Field placeholder=\"q\" onChange={(e: any) => setQ(e.target.value)} /><p>{q}</p></div>",
    );
    assert_eq!(f.tier, Tier::Native, "{:?}", f.diags);
    let html = render(&f.jinja, serde_json::json!({}));
    assert!(
        html.contains("<input data-slot=\"input\" placeholder=\"q\" x-on-input=\"_h1\">"),
        "{html}"
    );
    // A rest spread onto two elements binds both, as React does.
    let t = page(
        "import Twice from './Twice'",
        "const [n, setN] = useState(0); return <div><p>{n}</p><Twice label=\"L\" onClick={() => setN(1)} title=\"t\" /></div>",
    );
    assert_eq!(t.tier, Tier::Native, "{:?}", t.diags);
    let html = render(&t.jinja, serde_json::json!({}));
    assert_eq!(html.matches(" x-on-click=\"_h1\"").count(), 2, "{html}");
}

#[test]
fn a_handler_from_the_parents_props_and_a_literal_value() {
    // A handler the parent received (a prop) is bound the same way: `(props().onSave)(…)`.
    let o = lower(
        "Bar.tsx",
        "import Btn from './Btn'\nexport default function Bar({ onSave }: any) { return <Btn onClick={onSave}>save</Btn> }",
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    assert!(o.jinja.contains(" x-on-click=\"_h1\""), "{}", o.jinja);
    assert!(o.chunk.contains("onSave"), "{}", o.chunk);
    // A literal is not a handler: dropped from the HTML, as React does, and the page stays static.
    let s = lower(
        "S.tsx",
        "import Btn from './Btn'\nexport default function S() { return <Btn onClick=\"alert(1)\">x</Btn> }",
    );
    assert_eq!(s.tier, Tier::Static, "{:?}", s.diags);
    assert_eq!(
        render(&s.jinja, serde_json::json!({})),
        "<button data-slot=\"button\" data-variant=\"default\">x</button>"
    );
}

#[test]
fn limits_stay_fail_closed_with_their_own_codes() {
    let inc = "const [n, setN] = useState(0);";
    // R34.19: a native child (state of its own) spreading its props.
    refused(
        &page(
            "import Live from './Live'",
            &format!("{inc} return <Live onClick={{() => setN(n + 1)}} />"),
        ),
        "spread-handler",
    );
    // The child passes the props on to another component.
    refused(
        &page(
            "import Onward from './Onward'",
            &format!("{inc} return <Onward onClick={{() => setN(n + 1)}} />"),
        ),
        "spread-handler",
    );
    // The child also reads the handler by name.
    refused(
        &page(
            "import Reads from './Reads'",
            &format!("{inc} return <Reads onClick={{() => setN(n + 1)}} />"),
        ),
        "spread-handler",
    );
    // A linked instance (another prop reads state).
    refused(
        &page(
            "import Btn from './Btn'",
            &format!("{inc} return <Btn title={{String(n)}} onClick={{() => setN(n + 1)}} />"),
        ),
        "spread-handler",
    );
    // Another prop reads the row: the handler makes the client render the row, which would link it.
    refused(
        &page(
            "import Btn from './Btn'",
            &format!(
                "{inc} return <ul>{{['a', 'b'].map((it) => <li key={{it}}><Btn title={{it}} onClick={{() => setN(n + 1)}} /></li>)}}</ul>"
            ),
        ),
        "spread-handler",
    );
    // A function that is not an event handler (a render prop).
    refused(
        &page(
            "import Btn from './Btn'",
            &format!("{inc} return <div><p>{{n}}</p><Btn render={{() => setN(1)}} /></div>"),
        ),
        "spread-function",
    );
    // The capture phase, as on a hand-written element.
    refused(
        &page(
            "import Btn from './Btn'",
            &format!("{inc} return <Btn onClickCapture={{() => setN(n + 1)}} />"),
        ),
        "event-capture",
    );
    // Props of unknown keys spread AFTER the handler at the same call site may replace it (React: later wins).
    let o = lower(
        "Q.tsx",
        &format!(
            "{STATE}import Btn from './Btn'\nexport default function Q(props: any) {{ {inc} return <Btn onClick={{() => setN(n + 1)}} {{...props}} /> }}"
        ),
    );
    refused(&o, "spread-handler");
    // Spread before it, they cannot (F153c: Radix Label's `{...props} onMouseDown={…}`).
    let o = lower(
        "Q.tsx",
        &format!(
            "{STATE}import Btn from './Btn'\nexport default function Q(props: any) {{ {inc} return <Btn {{...props}} onClick={{() => setN(n + 1)}} /> }}"
        ),
    );
    assert!(
        !has(&o, DiagClass::Fallback, "spread-handler"),
        "{:?}",
        o.diags
    );
}

#[test]
fn an_omitted_prop_of_a_fed_child_is_bound_as_undefined() {
    // Every root a child's job reads must be bound per instance (brust-core refuses the manifest
    // otherwise, `UncoveredInput`): one the call site omits is `undefined`, as in React, so the
    // child's destructuring default applies. Found on S1.3: shadcn's Input without `className`.
    let path = "crates/brust-compiler/tests/fixtures/spread-handlers/P.tsx".to_string();
    let src =
        "import Tag from './Tag'\nexport default function P() { return <p><Tag text=\"x\" /></p> }";
    let rec = run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(src.as_bytes().to_vec()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        tree[0].ir.instances.clone()
    });
    assert_eq!(rec.len(), 1, "{rec:?}");
    assert_eq!(rec[0].literals["text"], serde_json::json!("x"));
    assert_eq!(rec[0].exprs["tone"], "__undefined");
}

#[test]
fn a_forwarded_key_that_is_not_an_attribute_name_is_never_printed() {
    // Review F1 (R34.17 for handlers): Bun inlines a literal spread into the props, so a quoted key
    // reaches the call site as a prop name. It must not print as `x-on-<key>`: dropped with a
    // warning, as React and the reader drop an invalid attribute name; a valid key still binds.
    for key in [
        "onX\\\" onmouseover=\\\"alert(1)",
        "onClick x",
        "onClick>",
        "onCl\u{ed}ck",
        "onClick=1",
    ] {
        let o = page(
            "import Btn from './Btn'",
            &format!(
                "const [n, setN] = useState(0); return <div><p>{{n}}</p><Btn {{...{{ \"{key}\": () => setN(1) }}}} onClick={{() => setN(n + 1)}} /></div>"
            ),
        );
        assert_eq!(o.tier, Tier::Native, "{key}: {:?}", o.diags);
        assert!(
            has(&o, DiagClass::Warning, "unsafe-attr"),
            "{key}: {:?}",
            o.diags
        );
        let html = render(&o.jinja, serde_json::json!({}));
        assert!(
            !html.contains("onmouseover") && !html.contains("alert"),
            "{key}: {html}"
        );
        assert_eq!(html.matches(" x-on-").count(), 1, "{key}: {html}");
        assert!(html.contains(" x-on-click=\"_h1\""), "{key}: {html}");
        // Only the valid handler became a member.
        assert!(!o.chunk.contains("_h2"), "{key}: {}", o.chunk);
    }
}
