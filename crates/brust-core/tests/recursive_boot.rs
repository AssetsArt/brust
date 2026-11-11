//! F523 C7: the server boots a template that defines a recursive component's macro (the first macro brust emits), renders a
//! tree through it, and past the depth cap fails with the message `recursion_limit` gives, naming the component.
use std::collections::BTreeMap;

use brust_core::render::Renderer;
use serde_json::json;

/// The shape the compiler prints: the macro after the header, mangled positional parameters, the depth counter last, and
/// a guard at the head of the body.
const PAGE: &str = concat!(
    "{# brust v2 · page_1 · do not edit -#}\n",
    "{%- macro __rc_nodeView_ab12(_p_n, __rc_depth) -%}",
    "{% if __rc_depth > 32 %}{{ recursion_limit(\"NodeView\", 32) }}{% endif %}",
    "<li>{{ _p_n.label | e }}{% if _p_n.children %}<ul>{% for c in _p_n.children %}",
    "{{ __rc_nodeView_ab12(c, __rc_depth + 1) }}{% endfor %}</ul>{% endif %}</li>",
    "{%- endmacro -%}",
    "<ul>{% for n in nodes %}{{ __rc_nodeView_ab12(n, 1) }}{% endfor %}</ul>"
);

fn renderer() -> Renderer {
    let mut t = BTreeMap::new();
    t.insert("page_1".to_string(), PAGE.to_string());
    Renderer::from_templates(&t).expect("a template with a recursive macro boots")
}

fn chain(depth: usize) -> serde_json::Value {
    let mut n = json!({ "label": format!("L{depth}") });
    for d in (1..depth).rev() {
        n = json!({ "label": format!("L{d}"), "children": [n] });
    }
    n
}

#[test]
fn the_renderer_boots_and_renders_a_recursive_macro() {
    let out = renderer()
        .render("page_1", &json!({ "nodes": [chain(3)] }))
        .unwrap();
    assert_eq!(
        out,
        "<ul><li>L1<ul><li>L2<ul><li>L3</li></ul></li></ul></li></ul>"
    );
}

#[test]
fn past_the_cap_the_render_names_the_component() {
    let r = renderer();
    assert!(r.render("page_1", &json!({ "nodes": [chain(32)] })).is_ok());
    let e = r
        .render("page_1", &json!({ "nodes": [chain(40)] }))
        .unwrap_err();
    assert!(
        e.to_string()
            .contains("<NodeView> nested more than 32 levels"),
        "{e}"
    );
}
