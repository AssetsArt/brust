//! F153b (Separator): a prop default that names module constants is folded to its value, so the server template can
//! print it; anything the folder does not know keeps the `prop-default-shape` fallback.
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

/// Compiles `src` as `tests/fixtures/module-const-default/<file>` (siblings in that directory resolve).
fn lower(file: &str, src: &str) -> Out {
    let s = src.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/module-const-default/{file}");
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

fn comp(body: &str) -> String {
    format!("export default function T(props: any) {{ {body} }}")
}

#[test]
fn a_default_naming_module_constants_is_folded_and_renders() {
    let o = lower(
        "A.tsx",
        "const Orientation = { Horizontal: 'horizontal', Vertical: 'vertical' } as const\nconst DEFAULT_ORIENTATION = Orientation.Horizontal\nexport default function T({ orientation = DEFAULT_ORIENTATION }: any) { return <div data-o={orientation} /> }",
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert!(
        o.diags.iter().all(|(_, r)| r != "prop-default-shape"),
        "{:?}",
        o.diags
    );
    assert_eq!(
        render(&o.jinja, serde_json::json!({})),
        "<div data-o=\"horizontal\"></div>"
    );
    assert_eq!(
        render(&o.jinja, serde_json::json!({ "orientation": "vertical" })),
        "<div data-o=\"vertical\"></div>"
    );
}

#[test]
fn a_constant_that_is_written_or_unknown_keeps_the_fallback() {
    for (name, src) in [
        (
            "B.tsx",
            "const O = { a: 'x' }\nO.a = 'y'\nexport default function T({ o = O.a }: any) { return <i data-o={o} /> }",
        ),
        (
            "C.tsx",
            "let L = 'x'\nexport default function T({ o = L }: any) { return <i data-o={o} /> }",
        ),
        (
            "D.tsx",
            "const F = Math.random()\nexport default function T({ o = F }: any) { return <i data-o={o} /> }",
        ),
        (
            "E.tsx",
            "export default function T({ o = Math.random() }: any) { return <i data-o={o} /> }",
        ),
    ] {
        let o = lower(name, src);
        assert!(
            o.diags
                .iter()
                .any(|(_, r)| r == "prop-default-shape" || r == "prop-default-iife"),
            "{name}: {:?}",
            o.diags
        );
    }
}

/// Radix's Separator, the part of it that reads the props (a `div` stands for `Primitive.div`).
const SEPARATOR: &str = r#"import * as React from 'react';
const Orientation = { Horizontal: 'horizontal', Vertical: 'vertical' } as const;
const DEFAULT_ORIENTATION = Orientation.Horizontal;
const ORIENTATIONS = Object.values(Orientation);
type Orientation = (typeof Orientation)[keyof typeof Orientation];
const Separator = React.forwardRef<HTMLDivElement, any>(function Separator(props, forwardedRef) {
  const { decorative, orientation: orientationProp = DEFAULT_ORIENTATION, ...domProps } = props;
  const orientation = isValidOrientation(orientationProp) ? orientationProp : DEFAULT_ORIENTATION;
  const ariaOrientation = orientation === Orientation.Vertical ? orientation : undefined;
  const semanticProps = decorative
    ? { role: 'none' }
    : { 'aria-orientation': ariaOrientation, role: 'separator' };
  return <div data-orientation={orientation} {...semanticProps} {...domProps} ref={forwardedRef} />;
});
function isValidOrientation(orientation: any): orientation is Orientation {
  return ORIENTATIONS.includes(orientation);
}
export default Separator;
"#;

#[test]
fn radix_separator_compiles_static_with_its_helper_call_as_a_job() {
    let o = lower("Sep.tsx", SEPARATOR);
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert!(
        o.diags.iter().all(|(c, _)| *c != DiagClass::Fallback),
        "{:?}",
        o.diags
    );
    // the `isValidOrientation(…)` call is a server job (`_s1`), not template code; the union is one attribute per key
    assert!(o.jinja.contains("{% set _d1 = _s1 %}"), "{}", o.jinja);
    assert!(
        o.jinja
            .contains("[\"role\", (\"none\" if (decorative | truthy) else \"separator\")]"),
        "{}",
        o.jinja
    );
}
