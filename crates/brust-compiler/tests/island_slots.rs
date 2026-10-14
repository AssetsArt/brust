//! shadcn S1 (R34.49-R34.53): lists, constant conditions and element-valued props inside the
//! children of a React island lower to the JSON tree (they are folded at compile time, by an
//! interpreter that never runs user code); anything else keeps the `island-children` fallback.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use serde_json::{Value, json};
use std::path::PathBuf;

fn page(file: &str) -> ComponentIR {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        let out = compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/island-slots/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap();
        out.into_iter()
            .map(|l| (*l.ir).clone())
            .find(|ir| ir.source.ends_with(&file))
            .expect("the page")
    })
}

fn is_react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

fn rule<'a>(ir: &'a ComponentIR, rule: &str) -> Option<&'a Diagnostic> {
    ir.diagnostics.iter().find(|d| d.rule == rule)
}

fn literal(ir: &ComponentIR, key: &str) -> Vec<Value> {
    ir.jobs
        .iter()
        .filter_map(|j| j.literals.get(key).cloned())
        .collect()
}

/// The page stays out of the React tier and the island's tree is `children`.
fn lowered(file: &str) -> Value {
    let ir = page(file);
    assert!(
        rule(&ir, "island-children").is_none(),
        "{file}: {:?}",
        ir.diagnostics
    );
    assert!(!is_react(&ir), "{file}: {:?}", ir.tier);
    let mut trees = children_trees(&ir);
    assert_eq!(trees.len(), 1, "{file}: {trees:?}");
    trees.remove(0)
}

fn children_trees(ir: &ComponentIR) -> Vec<Value> {
    literal(ir, "children")
}

fn fails(file: &str, needle: &str) {
    let ir = page(file);
    let d = rule(&ir, "island-children").unwrap_or_else(|| panic!("{file}: {:?}", ir.diagnostics));
    assert!(d.message.contains(needle), "{file}: {}", d.message);
    assert!(is_react(&ir), "{file}: {:?}", ir.tier);
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a.iter().map(text_of).collect(),
        Value::Object(o) => o.get("c").map(text_of).unwrap_or_default(),
        _ => String::new(),
    }
}

#[test]
fn a_list_over_a_literal_array_unrolls() {
    let tree = lowered("list-literal.tsx");
    assert_eq!(tree["t"], "ul");
    let rows = tree["c"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows[1],
        json!({ "$brust": "el", "t": "li", "p": {}, "c": [2] })
    );
}

#[test]
fn a_list_over_a_module_const_of_objects_reads_members_and_the_index() {
    let tree = lowered("list-const.tsx");
    let rows = tree["c"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let a = &rows[1]["c"][0];
    assert_eq!(a["t"], "a");
    assert_eq!(a["p"]["href"], "/inbox");
    assert_eq!(text_of(a), "1: Inbox");
}

#[test]
fn array_from_map_with_the_array_param_folds_the_scroll_area_shape() {
    let tree = lowered("list-from.tsx");
    // The folded list left no precompute slot behind: nothing computes what no node reads.
    let ir = page("list-from.tsx");
    assert!(
        ir.jobs
            .iter()
            .all(|j| !matches!(j.kind, JobKind::Precompute)),
        "{:?}",
        ir.jobs
    );
    let rows = tree.as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(text_of(&rows[0]), "v1.2.0-beta.4");
    assert_eq!(text_of(&rows[3]), "v1.2.0-beta.1");
}

#[test]
fn a_list_in_a_list_with_components_inside_unrolls_both() {
    let ir = page("list-nested.tsx");
    assert!(
        rule(&ir, "island-children").is_none(),
        "{:?}",
        ir.diagnostics
    );
    let tree = &children_trees(&ir)[0];
    let sections = tree.as_array().unwrap();
    assert_eq!(sections.len(), 3);
    // Group `a` has two <Badge> (n doubled), `b` has none, `c` one; the tone is the group name.
    let kids = |i: usize| sections[i]["c"].as_array().unwrap().clone();
    assert_eq!(kids(0).len(), 3);
    assert_eq!(kids(1).len(), 1);
    assert_eq!(kids(0)[2]["p"], json!({ "n": 4, "tone": "a" }));
    assert_eq!(kids(2)[1]["p"], json!({ "n": 6, "tone": "c" }));
}

#[test]
fn an_empty_list_lowers_to_no_children() {
    let ir = page("list-empty.tsx");
    assert!(
        rule(&ir, "island-children").is_none(),
        "{:?}",
        ir.diagnostics
    );
    assert!(!is_react(&ir));
    assert_eq!(children_trees(&ir), vec![json!([])]);
}

#[test]
fn constant_conditions_choose_their_branch() {
    let tree = lowered("cond-const.tsx");
    let items = tree.as_array().unwrap();
    assert_eq!(items.len(), 2, "{tree}");
    assert_eq!(items[0]["t"], "b");
    assert_eq!(text_of(&items[0]), "shown");
    assert_eq!(items[1]["t"], "i");
}

#[test]
fn a_condition_that_reads_a_prop_stays_a_fallback() {
    fails("cond-prop.tsx", "a condition that is not a constant");
}

#[test]
fn a_list_over_data_the_compiler_does_not_have_stays_a_fallback() {
    fails("list-prop.tsx", "a list over data that is not a constant");
}

#[test]
fn a_call_outside_the_subset_names_the_construct() {
    fails("list-filter.tsx", "filter");
}

#[test]
fn a_callback_with_a_block_body_names_itself() {
    fails("list-block.tsx", "block body");
}

#[test]
fn array_from_is_bounded() {
    fails("list-from-long.tsx", "from 0 to 10000");
}

#[test]
fn an_unrolled_list_over_the_cap_is_a_fallback() {
    fails("list-over-cap.tsx", "byte cap");
}

#[test]
fn an_element_prop_of_a_react_island_lowers_and_is_named_in_x() {
    let ir = page("elprop.tsx");
    assert!(
        rule(&ir, "island-children").is_none(),
        "{:?}",
        ir.diagnostics
    );
    assert!(rule(&ir, "jsx-expression").is_none());
    assert!(!is_react(&ir), "{:?}", ir.tier);
    let content = &literal(&ir, "content")[0];
    assert_eq!(content["$brust"], "cmp");
    assert_eq!(content["p"], json!({ "n": 1 }));
    assert_eq!(literal(&ir, "$x"), vec![json!(["content"])]);
    // The page markup carries `$x` too: the client revives from the props it hydrates with.
    fn has_x(n: &Node) -> bool {
        match n {
            Node::Component {
                props, children, ..
            } => props.iter().any(|(k, _)| k == "$x") || children.iter().any(has_x),
            Node::Element { children, .. } | Node::Fragment(children) => children.iter().any(has_x),
            _ => false,
        }
    }
    assert!(has_x(&ir.template));
    // The island's ref lists the component inside the prop, so the build imports it.
    let tip = ir.children.iter().find(|c| c.name == "Tip").unwrap();
    assert_eq!(tip.nested.as_ref().map(Vec::len), Some(1));
}

#[test]
fn a_fragment_element_prop_is_a_marked_fragment() {
    let ir = page("elprop-fragment.tsx");
    assert!(
        rule(&ir, "island-children").is_none(),
        "{:?}",
        ir.diagnostics
    );
    let content = &literal(&ir, "content")[0];
    assert_eq!(content["$brust"], "fr");
    assert_eq!(content["c"].as_array().unwrap().len(), 2);
}

#[test]
fn an_element_prop_on_a_nested_component_lists_its_names_on_the_node() {
    let tree = lowered("elprop-nested.tsx");
    assert_eq!(tree["$brust"], "cmp");
    assert_eq!(tree["x"], json!(["content"]));
    assert_eq!(tree["p"]["content"]["$brust"], "cmp");
    // Nothing else is revived: `p.title`-like data props carry no `x`.
    assert!(tree["c"][0].is_string());
}

#[test]
fn an_element_prop_that_reads_state_or_binds_a_handler_stays_a_fallback() {
    let ir = page("elprop-state.tsx");
    let d = rule(&ir, "island-children").unwrap_or_else(|| panic!("{:?}", ir.diagnostics));
    assert!(
        d.message.contains("`content`") && d.message.contains("not a constant"),
        "{}",
        d.message
    );
    fails("elprop-handler.tsx", "event handler");
}

#[test]
fn an_element_prop_on_a_static_child_keeps_jsx_expression() {
    let ir = page("elprop-static.tsx");
    assert!(
        rule(&ir, "jsx-expression").is_some(),
        "{:?}",
        ir.diagnostics
    );
    assert!(is_react(&ir));
}

#[test]
fn an_element_prop_named_dollar_x_is_refused_as_a_reserved_prop() {
    let ir = page("elprop-reserved.tsx");
    assert!(rule(&ir, "island-prop").is_some(), "{:?}", ir.diagnostics);
    assert!(is_react(&ir));
}

/// Review F1: a call-site `$x` (written, or inlined from a literal spread) would let data revive as elements.
#[test]
fn a_user_written_dollar_x_prop_on_an_island_fails_closed() {
    for f in ["x-written.tsx", "x-spread.tsx"] {
        let ir = page(f);
        let d = rule(&ir, "island-prop").unwrap_or_else(|| panic!("{f}: {:?}", ir.diagnostics));
        assert!(
            d.message.contains("`$x`") && d.message.contains("reserves"),
            "{f}: {}",
            d.message
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
        // No `$x` literal reaches an instance job from the call site.
        assert!(literal(&ir, "$x").is_empty(), "{f}");
    }
}

#[test]
fn a_dollar_prop_on_a_nested_component_does_not_lower() {
    // A nested component node cannot carry a `$`-named prop in its tree either.
    let ir = page("x-nested.tsx");
    let d = rule(&ir, "island-children").unwrap_or_else(|| panic!("{:?}", ir.diagnostics));
    assert!(d.message.contains("reserves"), "{}", d.message);
}
