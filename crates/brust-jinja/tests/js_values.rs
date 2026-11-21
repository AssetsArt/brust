//! F585: NaN, ±Infinity and bigint job values, decoded from the job wrapper's tag ([`brust_jinja::ctx::decode_slot`]),
//! through every template filter equal JS (`gen-js-values.ts`); the decode itself and its escape.
use brust_jinja::ctx::{JS_TAG, JsVal, Node, decode_slot, js_scalar};
use serde_json::json;

mod table {
    include!("js_values_table.rs");
}

fn tag(s: &str) -> serde_json::Value {
    json!({ JS_TAG: s })
}

fn decoded(v: serde_json::Value) -> Node {
    let mut n = Node::from(v);
    decode_slot(&mut n);
    n
}

fn ctx() -> minijinja::Value {
    let mut m = brust_jinja::ctx::MapInner::new();
    for (k, t) in [
        ("nan", "NaN"),
        ("inf", "Infinity"),
        ("ninf", "-Infinity"),
        ("b10", "10n"),
        ("b0", "0n"),
        ("bneg", "-3n"),
    ] {
        m.insert(k.into(), decoded(tag(t)));
    }
    Node::map(m).to_value()
}

#[test]
fn js_values_through_filters_equal_javascript() {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let ctx = ctx();
    let mut bad = Vec::new();
    for (expr, want) in table::TABLE {
        // A boolean result is printed as JS's `String(b)`.
        let got = env
            .render_str(&format!("{{{{ ({expr}) | js_string }}}}"), ctx.clone())
            .map_or_else(|_| "ERR".to_string(), |s| s);
        let got = match got.as_str() {
            "True" => "true".into(),
            "False" => "false".into(),
            _ => got,
        };
        if got != *want {
            bad.push(format!("{expr}: got {got}, JS {want}"));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} differ:\n{}",
        bad.len(),
        table::TABLE.len(),
        bad.iter().take(60).cloned().collect::<Vec<_>>().join("\n")
    );
}

fn scalar(n: &Node) -> Option<JsVal> {
    n.as_map().and_then(js_scalar)
}

#[test]
fn decode_reads_each_tag() {
    assert!(matches!(scalar(&decoded(tag("NaN"))), Some(JsVal::Float(f)) if f.is_nan()));
    assert_eq!(
        scalar(&decoded(tag("Infinity"))),
        Some(JsVal::Float(f64::INFINITY))
    );
    assert_eq!(
        scalar(&decoded(tag("-Infinity"))),
        Some(JsVal::Float(f64::NEG_INFINITY))
    );
    assert_eq!(
        scalar(&decoded(tag("123456789012345678901234567890n"))),
        Some(JsVal::BigInt("123456789012345678901234567890".into()))
    );
    assert_eq!(
        scalar(&decoded(tag("-0n"))),
        Some(JsVal::BigInt("-0".into()))
    );
}

#[test]
fn decode_covers_top_level_array_items_only() {
    let n = decoded(json!([1, tag("NaN"), [tag("NaN")], { "x": tag("10n") }]));
    let a = n.as_arr().unwrap();
    assert!(matches!(scalar(&a.0[1]), Some(JsVal::Float(f)) if f.is_nan()));
    // Nested deeper: left as parsed (the wrapper never tags there), never read as a number.
    assert_eq!(scalar(&a.0[2].as_arr().unwrap().0[0]), None);
    assert_eq!(scalar(a.0[3].get("x").unwrap()), None);
    // An object slot's members are not decoded.
    assert_eq!(
        scalar(decoded(json!({ "a": tag("NaN") })).get("a").unwrap()),
        None
    );
}

#[test]
fn an_app_object_carrying_the_key_round_trips() {
    // The wrapper escapes it as {TAG: {o: <it>}}; decoding gives the app's object back, at both depths, unmarked.
    let own = json!({ JS_TAG: "NaN" });
    let top = decoded(json!({ JS_TAG: { "o": own } }));
    assert_eq!(top, Node::from(own.clone()));
    assert_eq!(scalar(&top), None);
    let n = decoded(json!([{ JS_TAG: { "o": own } }]));
    assert_eq!(n, Node::from(json!([own])));
    assert_eq!(scalar(&n.as_arr().unwrap().0[0]), None);
}

#[test]
fn a_parsed_object_shaped_like_a_tag_is_never_read_as_one() {
    // Anywhere the wrapper did not tag (a nested value, loader data), the same JSON is a plain object to every filter.
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let mut m = brust_jinja::ctx::MapInner::new();
    m.insert("x".into(), Node::from(tag("NaN")));
    let got = env
        .render_str(
            "{{ x | e }}|{{ x | truthy }}|{{ x | js_add(1) | js_string }}",
            Node::map(m).to_value(),
        )
        .unwrap();
    assert!(!got.starts_with("NaN|"), "{got}");
    assert!(got.to_lowercase().contains("|true|"), "{got}");
}

#[test]
fn malformed_tags_are_left_as_parsed() {
    for v in [
        tag("nan"),
        tag("10"),
        tag("1.5n"),
        tag("n"),
        json!({ JS_TAG: 1 }),
        json!({ JS_TAG: "NaN", "b": 1 }),
    ] {
        let d = decoded(v.clone());
        assert_eq!(d, Node::from(v));
        assert_eq!(scalar(&d), None);
    }
}

#[test]
fn json_attr_writes_what_the_client_can_parse() {
    // NaN / ±Infinity are null (JSON.stringify's own answer), a bigint its digits as a string.
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let got = env
        .render_str(
            "{{ {'a': nan, 'b': b10, 'c': [inf, bneg]} | json_attr }}",
            ctx(),
        )
        .unwrap();
    assert!(
        got.contains("null") && got.contains("10") && got.contains("-3"),
        "{got}"
    );
}

#[test]
fn the_new_kind_does_not_grow_the_node() {
    // Every parse and render walks `Node`: F585 adds no kind to it (a new kind cost every page about 1%).
    assert!(
        std::mem::size_of::<Node>() <= 24,
        "{}",
        std::mem::size_of::<Node>()
    );
}

/// F585 (N1): a decoded NaN / Infinity / bigint is a number to JS and has no keys: `Object.keys`, `Object.entries`,
/// `Object.assign` and a props spread see nothing of it (as on a build without the tag, where it was `null`), never the
/// tag's internal key. One position per assertion.
#[test]
fn a_tagged_scalar_has_no_keys_in_any_position() {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let ctx = ctx();
    let render = |t: &str| env.render_str(t, ctx.clone()).unwrap();
    for v in ["nan", "inf", "ninf", "b10", "b0", "bneg"] {
        // Object.keys
        assert_eq!(
            render(&format!("{{{{ {v} | keys | length }}}}")),
            "0",
            "keys of {v}"
        );
        assert_eq!(
            render(&format!("{{{{ {v} | keys | js_string }}}}")),
            "",
            "keys of {v}"
        );
        // Object.entries
        assert_eq!(
            render(&format!("{{{{ {v} | entries | length }}}}")),
            "0",
            "entries of {v}"
        );
        // Object.assign({}, v) adds nothing, alone and next to a real object
        assert_eq!(
            render(&format!("{{{{ obj_assign({v}) | keys | length }}}}")),
            "0",
            "obj_assign of {v}"
        );
        assert_eq!(
            render(&format!(
                "{{{{ obj_assign(obj_lit('a', 1), {v}) | keys | js_string }}}}"
            )),
            "a",
            "obj_assign beside an object, {v}"
        );
        // <div {...v}> prints no attribute (React: a number spreads nothing)
        assert_eq!(
            render(&format!("<div{{{{ spread_attrs({v}) }}}}>")),
            "<div>",
            "spread of {v}"
        );
        assert_eq!(
            render(&format!(
                "<div{{{{ spread_attrs(obj_lit('id', 'x'), {v}) }}}}>"
            )),
            "<div id=\"x\">",
            "spread beside an object, {v}"
        );
        // the style forms read the same entries
        assert_eq!(
            render(&format!("{{{{ {v} | style_attr }}}}")),
            "",
            "style_attr of {v}"
        );
        assert_eq!(
            render(&format!("{{{{ {v} | style_css }}}}")),
            "",
            "style_css of {v}"
        );
    }
}
