//! Props spread onto an element whose keys are not known at compile time (shadcn plan S1.2,
//! R34.15 path (b)): `<div {...props} />` in a route component, or a spread of a props path.
//! This is an HTML output sink like `html_raw`, so every rule is fail-closed (R34.17):
//!
//! - `spread_attrs(seg, …)` merges its segments in order, as a JS object literal does (a later
//!   key replaces the value and keeps the position of the first), then prints the attributes
//!   with the same rules the compiler prints a hand-written dynamic attribute with: React's name
//!   map ([`crate::attr_name`]), boolean attributes, the URL rule, `style` objects as CSS text,
//!   and every value escaped. A segment is a `[name, value]` pair (an attribute the author wrote
//!   next to the spread) or a map (the spread object; anything else spreads nothing).
//! - Never printed: `children`, `key`, `ref`, `dangerouslySetInnerHTML`, every `on*` name, every
//!   `x-*` name (runtime-dom directives, F94), `srcdoc`, and any name outside the attribute-name
//!   grammar below (an object key such as `onmouseover=alert(1) x` is dropped, not printed).
//! - `spread_children(v)` prints the `children` a spread carries when the element has no JSX
//!   children: strings and numbers as escaped text (arrays of them concatenated), nothing else.
//! - `spread_get(d, "k", fallback)` and `omit(d, ["a", …])` read and narrow a spread object.
use minijinja::value::{Rest, Value, ValueKind};
use std::collections::BTreeMap;

use crate::{
    AttrKind, attr_kind, attr_name, attr_string, escape_attr, escape_text, is_refused_attr,
    js_number, present, present_plain, present_str, safe_url, style_obj_to_css, truthy,
};

/// React prop names a spread never turns into attributes.
const NOT_ATTRS: &[&str] = &["children", "key", "ref", "dangerouslySetInnerHTML"];

/// An attribute name brust prints from data it did not write: ASCII letters, digits and
/// `_ : . -`, starting with a letter, `_` or `:` (React's `isAttributeNameSafe`, ASCII only).
/// Rules out whitespace, quotes, `=`, `>`, `/` and every other byte that could end the name.
pub fn attr_name_ok(name: &str) -> bool {
    let mut cs = name.chars();
    cs.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == ':')
        && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

/// Whether a spread key may become an attribute at all (before its value is looked at).
pub fn spread_key_ok(react_name: &str) -> bool {
    if NOT_ATTRS.contains(&react_name) || !attr_name_ok(react_name) {
        return false;
    }
    let html = attr_name(react_name);
    attr_name_ok(&html) && !is_refused_attr(&html)
}

/// The `(key, value)` pairs of a map value, in its iteration order.
fn map_pairs(v: &Value) -> Vec<(String, Value)> {
    if v.kind() != ValueKind::Map {
        return Vec::new();
    }
    v.try_iter()
        .map(|it| {
            it.filter_map(|k| {
                let key = k.as_str()?.to_string();
                let val = v.get_item(&k).unwrap_or(Value::UNDEFINED);
                Some((key, val))
            })
            .collect()
        })
        .unwrap_or_default()
}

/// One segment as pairs: a `[name, value]` pair, or a map's entries.
fn segment(v: &Value) -> Vec<(String, Value)> {
    match v.kind() {
        ValueKind::Seq if v.len() == Some(2) => {
            let name = v.get_item(&Value::from(0)).unwrap_or(Value::UNDEFINED);
            match name.as_str() {
                Some(n) => vec![(
                    n.to_string(),
                    v.get_item(&Value::from(1)).unwrap_or(Value::UNDEFINED),
                )],
                None => Vec::new(),
            }
        }
        ValueKind::Map => map_pairs(v),
        _ => Vec::new(),
    }
}

/// The one key of the HTML attribute a React name prints as (`className` and `class` are both
/// `class`, `htmlFor`/`for`, `tabIndex`/`tabindex`, `defaultValue`/`value`; HTML attribute names
/// are case-insensitive). Attributes merge on it, so an alias written later still wins (review F1).
pub fn attr_key(react_name: &str) -> String {
    attr_name(react_name).to_ascii_lowercase()
}

/// Merges attribute pairs on [`attr_key`]: a later pair replaces an earlier one for the same HTML
/// attribute (keeping the first position) and brings its own React name.
fn merge_attrs(segs: &[Value]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, String, Value)> = Vec::new();
    for s in segs {
        for (k, v) in segment(s) {
            let key = attr_key(&k);
            match out.iter_mut().find(|(c, _, _)| *c == key) {
                Some(slot) => {
                    slot.1 = k;
                    slot.2 = v;
                }
                None => out.push((key, k, v)),
            }
        }
    }
    out.into_iter().map(|(_, k, v)| (k, v)).collect()
}

/// Merges pairs as a JS object literal does: a repeated key replaces the value in place.
fn merge(segs: &[Value]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::new();
    for s in segs {
        for (k, v) in segment(s) {
            match out.iter_mut().find(|(n, _)| *n == k) {
                Some(slot) => slot.1 = v,
                None => out.push((k, v)),
            }
        }
    }
    out
}

/// One attribute as the compiler prints a hand-written dynamic one (`lower/template.rs`
/// `Attr::Dynamic`), or nothing.
pub fn render_attr(react_name: &str, v: &Value) -> String {
    if !spread_key_ok(react_name) {
        return String::new();
    }
    let html = attr_name(react_name);
    if html == "style" {
        // Only a style object has declarations (React throws on a string).
        if v.kind() != ValueKind::Map {
            return String::new();
        }
        return format!(
            " style=\"{}\"",
            escape_text(&style_obj_to_css(&map_pairs(v)))
        );
    }
    match attr_kind(&html) {
        AttrKind::Boolean => {
            return if truthy(v) {
                format!(" {html}")
            } else {
                String::new()
            };
        }
        AttrKind::Overloaded if v.kind() == ValueKind::Bool => {
            return if v.is_true() {
                format!(" {html}=\"\"")
            } else {
                String::new()
            };
        }
        AttrKind::Stringify if !present_str(v) => return String::new(),
        AttrKind::Stringify => {}
        _ if !present_plain(v) => return String::new(),
        _ => {}
    }
    let s = attr_string(v);
    // React writes no `src=""`. A spread does not know its tag, so `href=""` (kept on an anchor) is kept.
    if html == "src" && s.is_empty() {
        return String::new();
    }
    if crate::is_url_attr(&html) && !safe_url(&s) {
        return String::new();
    }
    format!(" {html}=\"{}\"", escape_attr(&s))
}

/// `spread_attrs(seg, …)`: see the module docs.
pub fn spread_attrs(segs: Rest<Value>) -> String {
    merge_attrs(&segs)
        .iter()
        .map(|(k, v)| render_attr(k, v))
        .collect()
}

/// `spread_children(v)`: see the module docs.
pub fn spread_children(v: Value) -> String {
    match v.kind() {
        ValueKind::String => escape_text(v.as_str().unwrap_or_default()),
        ValueKind::Number => f64::try_from(v.clone()).map(js_number).unwrap_or_default(),
        ValueKind::Seq => v
            .try_iter()
            .map(|it| it.map(spread_children).collect())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// `spread_get(d, "k", fallback)`: `d.k` when the spread object `d` has the key, else `fallback`.
pub fn spread_get(d: Value, key: String, fallback: Option<Value>) -> Value {
    if d.kind() == ValueKind::Map
        && let Ok(v) = d.get_item(&Value::from(key.as_str()))
        && !v.is_undefined()
    {
        return v;
    }
    fallback.unwrap_or(Value::UNDEFINED)
}

/// `d | omit(["a", …])`: the spread object without the named keys (a rest object).
pub fn omit(d: Value, keys: Vec<String>) -> Value {
    let out: BTreeMap<String, Value> = map_pairs(&d)
        .into_iter()
        .filter(|(k, _)| !keys.contains(k))
        .collect();
    Value::from(out)
}

/// `d | omit_attrs(["className", …])`: the spread object without the keys that print as the same
/// HTML attributes as the named ones (an attribute written after the spread wins, on [`attr_key`]).
pub fn omit_attrs(d: Value, names: Vec<String>) -> Value {
    let keys: Vec<String> = names.iter().map(|n| attr_key(n)).collect();
    let out: BTreeMap<String, Value> = map_pairs(&d)
        .into_iter()
        .filter(|(k, _)| !keys.contains(&attr_key(k)))
        .collect();
    Value::from(out)
}

/// `class_join(a, b, …)`: the class names that are present, joined by one space (the `className` of
/// a Radix `Slot`: the component's first, then the child's). Nothing present is undefined.
pub fn class_join(parts: Rest<Value>) -> Value {
    let joined: Vec<String> = parts
        .iter()
        .filter(|v| present(v))
        .map(attr_string)
        .filter(|s| !s.is_empty())
        .collect();
    if joined.is_empty() {
        Value::UNDEFINED
    } else {
        Value::from(joined.join(" "))
    }
}

/// `spread_merge(seg, …)`: the segments merged into one object (a whole-props binding).
pub fn spread_merge(segs: Rest<Value>) -> Value {
    Value::from(merge(&segs).into_iter().collect::<BTreeMap<_, _>>())
}

/// `obj_assign(source, …)`: `Object.assign({}, source, …)` (F277): each source's own enumerable keys in turn, a later
/// one replacing an earlier one; a list or a string gives its indices, anything else (`null`, `undefined`, a number, a
/// boolean) nothing.
pub fn obj_assign(sources: Rest<Value>) -> Value {
    // Keyed straight into the (key-sorted) result: linear in the sources' size, whatever their keys.
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for s in sources.iter() {
        match s.kind() {
            ValueKind::Map => out.extend(map_pairs(s)),
            ValueKind::Seq => {
                for i in 0..s.len().unwrap_or(0) {
                    out.insert(
                        i.to_string(),
                        s.get_item(&Value::from(i)).unwrap_or(Value::UNDEFINED),
                    );
                }
            }
            ValueKind::String => {
                for (i, c) in s.as_str().unwrap_or_default().encode_utf16().enumerate() {
                    out.insert(i.to_string(), Value::from(String::from_utf16_lossy(&[c])));
                }
            }
            _ => {}
        }
    }
    Value::from(out)
}

#[cfg(test)]
mod tests {
    use minijinja::Environment;
    use serde_json::json;

    fn render(src: &str, ctx: serde_json::Value) -> String {
        let mut env = Environment::new();
        crate::register(&mut env);
        env.render_str(src, crate::value_of(ctx)).unwrap()
    }

    /// F277: `obj_assign` is `Object.assign({}, …)`: later keys win in place, `null`/`undefined`/numbers add nothing,
    /// a list or string gives its indices.
    #[test]
    fn obj_assign_merges_as_object_assign_does() {
        // `k=v;` per entry, in the map's order.
        let r = |args: &str, ctx: serde_json::Value| {
            render(
                &format!(
                    "{{% for e in obj_assign({args}) | entries %}}{{{{ e[0] }}}}={{{{ e[1] }}}};{{% endfor %}}"
                ),
                ctx,
            )
        };
        assert_eq!(
            r(
                "a, {'k': 2}, b",
                json!({"a": {"k": 1, "x": 1}, "b": {"x": 3}})
            ),
            "k=2;x=3;"
        );
        assert_eq!(r("n, u, 3, true, {'k': 1}", json!({"n": null})), "k=1;");
        assert_eq!(r("['p', 'q'], 'ab'", json!({})), "0=a;1=b;");
        assert_eq!(
            render(
                "{{ obj_assign(s, {'position': 'absolute'}) | style_css }}",
                json!({"s": {"width": "3px"}})
            ),
            "position:absolute;width:3px"
        );
    }

    /// F196: the spread path prints every attribute and value as React does (`tests/fixtures/attr-parity/react.json`).
    /// A spread has no tag, so `href=""` (React drops it on every element but `<a>`) is the one row that differs.
    #[test]
    fn spread_prints_every_value_as_react_does() {
        use minijinja::value::Value;
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/attr-parity/react.json"
        );
        let react: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut bad = Vec::new();
        for (name, row) in &react {
            for (v, want) in row {
                if name == "href" && v == "''" {
                    continue;
                }
                let val = match v.as_str() {
                    "true" => Value::from(true),
                    "false" => Value::from(false),
                    "0" => Value::from(0),
                    "1" => Value::from(1),
                    "''" => Value::from(""),
                    "null" => Value::from(()),
                    "undefined" => Value::UNDEFINED,
                    "'x'" => Value::from("x"),
                    other => panic!("{other}"),
                };
                let got = super::render_attr(name, &val).trim().to_ascii_lowercase();
                // a boolean attribute is the bare name here and `name=""` in React's output
                let got = if got.contains('=') || got.is_empty() {
                    got
                } else {
                    format!("{got}=\"\"")
                };
                if got != *want {
                    bad.push(format!("{name}={v}: React `{want}`, spread `{got}`"));
                }
            }
        }
        assert!(
            bad.is_empty(),
            "{} mismatches:\n{}",
            bad.len(),
            bad.join("\n")
        );
    }

    #[test]
    fn class_join_keeps_the_present_names_in_order() {
        let ctx = json!({ "a": "base x", "b": "child", "n": null, "e": "" });
        assert_eq!(
            render("{{ class_join(a, b) }}", ctx.clone()),
            "base x child"
        );
        assert_eq!(
            render("{{ class_join(a, n, e, u) }}", ctx.clone()),
            "base x"
        );
        assert_eq!(render("[{{ class_join(n, e) }}]", ctx), "[]");
    }

    #[test]
    fn maps_react_names_and_escapes_values() {
        let out = render(
            "<a{{ spread_attrs(p) }}>",
            json!({ "p": { "className": "a \"b\" <c>", "htmlFor": "x", "tabIndex": 0, "data-k": "v'", "aria-label": "&" } }),
        );
        assert_eq!(
            out,
            "<a aria-label=\"&amp;\" class=\"a &quot;b&quot; &lt;c&gt;\" data-k=\"v&#39;\" for=\"x\" tabindex=\"0\">"
        );
    }

    #[test]
    fn later_wins_and_keeps_the_first_position() {
        // className written before the spread is replaced by the spread's; id after it wins.
        let out = render(
            r#"<b{{ spread_attrs(["className", "mine"], p, ["id", "last"]) }}>"#,
            json!({ "p": { "className": "theirs", "id": "theirs" } }),
        );
        assert_eq!(out, "<b class=\"theirs\" id=\"last\">");
        let kept = render(
            r#"<b{{ spread_attrs(["className", "mine"], p) }}>"#,
            json!({ "p": {} }),
        );
        assert_eq!(kept, "<b class=\"mine\">");
    }

    #[test]
    fn never_prints_handlers_directives_internals_or_bad_names() {
        let out = render(
            "<i{{ spread_attrs(p) }}>",
            json!({ "p": {
                "onmouseover=alert(1) x": "y",
                "onClick": "alert(1)",
                "onclick": "alert(1)",
                "x-html": "<b>",
                "X-On-Click": "f",
                "children": "kid",
                "key": "k",
                "ref": "r",
                "dangerouslySetInnerHTML": { "__html": "<script>" },
                "srcdoc": "<script>",
                "a b": "1",
                "a\"b": "1",
                "a>b": "1",
                "a/b": "1",
                "": "1",
                "1x": "1",
                "ok": "1"
            } }),
        );
        assert_eq!(out, "<i ok=\"1\">");
    }

    #[test]
    fn url_rule_boolean_and_style() {
        let out = render(
            "<a{{ spread_attrs(p) }}>",
            json!({ "p": {
                "href": "javascript:alert(1)",
                "src": " java\tscript:x",
                "disabled": true,
                "hidden": false,
                "title": false,
                "lang": null,
                "style": { "color": "red", "fontSize": 12, "background": "x;y" }
            } }),
        );
        assert_eq!(out, "<a disabled style=\"color:red;font-size:12px\">");
        let ok = render(
            "<a{{ spread_attrs(p) }}>",
            json!({ "p": { "href": "/x?a=1&b=2" } }),
        );
        assert_eq!(ok, "<a href=\"/x?a=1&amp;b=2\">");
        let str_style = render(
            "<a{{ spread_attrs(p) }}>",
            json!({ "p": { "style": "color:red" } }),
        );
        assert_eq!(str_style, "<a>");
    }

    #[test]
    fn non_object_spreads_spread_nothing() {
        let out = render(
            r#"<p{{ spread_attrs(a, b, c, ["id", 1]) }}>"#,
            json!({ "a": "str", "b": [1, 2], "c": null }),
        );
        assert_eq!(out, "<p id=\"1\">");
    }

    #[test]
    fn children_get_omit_merge() {
        assert_eq!(
            render(
                "{{ spread_children(p.children) }}",
                json!({ "p": { "children": "<b>" } })
            ),
            "&lt;b&gt;"
        );
        assert_eq!(
            render(
                "{{ spread_children(p.children) }}",
                json!({ "p": { "children": ["a", 1, ["b"]] } })
            ),
            "a1b"
        );
        assert_eq!(
            render(
                "{{ spread_children(p.children) }}",
                json!({ "p": { "children": { "x": 1 } } })
            ),
            ""
        );
        assert_eq!(
            render(
                "{{ spread_get(p, 'a', 'f') }}|{{ spread_get(p, 'z', 'f') }}|{{ spread_get(n, 'a', 'f') }}",
                json!({ "p": { "a": "A" }, "n": null })
            ),
            "A|f|f"
        );
        assert_eq!(
            render(
                "{{ p | omit(['a']) | json_attr }}",
                json!({ "p": { "a": 1, "b": 2 } })
            ),
            "{&quot;b&quot;:2}"
        );
        assert_eq!(
            render(
                r#"{{ spread_merge(p, ["b", 3]) | json_attr }}"#,
                json!({ "p": { "a": 1, "b": 2 } })
            ),
            "{&quot;a&quot;:1,&quot;b&quot;:3}"
        );
    }

    /// Review F1: a React name and its HTML alias are ONE attribute; the later one wins, in both orders.
    #[test]
    fn aliases_merge_into_one_attribute_later_wins() {
        let pairs = [
            ("className", "class"),
            ("htmlFor", "for"),
            ("tabIndex", "tabindex"),
            ("autoComplete", "autocomplete"),
            ("defaultValue", "value"),
            ("crossOrigin", "crossorigin"),
            ("title", "TITLE"),
        ];
        for (react, html) in pairs {
            let attr = crate::attr_name(react);
            for (first, second, win) in [(react, html, "2"), (html, react, "2")] {
                let src =
                    format!(r#"<i{{{{ spread_attrs(["{first}", "1"], ["{second}", "2"]) }}}}>"#);
                let out = render(&src, json!({}));
                assert_eq!(
                    out.matches(&format!(" {attr}=")).count()
                        + out
                            .matches(&format!(" {}=", attr.to_ascii_uppercase()))
                            .count(),
                    1,
                    "{first}/{second}: {out}"
                );
                assert!(
                    out.contains(&format!("=\"{win}\"")),
                    "{first}/{second}: {out}"
                );
            }
            // A spread map against a pair, both orders.
            let a = render(
                &format!(r#"<i{{{{ spread_attrs(["{react}", "mine"], p) }}}}>"#),
                json!({ "p": { html: "theirs" } }),
            );
            assert!(a.contains("\"theirs\"") && !a.contains("mine"), "{a}");
            let b = render(
                &format!(r#"<i{{{{ spread_attrs(p, ["{react}", "mine"]) }}}}>"#),
                json!({ "p": { html: "theirs" } }),
            );
            assert!(b.contains("\"mine\"") && !b.contains("theirs"), "{b}");
        }
        // Boolean aliases: readOnly / readonly print once.
        let r = render(
            r#"<i{{ spread_attrs(["readOnly", false], p) }}>"#,
            json!({ "p": { "readonly": true } }),
        );
        assert_eq!(r, "<i readonly>");
        let r = render(
            r#"<i{{ spread_attrs(p, ["readOnly", false]) }}>"#,
            json!({ "p": { "readonly": true } }),
        );
        assert_eq!(r, "<i>");
        // omit_attrs drops every key that prints as a named attribute.
        assert_eq!(
            render(
                "{{ p | omit_attrs(['className', 'htmlFor']) | json_attr }}",
                json!({ "p": { "class": 1, "for": 2, "id": 3 } })
            ),
            "{&quot;id&quot;:3}"
        );
    }
}
