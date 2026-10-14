//! shadcn S3 (R34.66): `const { a, b = 1, ...rest } = props` at the top level of a component body binds props like
//! the parameter pattern; any other destructuring stays a `body-shape` fallback.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "tests/fixtures/body-destructure/input.tsx",
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

fn comp(body: &str) -> ComponentIR {
    analyze(&format!(
        "export default function C(props: any) {{ {body} }}"
    ))
}

#[test]
fn a_body_pattern_reads_like_the_parameter_pattern() {
    let body = comp(
        "const { label, size = 'm', ...rest } = props; return <button data-size={size} {...rest}>{label}</button>",
    );
    let param = analyze(
        "export default function C({ label, size = 'm', ...rest }: any) { return <button data-size={size} {...rest}>{label}</button> }",
    );
    assert!(matches!(body.tier, Tier::Static), "{:?}", body.diagnostics);
    assert!(body.diagnostics.is_empty(), "{:?}", body.diagnostics);
    // same props, same rest, same template as the parameter pattern (the plain `props` binding aside)
    let names = |ir: &ComponentIR| ir.props.iter().map(|p| p.name.clone()).collect::<Vec<_>>();
    assert!(
        names(&body).contains(&"label".to_string()) && names(&body).contains(&"size".to_string())
    );
    assert_eq!(body.props_rest, param.props_rest);
    // (`loc` differs: the two sources are laid out differently)
    fn bare(v: &mut serde_json::Value) {
        match v {
            serde_json::Value::Object(o) => {
                o.remove("loc");
                o.values_mut().for_each(bare);
            }
            serde_json::Value::Array(a) => a.iter_mut().for_each(bare),
            _ => {}
        }
    }
    let tree = |ir: &ComponentIR| {
        let mut v = serde_json::to_value(&ir.template).unwrap();
        bare(&mut v);
        v
    };
    assert_eq!(tree(&body), tree(&param));
}

#[test]
fn several_patterns_without_a_rest_and_a_props_read_may_mix() {
    let ir =
        comp("const { a } = props; const { b = 2 } = props; return <p title={a}>{b}{props.c}</p>");
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.diagnostics);
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
}

#[test]
fn a_rest_pattern_must_be_the_only_pattern() {
    // JS: the rest of the second pattern still carries `a`; brust's one list of declared props could not say so
    for body in [
        "const { a } = props; const { b, ...rest } = props; return <p {...rest}>{a}{b}</p>",
        "const { b, ...rest } = props; const { a } = props; return <p {...rest}>{a}{b}</p>",
    ] {
        let ir = comp(body);
        assert!(has(&ir, "body-shape"), "{body}: {:?}", ir.diagnostics);
        assert!(matches!(ir.tier, Tier::React { .. }), "{body}");
    }
}

#[test]
fn the_plain_props_binding_is_not_a_prop_named_props() {
    let ir = comp("const { a, ...rest } = props; return <p {...rest}>{a}</p>");
    assert!(ir.props.iter().all(|p| p.name != "props"), "{:?}", ir.props);
}

#[test]
fn everything_else_keeps_body_shape() {
    for body in [
        "const { a: { b } } = props; return <p>{b}</p>",
        "const { a, ...r1 } = props; const { b, ...r2 } = props; return <p {...r1} {...r2}>{a}{b}</p>",
        "const { a } = props.inner; return <p>{a}</p>",
        "const [x] = props.list; return <p>{x}</p>",
        "const { ['a' + 'b']: v } = props; return <p>{v}</p>",
    ] {
        let ir = comp(body);
        assert!(
            has(&ir, "body-shape") || has(&ir, "prop-pattern"),
            "{body}: {:?}",
            ir.diagnostics
        );
        assert!(matches!(ir.tier, Tier::React { .. }), "{body}");
    }
    let ir = comp("let { a } = props; return <p>{a}</p>");
    assert!(has(&ir, "let-var"));
}

#[test]
fn a_pattern_over_a_different_binding_is_not_absorbed() {
    let ir = analyze(
        "export default function C(props: any) { const other = props; const { a } = other; return <p>{a}</p> }",
    );
    assert!(has(&ir, "body-shape"), "{:?}", ir.diagnostics);
}

#[test]
fn the_pattern_is_not_absorbed_when_the_first_parameter_is_already_a_pattern() {
    let ir = analyze(
        "export default function C({ x }: any, props: any) { const { a } = props; return <p>{x}{a}</p> }",
    );
    assert!(has(&ir, "body-shape"), "{:?}", ir.diagnostics);
}

#[test]
fn a_default_that_reads_a_body_local_stays_body_shape() {
    // Review F1: the absorbed statement is skipped and its defaults are read before the body's bindings exist, so a
    // default naming a body local would print an unbound name. Parameter patterns cannot do this.
    for body in [
        "const d = props.k + '!'; const { a = d } = props; return <p>{a}</p>",
        "const d = 'x'; const { a = d } = props; return <p>{a}</p>",
        "const d = 1; const { a = () => d } = props; return <p>{String(a)}</p>",
    ] {
        let ir = comp(body);
        assert!(has(&ir, "body-shape"), "{body}: {:?}", ir.diagnostics);
    }
    // A default that reads only a module constant (or a literal) is still absorbed.
    let ir = analyze(
        "const D = 'z'\nexport default function C(props: any) { const { a = D } = props; return <p>{a}</p> }",
    );
    assert!(!has(&ir, "body-shape"), "{:?}", ir.diagnostics);
}
