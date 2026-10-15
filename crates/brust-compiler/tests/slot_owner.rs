//! F214: slot content printed under a native child's host element is bound by that child's instance, so a directive of the
//! caller in it (a handler, a binding that reads the caller's state, a list, a linked child) read the child's members: wrong
//! output with no diagnostic. The caller stays on React with the named fallback `slot-owner`; static slot content,
//! content the child never prints, and a static child (no host of its own) are unaffected.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Out {
    tier: Tier,
    rules: Vec<String>,
}

/// The page (`default export`) of `tests/fixtures/slot-owner/<file>`.
fn page(file: &str) -> Out {
    let path = format!("crates/brust-compiler/tests/fixtures/slot-owner/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            None,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let node = tree
            .iter()
            .find(|n| {
                n.ir.id.to_lowercase().starts_with(
                    &file
                        .trim_end_matches(".tsx")
                        .replace('-', "")
                        .to_lowercase(),
                )
            })
            .expect("the page");
        Out {
            tier: node.ir.tier.clone(),
            rules: node
                .ir
                .diagnostics
                .iter()
                .chain(&node.artifacts.diagnostics)
                .filter(|d| matches!(d.class, DiagClass::Fallback))
                .map(|d| d.rule.clone())
                .collect(),
        }
    })
}

fn refused(file: &str) {
    let o = page(file);
    assert!(
        o.rules.iter().any(|r| r == "slot-owner"),
        "{file}: {:?} {:?}",
        o.tier,
        o.rules
    );
    assert!(matches!(o.tier, Tier::React { .. }), "{file}: {:?}", o.tier);
}

fn kept(file: &str) {
    let o = page(file);
    assert!(
        !o.rules.iter().any(|r| r == "slot-owner"),
        "{file}: {:?}",
        o.rules
    );
    assert!(
        !matches!(o.tier, Tier::React { .. }),
        "{file}: {:?} {:?}",
        o.tier,
        o.rules
    );
}

#[test]
fn state_read_in_the_slot_of_a_native_child_is_refused() {
    refused("state.tsx");
}

#[test]
fn a_handler_in_the_slot_of_a_native_child_is_refused() {
    refused("handler.tsx");
}

#[test]
fn a_list_over_state_in_the_slot_of_a_native_child_is_refused() {
    refused("loop.tsx");
}

#[test]
fn a_child_with_changing_props_in_the_slot_is_refused() {
    refused("linked.tsx");
}

#[test]
fn a_handler_hoisted_onto_a_slot_child_is_refused() {
    refused("hoisted.tsx");
}

#[test]
fn a_static_wrapper_passing_children_to_a_native_child_is_refused() {
    refused("wrapped.tsx");
}

#[test]
fn constant_slot_content_stays_lowered() {
    kept("static-slot.tsx");
}

#[test]
fn a_native_child_inside_the_slot_with_constant_props_stays_lowered() {
    kept("own-native.tsx");
}

#[test]
fn a_static_child_has_no_host_of_its_own() {
    kept("static-child.tsx");
}

#[test]
fn children_the_child_never_prints_are_not_refused() {
    kept("not-rendered.tsx");
}

#[test]
fn a_wrapper_that_prints_children_outside_the_native_child_stays_lowered() {
    kept("wrapped-static.tsx");
}
