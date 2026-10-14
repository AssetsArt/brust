//! shadcn S3 (R34.63, R34.64): `forwardRef` components read like function components; the forwarded ref is dropped
//! on a host element and every other use of it needs React.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "tests/fixtures/forwardref-const/input.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn has(ir: &ComponentIR, rule: &str) -> bool {
    ir.diagnostics.iter().any(|d| d.rule == rule)
}

#[test]
fn a_default_export_forwardref_is_a_component_and_drops_the_ref() {
    let ir = analyze(
        "import { forwardRef } from 'react'\nexport default forwardRef<HTMLInputElement, any>(function F(props, ref) { return <input ref={ref} id={props.id} /> })",
    );
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.diagnostics);
    assert!(ir.forwards_ref);
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
}

#[test]
fn the_default_export_may_name_a_forwardref_const() {
    let ir = analyze(
        "import * as React from 'react'\nconst F = React.forwardRef<any, any>((props, ref) => <p ref={ref}>{props.t}</p>)\nexport default F",
    );
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.diagnostics);
    assert!(ir.forwards_ref);
}

#[test]
fn reading_the_forwarded_ref_any_other_way_is_a_fallback() {
    for body in [
        "useImperativeHandle(ref, () => ({})); return <div />",
        "return <div ref={(n) => { if (ref) (ref as any).current = n }} />",
        "const r = ref; return <div />",
        "return <div data-x={String(ref)} />",
        // N1: a dropped `ref={ref}` never pays for a read elsewhere, however many hosts carry it.
        "const r = ref; return <div><i ref={ref} /><b ref={ref} /></div>",
        "return <div><i ref={ref} /><b data-x={String(ref)} /></div>",
    ] {
        let ir = analyze(&format!(
            "import {{ forwardRef, useImperativeHandle }} from 'react'\nexport default forwardRef<any, any>(function F(props, ref) {{ {body} }})"
        ));
        assert!(has(&ir, "forwardref-ref"), "{body}: {:?}", ir.diagnostics);
        assert!(matches!(ir.tier, Tier::React { .. }), "{body}");
    }
}

#[test]
fn a_destructured_second_parameter_falls_back() {
    let ir = analyze(
        "import { forwardRef } from 'react'\nexport default forwardRef<any, any>(function F(props, { current }) { return <div /> })",
    );
    assert!(has(&ir, "forwardref-ref"));
}

#[test]
fn a_plain_function_with_two_parameters_is_not_a_forwardref() {
    let ir =
        analyze("export default function F(props: any, ref: any) { return <div ref={ref} /> }");
    assert!(!ir.forwards_ref);
    assert!(!has(&ir, "forwardref-ref"));
}

#[test]
fn forwardref_from_somewhere_else_is_not_react_forwardref() {
    // `forwardRef` imported from another module is an unknown function, not React's: not read as a component
    let ir = analyze(
        "import { forwardRef } from './mine'\nexport default forwardRef(function F(props: any, ref: any) { return <div ref={ref} /> })",
    );
    assert!(!ir.forwards_ref);
    assert!(has(&ir, "default-export-shape"));
}

#[test]
fn a_call_site_ref_makes_the_caller_react() {
    // tests/fixtures/forwardref-fallback: `<Plain ref={r} />`
    let path = "tests/fixtures/forwardref-fallback/input.tsx".to_string();
    let ir = run_on_compiler_thread(move || {
        brust_compiler::analyze::component::analyze_file(
            &path,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    });
    assert!(has(&ir, "forwardref-ref"));
    assert!(matches!(ir.tier, Tier::React { .. }));
}

#[test]
fn forwards_ref_is_absent_from_the_ir_when_false() {
    let ir = analyze("export default function F() { return <p /> }");
    assert!(!serde_json::to_string(&ir).unwrap().contains("forwards_ref"));
}
