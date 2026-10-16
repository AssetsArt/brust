//! F284-F287: the four general rules the F229 spike found between a library like `@radix-ui/react-presence` and the
//! compiler: an arrow-const component, `useReducer` as a state cell plus a stable dispatch, hook calls hoisted out of a
//! returned object or return position, and `[literals].includes(x)` as the strict-equality chain. No rule knows a
//! package or a component name; every shape a rule cannot carry keeps its named refusal.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Item {
    ir: ComponentIR,
    jinja: String,
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
            &format!("crates/brust-compiler/tests/fixtures/presence-general/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap()
        .into_iter()
        .map(|l| Item {
            ir: (*l.ir).clone(),
            jinja: l.artifacts.jinja.clone(),
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

fn none_react(all: &[Item]) {
    for i in all {
        assert!(!react(&i.ir), "{}: {:?}", i.ir.id, i.ir.diagnostics);
    }
}

// F284 ----------------------------------------------------------------------------------------------------------

#[test]
fn an_arrow_const_component_is_read_like_a_function_declaration() {
    none_react(&compile("arrow_used.tsx"));
    none_react(&compile("arrow_imported.tsx"));
}

#[test]
fn an_async_arrow_or_one_reading_arguments_stays_an_island() {
    for f in ["arrow_async.tsx", "arrow_args.tsx"] {
        let all = compile(f);
        assert!(
            all.iter()
                .any(|i| matches!(&i.ir.tier, Tier::React { reason, .. }
                if reason == "export is not a function declaration")),
            "{f}: {:?}",
            all.iter()
                .map(|i| (&i.ir.id, &i.ir.tier))
                .collect::<Vec<_>>()
        );
    }
}

// F285 ----------------------------------------------------------------------------------------------------------

#[test]
fn use_reducer_is_a_state_cell_and_one_dispatch() {
    for f in [
        "reducer_inline.tsx",
        "reducer_module.tsx",
        "reducer_init.tsx",
        "reducer_hook.tsx",
        // the state is read as a child: it is a state cell (proved by its initial value), not an unknown local
        "reducer_child.tsx",
    ] {
        let all = compile(f);
        none_react(&all);
        let ir = &all[0].ir;
        // the dispatch is ONE handler declaration, so it has one identity for the life of the instance
        assert_eq!(ir.state.len(), 1, "{f}: {:?}", ir.state);
        assert!(
            ir.handlers.iter().any(|h| matches!(&h.body.kind,
                RawKind::Arrow { params, .. } if params.as_slice() == ["_a"])),
            "{f}: {:?}",
            ir.handlers
        );
        let client = all[0].client.as_deref().unwrap_or("");
        assert!(client.contains(".set("), "{f}: {client}");
    }
}

#[test]
fn a_reducer_that_is_not_provably_pure_or_not_visible_is_a_named_refusal() {
    for (f, rule) in [
        ("reducer_impure.tsx", "reducer-impure"),
        ("reducer_call.tsx", "reducer-impure"),
        ("reducer_imported.tsx", "reducer-shape"),
    ] {
        let all = compile(f);
        assert!(react(&all[0].ir), "{f}: {:?}", all[0].ir.tier);
        assert!(
            rules(&all).contains(&rule.to_string()),
            "{f}: {:?}",
            rules(&all)
        );
    }
}

// F286 ----------------------------------------------------------------------------------------------------------

#[test]
fn hooks_in_a_returned_object_and_in_the_return_position_are_hoisted() {
    let all = compile("hoist_object.tsx");
    none_react(&all);
    let ir = &all[0].ir;
    // each hoisted call is declared once, before the return, under a generated name
    assert!(
        ir.handlers.iter().any(|h| h.name.starts_with("hoist")),
        "{:?}",
        ir.handlers
    );
    assert!(
        ir.derived.iter().any(|d| d.name.starts_with("hoist")),
        "{:?}",
        ir.derived
    );
    none_react(&compile("hoist_return.tsx"));
}

#[test]
fn a_hook_in_a_conditional_or_a_function_is_still_refused() {
    for f in ["hoist_cond.tsx", "hoist_fn.tsx"] {
        let all = compile(f);
        assert!(react(&all[0].ir), "{f}: {:?}", all[0].ir.tier);
        assert!(
            rules(&all)
                .iter()
                .any(|r| r == "hook-unsupported" || r == "hook-in-expression"),
            "{f}: {:?}",
            rules(&all)
        );
    }
}

// F287 ----------------------------------------------------------------------------------------------------------

#[test]
fn includes_over_literals_is_the_strict_equality_chain() {
    let all = compile("includes_state.tsx");
    none_react(&all);
    let gate = all.iter().find(|i| i.ir.id.starts_with("gate")).unwrap();
    // one expression on the server and in the chunk: no job, no jinja `in`, no `includes` filter
    assert!(gate.ir.jobs.is_empty(), "{:?}", gate.ir.jobs);
    assert!(gate.jinja.contains(r#"(s == "a")"#), "{}", gate.jinja);
    assert!(gate.jinja.contains(r#"(s == "b")"#), "{}", gate.jinja);
    assert!(!gate.jinja.contains("| includes"), "{}", gate.jinja);
    assert!(!gate.jinja.contains(" in "), "{}", gate.jinja);
    // the chain grows linearly with its members (the `||` printer repeats its left operand, so a left-leaning fold would not)
    let big = compile("includes_prop.tsx");
    assert!(big[0].jinja.len() < 600, "{} bytes", big[0].jinja.len());
    for f in ["includes_prop.tsx", "includes_derived.tsx"] {
        let all = compile(f);
        none_react(&all);
        assert!(
            !all[0].jinja.contains("| includes"),
            "{f}: {}",
            all[0].jinja
        );
    }
}

#[test]
fn includes_keeps_its_meaning_where_the_chain_would_change_it() {
    // a `NaN` member: `===` is not SameValueZero, so the call stays JS (a job), not a chain
    let all = compile("includes_nan.tsx");
    assert!(!all[0].ir.jobs.is_empty(), "{:?}", all[0].jinja);
    // a needle over a non-literal array stays what it was
    let all = compile("includes_dynamic.tsx");
    assert!(!all[0].ir.jobs.is_empty() || react(&all[0].ir));
    // a STRING receiver is a substring test, never a membership chain
    let all = compile("includes_string.tsx");
    assert!(
        all[0].jinja.contains("| includes") || !all[0].ir.jobs.is_empty(),
        "{}",
        all[0].jinja
    );
}
