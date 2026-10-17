//! shadcn S1.4 (R34.28-R34.34): `const Comp = asChild ? Slot.Root : "host"` is resolved at the
//! call site. No `asChild` prints the host; a literal `asChild` with one host-element child prints
//! that child with the component's attributes merged in (Radix `mergeProps`); anything else keeps
//! the caller on React with its own code.
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
    tier: Tier,
    diags: Vec<(DiagClass, String)>,
}

/// Compiles `src` as `tests/fixtures/slot/<file>` (siblings in that directory resolve).
fn lower(file: &str, src: &str) -> Out {
    let s = src.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/slot/{file}");
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

fn render(jinja: &str) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(
        jinja,
        brust_jinja::value_of(serde_json::json!({"_props": {}})),
    )
    .unwrap()
    .trim()
    .to_string()
}

fn page(body: &str) -> String {
    format!(
        "import Btn from './Btn'\nimport Chip from './Chip'\nimport Swapped from './Swapped'\nimport Own from './Own'\nimport Link from './Link'\nimport Plain from './Plain'\nimport Stateful from './Stateful'\nexport default function P() {{ return <main>{body}</main> }}"
    )
}

fn codes(o: &Out) -> Vec<&str> {
    o.diags.iter().map(|(_, r)| r.as_str()).collect()
}

fn react_with(o: &Out, rule: &str) -> bool {
    matches!(o.tier, Tier::React { .. })
        && o.diags
            .iter()
            .any(|(c, r)| *c == DiagClass::Fallback && r == rule)
}

#[test]
fn without_as_child_the_host_element_prints_and_the_component_is_static() {
    let o = lower(
        "P.tsx",
        &page("<Btn variant=\"x\" id=\"i\">Go</Btn><Btn asChild={false}>No</Btn><Chip>c</Chip>"),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert!(!codes(&o).contains(&"local-component"), "{:?}", o.diags);
    assert_eq!(
        render(&o.jinja),
        "<main><button data-slot=\"btn\" data-variant=\"x\" class=\"base \" id=\"i\">Go</button>\
<button data-slot=\"btn\" data-variant=\"default\" class=\"base \">No</button><span data-slot=\"chip\">c</span></main>"
    );
}

#[test]
fn a_literal_as_child_prints_the_child_with_the_component_attributes_merged() {
    let o = lower(
        "P.tsx",
        &page(
            "<Btn asChild className=\"extra\" id=\"slot\"><a href=\"/login\" id=\"mine\" className=\"link\">Login</a></Btn>",
        ),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    // Slot props first, the child's override them (`id`), `className` joins slot-first.
    assert_eq!(
        render(&o.jinja),
        "<main><a data-slot=\"btn\" data-variant=\"default\" class=\"base extra link\" id=\"mine\" href=\"/login\">Login</a></main>"
    );
}

#[test]
fn style_objects_merge_and_the_child_wins() {
    let o = lower(
        "P.tsx",
        &page(
            "<Chip asChild style={{ color: 'red', margin: 1 }}><b style={{ color: 'blue' }}>x</b></Chip>",
        ),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    let html = render(&o.jinja);
    assert!(html.starts_with("<main><b data-slot=\"chip\""), "{html}");
    assert!(html.contains("color:blue"), "{html}");
    assert!(html.contains("margin:1px"), "{html}");
    assert!(!html.contains("color:red"), "{html}");
}

#[test]
fn the_swapped_ternary_selects_the_slot_with_the_flag_false() {
    let o = lower(
        "P.tsx",
        &page("<Swapped plain>p</Swapped><Swapped><i>s</i></Swapped>"),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert_eq!(
        render(&o.jinja),
        "<main><p data-slot=\"swapped\">p</p><i data-slot=\"swapped\">s</i></main>"
    );
}

#[test]
fn a_dynamic_flag_or_a_spread_keeps_the_caller_on_react() {
    for (src, why) in [
        ("<Btn asChild={props.x}><a/></Btn>", "prop"),
        ("<Btn {...props}>x</Btn>", "spread"),
    ] {
        let s = format!(
            "import Btn from './Btn'\nexport default function P(props: any) {{ return <main>{src}</main> }}"
        );
        let o = lower("P.tsx", &s);
        assert!(react_with(&o, "slot-dynamic"), "{why}: {:?}", o.diags);
    }
}

#[test]
fn child_shapes_that_cannot_merge_stay_on_react() {
    for (body, rule) in [
        ("<Btn asChild>text</Btn>", "slot-child-shape"),
        ("<Btn asChild><a/><a/></Btn>", "slot-child-shape"),
        ("<Btn asChild></Btn>", "slot-child-shape"),
        ("<Btn asChild><Chip/></Btn>", "slot-child-component"),
        (
            "<Btn asChild><Plain>x</Plain></Btn>",
            "slot-child-component",
        ),
        ("<Btn asChild><Stateful /></Btn>", "slot-child-component"),
        (
            "<Btn asChild><Link onClick={() => {}}>x</Link></Btn>",
            "slot-handler",
        ),
        (
            "<Btn asChild><Link style={{ color: 'red' }}>x</Link></Btn>",
            "slot-merge",
        ),
        (
            "<Btn asChild><Link {...props}>x</Link></Btn>",
            "slot-child-shape",
        ),
        (
            "<Btn asChild><a onClick={() => {}}>x</a></Btn>",
            "slot-handler",
        ),
        (
            "<Btn asChild onClick={() => {}}><a>x</a></Btn>",
            "slot-handler",
        ),
        (
            "<Btn asChild><a dangerouslySetInnerHTML={{ __html: 'x' }}/></Btn>",
            "slot-child-shape",
        ),
    ] {
        let o = lower("P.tsx", &page(body));
        assert!(react_with(&o, rule), "{body}: {:?}", o.diags);
    }
}

#[test]
fn a_slot_that_is_not_radixs_keeps_local_component() {
    // The tag is `Comp`, a const of a Slot that is not Radix's: an ordinary local component.
    let own = lower(
        "Own.tsx",
        &std::fs::read_to_string(repo().join("crates/brust-compiler/tests/fixtures/slot/Own.tsx"))
            .unwrap(),
    );
    assert!(react_with(&own, "local-component"), "{:?}", own.diags);
    let o = lower("P.tsx", &page("<Own>x</Own>"));
    // Own is a React island; its constant children travel with it (island-children), so the page stays static.
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
}

#[test]
fn a_stateful_component_with_as_child_stays_on_react() {
    let o = lower(
        "P.tsx",
        "import { useState } from 'react'\nimport { Slot } from 'radix-ui'\nfunction Tog({ asChild }: any) { const [n, setN] = useState(0); const Comp = asChild ? Slot.Root : 'button'; return <Comp onClick={() => setN(n + 1)}>{n}</Comp> }\nexport default function P() { return <main><Tog asChild><a>x</a></Tog></main> }",
    );
    assert!(react_with(&o, "slot-native"), "{:?}", o.diags);
}

#[test]
fn a_prop_the_call_site_omits_is_undefined_for_the_childs_job() {
    // Cn has a per-instance job over `className` and `size`; the call passes neither. The manifest
    // binds every job input root, so each is bound to `undefined` (the child's default applies).
    let src = "import Cn from './Cn'\nexport default function P() { return <main><Cn id=\"a\" /></main> }";
    let s = src.to_string();
    let path = "crates/brust-compiler/tests/fixtures/slot/P.tsx".to_string();
    let (instances, child_job) = run_on_compiler_thread(move || {
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
        let child = tree
            .iter()
            .find(|c| c.ir.id.starts_with("cn"))
            .expect("Cn compiled");
        (
            tree[0].ir.instances.clone(),
            child.artifacts.server_ts.clone().unwrap_or_default(),
        )
    });
    let exprs = &instances[0].exprs;
    assert_eq!(
        exprs.get("className").map(String::as_str),
        Some("__undefined"),
        "{instances:?}"
    );
    assert_eq!(
        exprs.get("size").map(String::as_str),
        Some("__undefined"),
        "{instances:?}"
    );
    // F151: the omitted prop reaches the job absent (brust-core), so the JS destructuring default applies.
    assert!(
        child_job.contains("const { size = (\"m\") } = props"),
        "{child_job}"
    );
}

#[test]
fn a_runtime_spread_with_a_class_or_style_under_as_child_is_a_fallback_not_a_build_error() {
    // Bag spreads `attrs` (keys known only at render); the child brings class/style that would merge with it.
    let page = |kid: &str, attrs: &str| {
        format!(
            "import Bag from './Bag'\nexport default function P({{ data }}: any) {{ return <main><Bag asChild{attrs}>{kid}</Bag></main> }}"
        )
    };
    for kid in [
        "<a className=\"kid\" style={{ color: 'red' }}>x</a>",
        "<a className=\"kid\">x</a>",
        "<a style={{ color: 'red' }}>x</a>",
    ] {
        let o = lower("P.tsx", &page(kid, " attrs={data}"));
        assert!(react_with(&o, "slot-merge"), "{kid}: {:?}", o.diags);
        assert!(
            !o.diags.iter().any(|(c, _)| *c == DiagClass::Error),
            "{kid}: {:?}",
            o.diags
        );
    }
    // No class or style on the child: nothing to merge, the page stays static.
    let o = lower("P.tsx", &page("<a href=\"/x\">x</a>", " attrs={data}"));
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
}

#[test]
fn a_raw_text_child_under_as_child_stays_on_react() {
    for kid in [
        "<style>{'a > b { color: red }'}</style>",
        "<script>{'if (a > b) {}'}</script>",
    ] {
        let o = lower("P.tsx", &page(&format!("<Btn asChild>{kid}</Btn>")));
        assert!(react_with(&o, "slot-child-shape"), "{kid}: {:?}", o.diags);
    }
}

/// F363a: React's Slot hands the component's element attributes to a COMPONENT child as props (`className` joined, the
/// element's first); the child prints them where it spreads its props, so the output is what it prints when given them.
#[test]
fn as_child_over_a_static_component_gives_it_the_element_attributes_as_props() {
    let o = lower(
        "P.tsx",
        &page(
            "<Btn asChild className=\"extra\" id=\"slot\"><Link href=\"/login\" id=\"mine\" className=\"own\">Login</Link></Btn>",
        ),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    // Slot props first, the child's override them (`id`), `className` joins slot-first and then goes through Link's own.
    assert_eq!(
        render(&o.jinja),
        "<main><a class=\"link base extra own\" data-slot=\"btn\" data-variant=\"default\" id=\"mine\" href=\"/login\">Login</a></main>"
    );
}
