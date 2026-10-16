//! F289: `const t = useHook()` of a hook that returns an object (or array) literal holding a handler. The object is read
//! member by member (`t.key`, `t[0]`), like a destructuring; it used to be one derived value naming the handler's local,
//! a per-request job that threw a ReferenceError (a 500). A use of `t` as a whole, or through a nested or dynamic key,
//! stays a named refusal.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Item {
    ir: ComponentIR,
    client: Option<String>,
}

fn compile(file: &str) -> Vec<Item> {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/hook-object-bind/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap()
        .into_iter()
        .map(|l| Item {
            ir: (*l.ir).clone(),
            client: l.artifacts.client_js.clone(),
        })
        .collect()
    })
}

fn react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

fn rules(all: &[Item]) -> Vec<String> {
    all.iter()
        .flat_map(|i| i.ir.diagnostics.iter().map(|d| d.rule.clone()))
        .collect()
}

/// Native, with no job: a job naming a handler or setter local is the leak (`ReferenceError` in the job's JS).
fn bound_per_member(file: &str) -> Item {
    let mut all = compile(file);
    assert_eq!(all.len(), 1, "{file}");
    let i = all.remove(0);
    assert!(!react(&i.ir), "{file}: {:?}", i.ir.diagnostics);
    let derived = format!("{:?}", i.ir.derived);
    assert!(
        !derived.contains("Precomputed"),
        "{file}: a job was made for the hook object: {derived}"
    );
    i
}

#[test]
fn a_hook_object_bound_whole_is_read_member_by_member() {
    for f in [
        "whole_handler.tsx",
        "whole_hoisted.tsx",
        "whole_setter.tsx",
        "whole_array.tsx",
        "whole_computed.tsx",
    ] {
        let i = bound_per_member(f);
        assert!(i.client.is_some(), "{f}");
    }
}

#[test]
fn destructuring_the_same_hook_is_unchanged() {
    bound_per_member("destructured.tsx");
}

#[test]
fn a_hook_object_used_as_a_whole_or_by_a_dynamic_or_nested_key_is_a_named_refusal() {
    for f in [
        "whole_bare.tsx",
        "whole_index.tsx",
        "whole_nested.tsx",
        // not a literal: a useMemo of the object, a spread in it: a job would name the handler
        "whole_memo.tsx",
        "whole_spread.tsx",
        // an identifier the hook returns: an object held in a local, not the literal the call site can read
        "whole_ident.tsx",
        "whole_ident_fn.tsx",
    ] {
        let all = compile(f);
        assert!(
            all.iter().any(|i| react(&i.ir)),
            "{f}: {:?}",
            all.iter().map(|i| &i.ir.tier).collect::<Vec<_>>()
        );
        assert!(
            rules(&all).contains(&"hook-return-shape".to_string()),
            "{f}: {:?}",
            rules(&all)
        );
    }
}

#[test]
fn a_value_the_component_computes_from_a_handler_is_a_named_refusal() {
    // `const o = { cb: toggle }` is a per-request job naming a handler the client owns (a 500), with `toggle` read from the
    // hook whole (`t.toggle`) or destructured (that second one is the same on main before F289).
    for f in ["comp_member.tsx", "comp_destruct.tsx"] {
        let all = compile(f);
        assert!(
            all.iter().any(|i| react(&i.ir)),
            "{f}: {:?}",
            all.iter().map(|i| &i.ir.tier).collect::<Vec<_>>()
        );
        assert!(
            rules(&all).contains(&"client-function-in-job".to_string()),
            "{f}: {:?}",
            rules(&all)
        );
    }
}
