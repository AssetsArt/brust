//! Hook-hoist follow-ups from PR 2c-1 (R34.120): F237 a comma-call spelling of a hook (`(0, useId)()`) is the hook;
//! F235 a `useId()` in an element's `key` is refused; F236 the right side of `||=`, `&&=`, `??=` is not hoisted.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_component};
use brust_compiler::ir::*;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

const PRE: &str = "import { useState, useId } from 'react'\n";

fn ir(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let p = parse_tsx("H.tsx", s.into_bytes()).unwrap();
        analyze_component(&p).unwrap()
    })
}

/// (jinja, server module) of `src` compiled as a page.
fn lower(src: &str) -> (String, String) {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "crates/brust-compiler/tests/fixtures/H.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        (a.jinja.clone(), a.server_ts.clone().unwrap_or_default())
    })
}

fn rules(ir: &ComponentIR) -> Vec<&str> {
    ir.diagnostics.iter().map(|d| d.rule.as_str()).collect()
}

#[test]
fn a_comma_call_of_use_id_is_the_hook() {
    // F237: was a per-request job calling `(0, useId)()` outside a render.
    for src in [
        "export default function F() { const id = (0, useId)(); return <label htmlFor={id}>x<input id={id} /></label> }",
        "export default function F() { return <p aria-describedby={(0, useId)()}>x</p> }",
    ] {
        let a = ir(&format!("{PRE}{src}"));
        assert!(a.diagnostics.is_empty(), "{src}: {:?}", a.diagnostics);
        assert_eq!(a.use_id_slots, 1, "{src}");
        let (jinja, server) = lower(&format!("{PRE}{src}"));
        assert!(jinja.contains("_id0"), "{src}: {jinja}");
        assert!(
            !server.contains("useId"),
            "{src}: no job calls the hook:\n{server}"
        );
    }
}

#[test]
fn a_comma_call_of_use_state_is_the_hook_and_a_custom_one_is_refused() {
    let a = ir(&format!(
        "{PRE}export default function F() {{ const [n, setN] = (0, useState)(1); return <button onClick={{() => setN(n + 1)}}>{{n}}</button> }}"
    ));
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    assert_eq!(a.state.len(), 1);
    let a = ir(&format!(
        "{PRE}function useCount() {{ const [n] = useState(2); return n }}\nexport default function F() {{ const n = (0, useCount)(); return <b>{{n}}</b> }}"
    ));
    assert!(
        rules(&a).contains(&"hook-unsupported"),
        "{:?}",
        a.diagnostics
    );
}

#[test]
fn use_id_in_a_key_is_refused_by_name() {
    // F235: the JSX runtime evaluates `key` after the props, not in source order.
    for body in [
        "<div key={useId()} id={useId()}>x</div>",
        "<p><i key={useId()}>x</i></p>",
    ] {
        let a = ir(&format!(
            "{PRE}export default function F() {{ return {body} }}"
        ));
        assert!(
            rules(&a).contains(&"hook-in-expression"),
            "{body}: {:?}",
            a.diagnostics
        );
    }
}

#[test]
fn the_right_side_of_a_logical_assignment_is_not_hoisted() {
    // F236: one test per operator; each right side runs only when the short circuit lets it.
    for op in ["||=", "&&=", "??="] {
        let a = ir(&format!(
            "{PRE}export default function F() {{ const o: any = {{}}; return <p id={{(o.id {op} useId())}}>x</p> }}"
        ));
        assert!(
            rules(&a).contains(&"hook-in-expression"),
            "{op}: {:?}",
            a.diagnostics
        );
        assert_eq!(a.use_id_slots, 0, "{op}");
    }
}
