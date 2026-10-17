//! F379: an unconditional call of a CUSTOM hook in the returned expression (a JSX attribute, Radix Collapsible's
//! `contentId={useId()}` where `useId` is `@radix-ui/react-id`'s own hook) is the same call as `const x = useHook(…)`
//! before the return, in source order: it is inlined there and its value printed in its place. A conditional, looped or
//! `key` position stays refused (`hook-unsupported`, "called inside an expression").
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_component};
use brust_compiler::ir::*;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

const PRE: &str = "import { useState, useId, useCallback } from 'react'\n";

fn ir(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let p = parse_tsx("H.tsx", s.into_bytes()).unwrap();
        analyze_component(&p).unwrap()
    })
}

/// (first paint, client chunk) of `src` compiled as a page.
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
        let mut env = minijinja::Environment::new();
        brust_jinja::register(&mut env);
        let html = env
            .render_str(
                &a.jinja,
                brust_jinja::value_of(serde_json::json!({ "_props": {}, "_id0": "r0" })),
            )
            .unwrap();
        (html, a.client_js.clone().unwrap_or_default())
    })
}

const HOOKS: &str = "function useLabel(n: number) { const [x] = useState(n); return 'L' + x }\n\
function useScopedId() { const id = useId(); return 'p-' + id }\n";

#[test]
fn a_custom_hook_in_an_attribute_is_inlined_before_the_return() {
    let src = format!(
        "{PRE}{HOOKS}export default function F() {{ const [n, setN] = useState(0); return <b title={{useLabel(2)}} onClick={{() => setN(n + 1)}}>{{n}}</b> }}"
    );
    let a = ir(&src);
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let (html, _) = lower(&src);
    assert!(!html.contains("brust-island"), "{html}");
    assert!(
        html.contains(r#"title="L2""#),
        "the hook's value is printed where it was called:\n{html}"
    );
}

#[test]
fn a_custom_hook_holding_use_id_in_an_attribute_gives_one_id_slot() {
    // The Radix Collapsible shape: the value a Provider (or an element) takes is a custom hook around useId.
    let src = format!(
        "{PRE}{HOOKS}export default function F({{ label }}: any) {{ return <label htmlFor={{useScopedId()}}>{{label}}</label> }}"
    );
    let a = ir(&src);
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    assert_eq!(a.use_id_slots, 1);
    let (html, _) = lower(&src);
    assert!(html.contains(r#"for="p-"#), "{html}");
}

#[test]
fn two_custom_hooks_in_attributes_keep_source_order() {
    // Each call is its own instance of the hook: two states, read where each call was written.
    let src = format!(
        "{PRE}{HOOKS}export default function F() {{ return <p title={{useLabel(1)}} lang={{useLabel(2)}}>x</p> }}"
    );
    let a = ir(&src);
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let (html, _) = lower(&src);
    assert!(html.contains(r#"title="L1" lang="L2""#), "{html}");
}

#[test]
fn a_custom_hook_in_a_conditional_position_stays_refused() {
    for body in [
        "return <div>{n ? <i title={useLabel(1)} /> : null}</div>",
        "return <div title={n > 0 && useLabel(1)}>x</div>",
        "return <div>{[1, 2].map((i) => <i key={i} title={useLabel(i)} />)}</div>",
    ] {
        let src = format!(
            "{PRE}{HOOKS}export default function F() {{ const [n] = useState(0); {body} }}"
        );
        let a = ir(&src);
        assert!(
            a.diagnostics.iter().any(|d| d.rule == "hook-unsupported"
                && d.message == "hook useLabel is called inside an expression"),
            "{body}: {:?}",
            a.diagnostics
        );
    }
}

#[test]
fn a_custom_hook_returning_a_handler_called_in_an_attribute_is_never_a_job() {
    // The value is a client function: whatever the tier, no per-request job may name it.
    let src = format!(
        "{PRE}function useToggle(set: (f: (b: boolean) => boolean) => void) {{ return useCallback(() => set((b) => !b), [set]) }}\n\
export default function F() {{ const [on, setOn] = useState(false); return <button type=\"button\" onClick={{useToggle(setOn)}}>{{on ? 'on' : 'off'}}</button> }}"
    );
    let a = ir(&src);
    assert!(
        !matches!(a.tier, Tier::Static | Tier::Native) || a.jobs.is_empty(),
        "{:?} {:?}",
        a.tier,
        a.jobs
    );
}
