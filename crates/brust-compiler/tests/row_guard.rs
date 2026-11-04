//! F502: a per-row instance job carries the condition of the branch that renders its child (if/return chains, a switch
//! that returns in every case, `&&`, ternaries), rebased onto the page's props with the record; the server runs the job
//! for a row only where it holds. A condition the server cannot evaluate per row keeps a fixed-props clone from being
//! made (the component keeps its own tier, as before F494). Served: tests/server/loader-static-tiers.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, InstanceRecord, RowGuard, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use serde_json::json;
use std::path::PathBuf;

fn compile(file: &str) -> Vec<(ComponentIR, String)> {
    let path = format!("crates/brust-compiler/tests/fixtures/row-guard/{file}");
    run_on_compiler_thread(move || {
        compile_tree(
            &path,
            None,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .into_iter()
        .map(|l| ((*l.ir).clone(), l.artifacts.jinja.clone()))
        .collect()
    })
}

fn root_record(file: &str) -> (Vec<(ComponentIR, String)>, InstanceRecord) {
    let all = compile(file);
    assert!(
        matches!(all[0].0.tier, Tier::Static),
        "{file}: {:?}",
        all[0].0.tier
    );
    assert_eq!(
        all[0].0.instances.len(),
        1,
        "{file}: {:?}",
        all[0].0.instances
    );
    let r = all[0].0.instances[0].clone();
    assert!(r.child_id.starts_with("price_"));
    assert_eq!(r.loops, vec![Some("sections".to_string())]);
    assert!(!r.when_opaque);
    (all, r)
}

fn eq(v: &str) -> RowGuard {
    RowGuard::Eq("sections[idx].type".into(), json!(v))
}

fn not(g: RowGuard) -> RowGuard {
    RowGuard::Not(Box::new(g))
}

#[test]
fn an_if_return_chain_guards_the_rows_of_its_branch() {
    let (_, r) = root_record("IfChainPage.tsx");
    assert_eq!(
        r.when,
        Some(RowGuard::All(vec![not(eq("hero")), eq("price")]))
    );
}

#[test]
fn a_switch_desugars_to_the_same_guard() {
    let (_, r) = root_record("SwitchChainPage.tsx");
    assert_eq!(
        r.when,
        Some(RowGuard::All(vec![not(eq("hero")), eq("price")]))
    );
}

#[test]
fn an_and_and_a_ternary_guard_their_branch() {
    assert_eq!(root_record("AndRowPage.tsx").1.when, Some(eq("price")));
    // `s.type !== 'price' ? <Hero/> : <Price/>`: the else branch.
    assert_eq!(
        root_record("TernaryPage.tsx").1.when,
        Some(not(not(eq("price"))))
    );
}

#[test]
fn a_root_per_row_record_is_guarded_too() {
    assert_eq!(root_record("RootPage.tsx").1.when, Some(eq("price")));
}

/// A3: `> 0` is outside the guard subset: the record is opaque in the shared component, no clone takes it, and the list
/// keeps the tier it had before F494 (React: it cannot feed its row child per row).
#[test]
fn an_unexpressible_guard_makes_no_clone() {
    let all = compile("GtPage.tsx");
    assert!(
        all.iter().all(|(ir, _)| !ir.specialised),
        "a clone was made"
    );
    let gt = all.iter().find(|(ir, _)| ir.id.starts_with("gt_")).unwrap();
    assert!(gt.0.instances[0].when_opaque);
    assert!(gt.0.instances[0].when.is_none());
    let rows = all
        .iter()
        .find(|(ir, _)| ir.id.starts_with("rows_"))
        .unwrap();
    assert!(
        matches!(rows.0.tier, Tier::React { .. }),
        "{:?}",
        rows.0.tier
    );
}

/// A condition over state is an `x-if` the client flips: it restricts nothing (the hidden copy needs the job too).
#[test]
fn a_state_condition_restricts_nothing() {
    let all = compile("StatePage.tsx");
    let r = &all[0].0.instances;
    assert_eq!(r.len(), 1, "{r:?}");
    assert_eq!(r[0].when, None);
    assert!(!r[0].when_opaque);
}

/// F504a (review 05ee17fd a): a non-root child whose prop its stateful parent changes: the branch is an `x-if` the
/// client flips, so it restricts nothing wherever the record lands.
#[test]
fn a_changing_prop_condition_restricts_nothing() {
    let all = compile("StatefulPanelPage.tsx");
    // The record the server feeds is the page's (Panel is inlined): the page links Panel (`open` is its state), so
    // the rebase drops the guard and the job runs on every request, as the hidden copy needs.
    let page = &all[0].0;
    assert!(matches!(page.tier, Tier::Native), "{:?}", page.tier);
    assert_eq!(page.instances.len(), 1, "{:?}", page.instances);
    assert_eq!(page.instances[0].when, None);
    assert!(!page.instances[0].when_opaque);
}

/// Review 05ee17fd (b): a stateful route root's props are the loader's, fixed for the page's life: a condition over
/// them keeps guarding its job (F502), state of its own or not.
#[test]
fn a_root_prop_condition_on_a_stateful_page_still_guards() {
    let all = compile("StatefulRootPage.tsx");
    let r = &all[0].0.instances;
    assert_eq!(r.len(), 1, "{r:?}");
    assert_eq!(r[0].when, Some(RowGuard::Eq("mode".into(), json!("a"))));
}

/// F504b: a fixed-props clone names the shared component it was made of (no id-suffix sniffing).
#[test]
fn a_fixed_clone_names_its_shared_component() {
    let all = compile("IfChainPage.tsx");
    let clones: Vec<_> = all
        .iter()
        .filter(|(ir, _)| ir.fixed_clone_of.is_some())
        .collect();
    assert_eq!(clones.len(), 1);
    let of = clones[0].0.fixed_clone_of.as_deref().unwrap();
    assert!(
        of.starts_with("rows_") && clones[0].0.id.starts_with(of),
        "{of} {}",
        clones[0].0.id
    );
    // The shared component is not part of the tree (every call site took the clone).
    assert!(all.iter().all(|(ir, _)| ir.id != of));
}
