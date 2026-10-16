//! F214: slot content printed under a native child's host element is bound by that child's instance, so a directive of the
//! caller in it (a handler, a binding that reads the caller's state, a list, a linked child) read the child's members: wrong
//! output with no diagnostic. The caller stays on React with the named fallback `slot-owner`; static slot content,
//! content the child never prints, and a static child (no host of its own) are unaffected. F309: a static child LINKED
//! at the call site has a host of its own there, so the same holds for it.
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
    component(file, &file.trim_end_matches(".tsx").replace('-', ""))
}

/// The component whose id starts with `prefix` (case-insensitive) in the tree of the fixture.
fn component(file: &str, prefix: &str) -> Out {
    let prefix = prefix.to_lowercase();
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
            .find(|n| n.ir.id.to_lowercase().starts_with(&prefix))
            .expect("the component");
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

/// Mellow F1 (round 1): slot content that reads a PROP the client changes (its component is linked by a caller passing
/// state) is the same bypass as reading state: one predicate covers every arm.
#[test]
fn a_prop_the_client_changes_in_the_slot_of_a_native_child_is_refused() {
    let o = component("linked-prop.tsx", "mid");
    assert!(
        o.rules.iter().any(|r| r == "slot-owner"),
        "{:?} {:?}",
        o.tier,
        o.rules
    );
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.tier);
}

#[test]
fn a_static_child_linked_here_hosts_its_slot_content_too() {
    // F309: wrong output on main before this (the Thumb never updated, a console warning only).
    refused("linked-static.tsx");
    kept("linked-static-const.tsx");
}

#[test]
fn children_carried_by_a_rest_onto_a_host_are_refused_too() {
    // F342: wrong output on main before this (the page's text bound by the child's instance: first-paint mismatch and the
    // child's own counter shown), through the rest, the whole props, and a static child linked at the call site.
    refused("rest-host.tsx");
    refused("rest-host-props.tsx");
    refused("rest-host-linked.tsx");
    kept("rest-host-const.tsx");
}

#[test]
fn children_forwarded_by_an_unlinked_static_intermediate_into_a_host_are_refused() {
    // F342 (Mellow F1): the intermediate spreads its rest (or props) into the host; neither guard saw it, the page's text
    // was bound by the host.
    refused("rest-host-mid.tsx");
    refused("rest-host-mid-slot.tsx");
    kept("rest-host-mid-const.tsx");
}
