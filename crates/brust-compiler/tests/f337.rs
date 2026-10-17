//! F337: a child whose values derive from a prop through plain module helpers (placed as job slots) follows a prop its
//! caller changes: its chunk recomputes them (`plain_fn::client_value`), the link is no longer refused
//! (`linked-prop-precompute`), and the per-instance record binds the caller's state to the value the server paints
//! (M2). Fail closed: a host-dependent helper (Mellow A2) and a lazy initial value (A5) keep their refusals. The served
//! side (Radix Progress.Root, every kind of value, == React) is tests/server/shadcn-progress.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Item {
    ir: ComponentIR,
    jinja: String,
}

fn compile(file: &str) -> Vec<Item> {
    let path = format!("crates/brust-compiler/tests/fixtures/f337/{file}");
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
        .map(|l| Item {
            ir: (*l.ir).clone(),
            jinja: l.artifacts.jinja.clone(),
        })
        .collect()
    })
}

fn fallbacks(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| d.rule.clone())
        .collect()
}

/// The page's state feeds `<Simple v>`, whose `text = pct(v)` is a job slot over the prop: the page is native, the
/// child binds `data-t` to a member its chunk recomputes. A state seeded from a props path is bound by that path.
#[test]
fn a_changing_prop_reaches_values_the_child_derives_through_plain_helpers() {
    for f in ["live.tsx", "path_init.tsx"] {
        let all = compile(f);
        assert!(
            matches!(all[0].ir.tier, Tier::Native),
            "{f}: {:?}",
            fallbacks(&all[0].ir)
        );
        let child = all.iter().find(|i| i.ir.id.starts_with("simple_")).unwrap();
        assert!(
            child.jinja.contains("x-bind-data-t="),
            "{f}: {}",
            child.jinja
        );
    }
}

/// Mellow A2: `toLocaleString` depends on the host, so the chunk cannot reprint the server's value: refused as before.
#[test]
fn a_host_dependent_helper_keeps_the_link_refused() {
    let all = compile("host_dep.tsx");
    assert!(matches!(all[0].ir.tier, Tier::React { .. }));
    assert!(fallbacks(&all[0].ir).contains(&"linked-prop-precompute".to_string()));
}

/// Mellow A5: a lazy initial value is not a seed the instance record binds.
#[test]
fn a_lazy_initial_state_is_not_a_seed() {
    let all = compile("lazy.tsx");
    assert!(matches!(all[0].ir.tier, Tier::React { .. }));
    assert!(fallbacks(&all[0].ir).contains(&"instance-prop-path".to_string()));
}
