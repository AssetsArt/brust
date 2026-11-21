//! F585: NaN, ±Infinity and bigint job values, decoded from the job wrapper's tag ([`brust_jinja::ctx::decode_slot`]),
//! through every template filter equal JS (`gen-js-values.ts`); the decode itself and its escape.
use brust_jinja::ctx::{JS_TAG, JsVal, Node, decode_slot};
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

#[test]
fn decode_reads_each_tag() {
    assert!(matches!(decoded(tag("NaN")), Node::Js(JsVal::Float(f)) if f.is_nan()));
    assert_eq!(
        decoded(tag("Infinity")),
        Node::Js(JsVal::Float(f64::INFINITY))
    );
    assert_eq!(
        decoded(tag("-Infinity")),
        Node::Js(JsVal::Float(f64::NEG_INFINITY))
    );
    assert_eq!(
        decoded(tag("123456789012345678901234567890n")),
        Node::Js(JsVal::BigInt("123456789012345678901234567890".into()))
    );
    assert_eq!(decoded(tag("-0n")), Node::Js(JsVal::BigInt("-0".into())));
}

#[test]
fn decode_covers_top_level_array_items_only() {
    let n = decoded(json!([1, tag("NaN"), [tag("NaN")], { "x": tag("10n") }]));
    let a = n.as_arr().unwrap();
    assert!(matches!(a.0[1], Node::Js(JsVal::Float(f)) if f.is_nan()));
    // Nested deeper: left as parsed (the wrapper never tags there).
    assert_eq!(a.0[2], Node::from(json!([tag("NaN")])));
    assert_eq!(a.0[3], Node::from(json!({ "x": tag("10n") })));
    // An object slot's members are not decoded.
    assert_eq!(
        decoded(json!({ "a": tag("NaN") })),
        Node::from(json!({ "a": tag("NaN") }))
    );
}

#[test]
fn an_app_object_carrying_the_key_round_trips() {
    // The wrapper escapes it as {TAG: {o: <it>}}; decoding gives the app's object back, at both depths.
    let own = json!({ JS_TAG: "NaN" });
    assert_eq!(
        decoded(json!({ JS_TAG: { "o": own } })),
        Node::from(own.clone())
    );
    let n = decoded(json!([{ JS_TAG: { "o": own } }]));
    assert_eq!(n, Node::from(json!([own])));
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
        assert_eq!(decoded(v.clone()), Node::from(v));
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
