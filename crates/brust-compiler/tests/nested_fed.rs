//! F164 (plan 2026-10-14-shadcn-spread-fed, R34.97): a fed child (a job or `useId`) that sits inside a
//! component inlined into its callers, or inside nested lists, is an island: never the `nested-instance` error of
//! the lowering or the manifest; a prop of a fed instance the manifest cannot bind (`className={cn('a', x)}`) is an
//! island too, not the `instance-prop-path` build error.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Comp {
    id: String,
    tier: Tier,
    fallbacks: Vec<String>,
}

/// Compiles `src` as `tests/fixtures/nested-fed/P.tsx` (siblings resolve); every component of the tree.
fn lower(src: &str) -> Vec<Comp> {
    compile("P.tsx", Some(src))
}

fn compile(file: &str, src: Option<&str>) -> Vec<Comp> {
    let s = src.map(|s| s.as_bytes().to_vec());
    let path = format!("crates/brust-compiler/tests/fixtures/nested-fed/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            s,
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .expect("a fed child in the wrong place is a fallback, not a build error");
        tree.iter()
            .map(|l| Comp {
                id: l.ir.id.clone(),
                tier: l.ir.tier.clone(),
                fallbacks: l
                    .ir
                    .diagnostics
                    .iter()
                    .chain(&l.artifacts.diagnostics)
                    .filter(|d| d.class == DiagClass::Fallback)
                    .map(|d| d.rule.clone())
                    .collect(),
            })
            .collect()
    })
}

fn named<'a>(t: &'a [Comp], prefix: &str) -> &'a Comp {
    t.iter()
        .find(|c| c.id.starts_with(prefix))
        .unwrap_or_else(|| {
            panic!(
                "no component {prefix}: {:?}",
                t.iter().map(|c| &c.id).collect::<Vec<_>>()
            )
        })
}

fn is_react(c: &Comp) -> bool {
    matches!(c.tier, Tier::React { .. })
}

#[test]
fn a_fed_child_inside_an_inlined_wrapper_makes_the_wrapper_an_island() {
    let t = lower(
        "import Wrapper from './Wrapper'\nexport default function P() { return <div><Wrapper tone=\"a\" /></div> }",
    );
    let w = named(&t, "wrapper_");
    assert!(is_react(w), "{:?}", w.tier);
    assert!(
        w.fallbacks.contains(&"nested-instance".to_string()),
        "{:?}",
        w.fallbacks
    );
    let p = named(&t, "p_");
    assert!(matches!(p.tier, Tier::Static), "{:?}", p.tier);
}

#[test]
fn a_fed_child_in_nested_lists_is_a_fallback_not_an_error() {
    let t = lower(
        "import Cell from '../per-instance-jobs/Cell'\nexport default function P(props: { rows: { cells: string[] }[] }) { return <table><tbody>{props.rows.map((r, i) => <tr key={i}>{r.cells.map((c, j) => <Cell key={j} tone={c}>x</Cell>)}</tr>)}</tbody></table> }",
    );
    let p = named(&t, "p_");
    assert!(is_react(p), "{:?}", p.tier);
    assert!(
        p.fallbacks.contains(&"nested-instance".to_string()),
        "{:?}",
        p.fallbacks
    );
}

#[test]
fn a_prop_the_manifest_cannot_bind_is_a_fallback_not_a_build_error() {
    // `tone` is the output of this page's own job: the server cannot feed it to Cell's job (two-phase planning).
    let t = lower(
        "import Cell from '../per-instance-jobs/Cell'\nimport { label } from '../per-instance-jobs/label'\nexport default function P(props: { x: string }) { return <Cell tone={label(props.x)}>x</Cell> }",
    );
    let p = named(&t, "p_");
    assert!(is_react(p), "{:?}", p.tier);
    assert!(
        p.fallbacks.contains(&"instance-prop-path".to_string()),
        "{:?}",
        p.fallbacks
    );
}
