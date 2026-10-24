//! F442 (W2, ruling on challenge 137ba9e3): an attribute or a component prop may read `ref.current` during render
//! (Radix Tabs' `animationDuration: isMountAnimationPreventedRef.current ? '0s' : undefined`). The server prints the ref's
//! initial value (what the first render reads); the client reads the live ref whenever the expression's OTHER dependencies
//! recompute it. Known difference from React: a change of the ref alone repaints nothing, and the value refreshes at the
//! next change of a dependency, not at an unrelated render. A ref read anywhere else (a child, an element ref, a ref the
//! render writes) stays a refusal.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Out {
    tier: Tier,
    rules: Vec<String>,
    jinja: String,
    client: String,
}

fn compile(body: &str, jsx: &str) -> Out {
    let src = format!(
        "import * as React from 'react'
function Box({{ children, ...p }}: any) {{ return <div {{...p}}>{{children}}</div> }}
export default function C(props: any) {{
  const [on, setOn] = React.useState(true)
  const r = React.useRef(on)
  const e = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {{ r.current = false }}, [])
  {body}
  return <section><button type=\"button\" onClick={{() => setOn(!on)}}>{{String(on)}}</button>{jsx}</section>
}}
"
    );
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "crates/brust-compiler/tests/fixtures/attr-parity/T.tsx",
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        Out {
            tier: tree[0].ir.tier.clone(),
            rules: tree[0]
                .ir
                .diagnostics
                .iter()
                .map(|d| format!("{}: {}", d.rule, d.message))
                .collect(),
            jinja: tree[0].artifacts.jinja.clone(),
            client: tree[0].artifacts.client_js.clone().unwrap_or_default(),
        }
    })
}

#[test]
fn a_ref_read_in_a_style_or_a_prop_prints_its_initial_value_and_reads_the_live_ref_on_the_client() {
    for jsx in [
        // a host attribute and a component prop, with another dependency (`on`) that recomputes it
        "<div style={{ animationDuration: r.current && on ? '0s' : undefined }}>x</div>",
        "<Box style={{ animationDuration: r.current && on ? '0s' : undefined }}>y</Box>",
        // a spread object, as Radix writes it
        "<div style={{ ...props.style, animationDuration: r.current && on ? '0s' : undefined }}>x</div>",
    ] {
        let o = compile("", jsx);
        assert!(
            matches!(o.tier, Tier::Native),
            "{jsx}: {:?} {:#?}",
            o.tier,
            o.rules
        );
        // the server: the ref's initial value is the state it was seeded from, never the ref itself
        assert!(
            !o.jinja.contains(".current") && !o.jinja.contains("__undefined.current"),
            "{jsx}: {}",
            o.jinja
        );
        assert!(o.jinja.contains("0s"), "{jsx}: {}", o.jinja);
        // the client: the live ref, recomputed with `on`
        assert!(
            o.client.contains("r.current && on()"),
            "{jsx}: {}",
            o.client
        );
    }
}

#[test]
fn a_ref_alone_makes_a_value_that_is_painted_once() {
    let o = compile(
        "",
        "<div style={{ animationDuration: r.current ? '0s' : undefined }}>x</div>",
    );
    assert!(
        matches!(o.tier, Tier::Native),
        "{:?} {:#?}",
        o.tier,
        o.rules
    );
    assert!(o.jinja.contains("0s"), "{}", o.jinja);
    // nothing recomputes it: no binding (the known difference)
    assert!(!o.jinja.contains("x-bind-style"), "{}", o.jinja);
}

#[test]
fn a_ref_read_anywhere_else_stays_refused() {
    for (what, body, jsx) in [
        ("as a child", "", "<p>{String(r.current)}</p>"),
        ("as a whole", "", "<div title={String(r)}>x</div>"),
        ("another member", "", "<div title={r.foo}>x</div>"),
        // bound to an element: it holds a node after mount, not its initial value
        (
            "an element ref",
            "",
            "<div ref={e} title={String(e.current)}>x</div>",
        ),
        // written by a handler together with a state change: React shows it at that render, brust would not
        (
            "written by a handler",
            "const hit = () => { r.current = !r.current; setOn(!on) }",
            "<div title={String(r.current)} onClick={hit}>x</div>",
        ),
        // written by an effect that runs again: the attribute would go stale
        (
            "written by a repeating effect",
            "React.useEffect(() => { r.current = on }, [on])",
            "<div title={String(r.current)}>x</div>",
        ),
        // written by the render itself
        (
            "written by the render",
            "r.current = on",
            "<div title={String(r.current)}>x</div>",
        ),
    ] {
        let o = compile(body, jsx);
        assert!(
            matches!(o.tier, Tier::React { .. }),
            "{what}: {:?} {:#?}",
            o.tier,
            o.rules
        );
        assert!(
            o.rules.iter().any(|r| r.starts_with("ref-in-render")),
            "{what}: {:#?}",
            o.rules
        );
    }
}
