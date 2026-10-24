//! F423: a component local named like a minijinja reserved name (`useState` `loop`) was emitted as `{% set loop %}`,
//! which minijinja refuses, so `brust start` failed for the WHOLE app. Every state cell, list item and list index is
//! printed under a mangled template name when its own would be refused or shadow something the template uses.
mod lower_common;
use brust_compiler::analyze::names::JINJA_RESERVED_LOCALS;
use brust_compiler::lower::render_debug::render;
use lower_common::lower;
use serde_json::json;

/// The members of the list that are valid JS identifiers (`true`, `false`, `in`, `if`, `else` are not).
fn locals() -> Vec<&'static str> {
    JINJA_RESERVED_LOCALS
        .iter()
        .copied()
        .filter(|n| !["true", "false", "in", "if", "else"].contains(n))
        .collect()
}

fn paints(src: &str, props: serde_json::Value) -> String {
    let a = lower(src);
    match render(&a.jinja, &props, &json!({}), &[]) {
        Ok(h) => h,
        Err(e) => panic!("{e}\n{src}\n{}", a.jinja),
    }
}

#[test]
fn a_state_cell_named_like_a_reserved_name_paints_its_value() {
    for n in locals() {
        let src = format!(
            "import {{ useState }} from 'react'\nexport default function T() {{ const [{n}, setQ_] = useState(7); return <p onClick={{() => setQ_(1)}}>{{{n}}}</p> }}\n"
        );
        let h = paints(&src, json!({}));
        assert!(h.contains(">7<"), "{n}: {h}");
    }
}

#[test]
fn a_list_item_named_like_a_reserved_name_paints_every_row() {
    for n in locals() {
        let src = format!(
            "export default function T({{ xs }}: any) {{ return <ul>{{xs.map(({n}: any) => <li key={{{n}}}>{{{n}}}</li>)}}</ul> }}\n"
        );
        let h = paints(&src, json!({ "xs": [7, 8] }));
        assert!(h.contains(">7<") && h.contains(">8<"), "{n}: {h}");
    }
}

#[test]
fn a_list_index_named_like_a_reserved_name_paints_its_position() {
    for n in locals() {
        let src = format!(
            "export default function T({{ xs }}: any) {{ return <ul>{{xs.map((x: any, {n}: number) => <li key={{{n}}}>{{x}}:{{{n}}}</li>)}}</ul> }}\n"
        );
        let h = paints(&src, json!({ "xs": ["a", "b"] }));
        assert!(h.contains("a</span>:") || h.contains("a:"), "{n}: {h}");
        assert!(h.contains(">1<") || h.contains(":1"), "{n}: {h}");
    }
}

#[test]
fn the_mangled_name_keeps_clear_of_the_components_own_names() {
    // `_loop` is taken by another state: the cell named `loop` takes the next free name, and both paint their own value.
    let src = "import { useState } from 'react'\nexport default function T() { const [loop, setA_] = useState(7); const [_loop, setB_] = useState(9); return <p onClick={() => { setA_(1); setB_(2) }}>{loop}-{_loop}</p> }\n";
    let h = paints(src, json!({}));
    assert!(h.contains(">7<") && h.contains(">9<"), "{h}");
}

#[test]
fn a_state_named_range_does_not_shadow_array_from() {
    let src = "import { useState } from 'react'\nexport default function T() { const [range, setR_] = useState(2); return <ul onClick={() => setR_(3)}>{Array.from({ length: 3 }).map((_, i) => <li key={i}>{i}</li>)}<li>{range}</li></ul> }\n";
    let h = paints(src, json!({}));
    assert!(
        h.contains(">0<") && h.contains(">2<") && h.contains(">2</"),
        "{h}"
    );
}

#[test]
fn the_reserved_list_covers_every_global_function_the_template_environment_has() {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    for (name, v) in env.globals() {
        if v.kind() == minijinja::value::ValueKind::Plain || name == "debug" {
            assert!(
                JINJA_RESERVED_LOCALS.contains(&name),
                "`{name}` is a template global a local could shadow: add it to JINJA_RESERVED_LOCALS"
            );
        }
    }
}
