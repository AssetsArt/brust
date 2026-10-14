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
    unwritten: Vec<String>,
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
                unwritten: l.ir.unwritten_props.clone(),
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

/// As [`lower`], plus the route component's instance records and its template.
fn lower_full(src: &str) -> (Vec<Comp>, Vec<brust_compiler::ir::InstanceRecord>, String) {
    let s = src.as_bytes().to_vec();
    let path = "crates/brust-compiler/tests/fixtures/nested-fed/P.tsx".to_string();
    let (recs, jinja) = run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(s),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .expect("compiles");
        (
            tree[0].ir.instances.clone(),
            tree[0].artifacts.jinja.clone(),
        )
    });
    (lower(src), recs, jinja)
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
fn a_fed_child_inside_a_static_wrapper_is_rebased_onto_the_caller() {
    // R34.96 (static-wrapper case): the wrapper has no job of its own, so the caller feeds its child: the record is
    // the caller's, bound to what the call site passes, and the page keeps its tier.
    let (t, recs, jinja) = lower_full(
        "import Wrapper from './Wrapper'\nexport default function P() { return <div><Wrapper tone=\"a\" /><Wrapper /></div> }",
    );
    let p = named(&t, "p_");
    assert!(!is_react(p), "{:?} {:?}", p.tier, p.fallbacks);
    assert_eq!(recs.len(), 2, "{recs:?}");
    assert_eq!(recs[0].k, 1);
    assert_eq!(recs[1].k, 2);
    assert_eq!(recs[0].literals["tone"], serde_json::json!("a"));
    assert_eq!(recs[1].exprs["tone"], "__undefined");
    assert!(
        jinja.contains("__") && jinja.contains("_1[\"_s1\"]") && jinja.contains("_2[\"_s1\"]"),
        "{jinja}"
    );
}

#[test]
fn a_static_wrapper_with_a_fed_child_in_a_list_makes_the_caller_an_island() {
    let t = lower(
        "import Wrapper from './Wrapper'\nexport default function P(props: { xs: string[] }) { return <div>{props.xs.map((x) => <Wrapper key={x} tone={x} />)}</div> }",
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
fn a_prop_path_is_rebased_through_the_wrapper() {
    let (t, recs, _) = lower_full(
        "import Wrapper from './Wrapper'\nexport default function P(props: { t: string }) { return <div><Wrapper tone={props.t} /></div> }",
    );
    assert!(!is_react(named(&t, "p_")), "{:?}", named(&t, "p_").tier);
    assert_eq!(recs[0].props["tone"], Some("t".to_string()), "{recs:?}");
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
fn a_prop_that_is_another_jobs_output_is_fused_into_the_route_components_job() {
    // `tone` is the output of this page's own job: the child's job runs inside it (R34.96, was the
    // `instance-prop-path` fallback of PR 1).
    let t = lower(
        "import Cell from '../per-instance-jobs/Cell'\nimport { label } from '../per-instance-jobs/label'\nexport default function P(props: { x: string }) { return <Cell tone={label(props.x)}>x</Cell> }",
    );
    let p = named(&t, "p_");
    assert!(!is_react(p), "{:?} {:?}", p.tier, p.fallbacks);
}

#[test]
fn children_with_a_job_passed_to_a_component_that_repeats_them_fall_back() {
    let t = lower(
        "import List from './List'\nimport Cell from '../per-instance-jobs/Cell'\nexport default function P(props: { items: string[] }) { return <List items={props.items}><Cell tone=\"x\">x</Cell></List> }",
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
fn an_island_with_a_per_row_prop_in_two_lists_falls_back() {
    let t = lower(
        "import Tip from './Tip'\nexport default function P(props: { rows: { cols: string[] }[] }) { return <div>{props.rows.map((r, i) => <p key={i}>{r.cols.map((c) => <Tip key={c} t={c} />)}</p>)}</div> }",
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
fn an_island_mapped_inside_an_inlined_component_falls_back() {
    let t = lower(
        "import WrapTip from './WrapTip'\nexport default function P(props: { rows: string[] }) { return <WrapTip rows={props.rows} /> }",
    );
    let w = named(&t, "wrapTip_");
    assert!(is_react(w), "{:?}", w.tier);
    assert!(
        w.fallbacks.contains(&"nested-instance".to_string()),
        "{:?}",
        w.fallbacks
    );
}

/// The shapes that must keep working next to them: an island in ONE list of the route component, a fed child in
/// one list. Every shape compiles (`lower` expects `Ok`), so the lowering's errors are not reached.
#[test]
fn the_neighbouring_valid_shapes_still_compile_as_before() {
    let t = lower(
        "import Tip from './Tip'\nexport default function P(props: { rows: string[] }) { return <div>{props.rows.map((r) => <Tip key={r} t={r} />)}</div> }",
    );
    assert!(
        matches!(named(&t, "p_").tier, Tier::Static),
        "{:?}",
        named(&t, "p_").tier
    );
    let t = lower(
        "import Cell from '../per-instance-jobs/Cell'\nexport default function P(props: { rows: string[] }) { return <table><tbody>{props.rows.map((r) => <tr key={r}><Cell tone={r}>x</Cell></tr>)}</tbody></table> }",
    );
    assert!(
        matches!(named(&t, "p_").tier, Tier::Static),
        "{:?}",
        named(&t, "p_").tier
    );
}

// R34.83: a spread of the component's own props into a fed child records the job roots it may carry.

#[test]
fn a_spread_into_a_fed_child_records_the_roots_it_may_carry() {
    let t = lower(
        "import S from './SpreadWrapper'\nexport default function P() { return <div><S /></div> }",
    );
    let s = named(&t, "spreadWrapper_");
    // `tone` is a job input of Cell and not a named prop of the wrapper: the spread may carry it.
    assert_eq!(s.unwritten, vec!["tone".to_string()]);
    assert!(
        !s.fallbacks.contains(&"spread-props".to_string()),
        "{:?}",
        s.fallbacks
    );
}

#[test]
fn a_route_component_spreading_its_request_props_into_a_fed_child_is_refused() {
    // As the route component its props are the request: no call site can satisfy `unwritten_props`.
    let t = compile("RootSpread.tsx", None);
    let r = named(&t, "rootSpread_");
    assert!(is_react(r), "{:?}", r.tier);
    assert!(
        r.fallbacks.contains(&"spread-props".to_string()),
        "{:?}",
        r.fallbacks
    );
}

// F169: the repeat check is transitive. A child with `useId` (or a job) handed through one more component that
// passes `{children}` on to a repeater would print the same id in every row.

#[test]
fn a_useid_child_through_a_component_that_passes_children_to_a_repeater_falls_back() {
    let t = lower(
        "import Outer from './Outer'\nimport Ided from '../per-instance-jobs/Ided'\nexport default function P() { return <Outer><Ided text=\"x\" /></Outer> }",
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
fn plain_children_through_the_same_chain_stay_compiled() {
    let t = lower(
        "import Outer from './Outer'\nexport default function P() { return <Outer><b>x</b></Outer> }",
    );
    assert!(!is_react(named(&t, "p_")), "{:?}", named(&t, "p_").tier);
}

// R34.96 (PR 2b, analysis half): a fed child of a component with a job of its own runs inside that job.

fn fused_of(
    src: &str,
    wrapper: &str,
) -> (
    Vec<brust_compiler::ir::FusedInstance>,
    Vec<String>,
    usize,
    Vec<String>,
) {
    let s = src.as_bytes().to_vec();
    let path = "crates/brust-compiler/tests/fixtures/nested-fed/P.tsx".to_string();
    let wrapper = wrapper.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(s),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .expect("compiles");
        let w = tree
            .iter()
            .find(|l| l.ir.id.starts_with(&wrapper))
            .expect("wrapper");
        let out =
            w.ir.jobs
                .first()
                .map(|j| j.outputs.clone())
                .unwrap_or_default();
        let fb = tree[0]
            .ir
            .diagnostics
            .iter()
            .filter(|d| d.class == DiagClass::Fallback)
            .map(|d| d.rule.clone())
            .collect();
        (w.ir.fused.clone(), out, w.ir.instances.len(), fb)
    })
}

#[test]
fn a_child_fed_by_a_slot_of_its_wrapper_is_fused() {
    use brust_compiler::ir::FusedInput;
    let (fused, outputs, records, fb) = fused_of(
        "import F from './Fusing'\nexport default function P() { return <div><F x=\"a\" /></div> }",
        "fusing_",
    );
    assert_eq!(fused.len(), 1, "{fb:?}");
    let f = &fused[0];
    assert_eq!(f.ordinal, 1);
    assert!(
        matches!(f.inputs["tone"], FusedInput::Slot { .. }),
        "{:?}",
        f.inputs
    );
    assert!(matches!(f.inputs.get("children"), None), "{:?}", f.inputs);
    assert_eq!(records, 0, "a fused child has no record");
    for o in f.outputs.values() {
        assert!(
            outputs.contains(o),
            "{o} not an output of the wrapper's job: {outputs:?}"
        );
    }
    assert!(fb.is_empty(), "{fb:?}");
}

#[test]
fn a_spread_of_the_wrappers_rest_into_the_fused_child_is_allowed_by_the_spread_rule() {
    let (fused, _, records, fb) = fused_of(
        "import F from './FusingSpread'\nexport default function P() { return <div><F x=\"a\" /></div> }",
        "fusingSpread_",
    );
    assert_eq!(fused.len(), 1, "{fb:?}");
    assert_eq!(records, 0);
}
