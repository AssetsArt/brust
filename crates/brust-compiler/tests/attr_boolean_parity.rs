//! F196: what the compiled SERVER template prints for an attribute, for every kind of value, equals what React prints
//! (`tests/fixtures/attr-parity/react.json`, produced by real react-dom and kept honest by
//! `packages/brust/test/attr-parity-react.test.ts`). The class is every attribute where React writes a boolean as a string
//! (`aria-*`, `data-*`, `draggable`, ...), omits it (a boolean attribute when false, any other attribute for both), or
//! writes `""` for `true` (boolean attributes, `download`, `capture`).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn jinja_of(src: String) -> String {
    run_on_compiler_thread(move || {
        compile_tree(
            "crates/brust-compiler/tests/fixtures/attr-parity/T.tsx",
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()[0]
            .artifacts
            .jinja
            .clone()
    })
}

fn render(jinja: &str, props: serde_json::Value) -> String {
    let mut ctx = props.clone();
    ctx["_props"] = props;
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx))
        .unwrap()
        .trim()
        .to_string()
}

/// The attributes of the first tag, names lower-cased, as one sorted `name="value"` / `name=""` line like the fixture.
fn attrs_of(html: &str) -> String {
    let open = &html[..html.find('>').expect("a tag")];
    let mut out = Vec::new();
    let mut rest = open
        .split_once(char::is_whitespace)
        .map(|(_, r)| r)
        .unwrap_or("");
    while let Some(i) = rest.find(|c: char| !c.is_whitespace()) {
        rest = &rest[i..];
        let end = rest
            .find(|c: char| c == '=' || c.is_whitespace())
            .unwrap_or(rest.len());
        let name = rest[..end].to_ascii_lowercase();
        rest = &rest[end..];
        let value = if let Some(r) = rest.strip_prefix("=\"") {
            let close = r.find('"').unwrap();
            let v = &r[..close];
            rest = &r[close + 1..];
            v.to_string()
        } else {
            String::new()
        };
        out.push(format!("{name}=\"{value}\""));
    }
    // React prints a boolean attribute as `name=""`, the compiler as the bare name: both are `name=""` here.
    out.sort();
    out.join(" ")
}

fn react_attrs(line: &str) -> String {
    let mut v: Vec<String> = line
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.contains('=') {
                s.to_string()
            } else {
                format!("{s}=\"\"")
            }
        })
        .collect();
    v.sort();
    v.join(" ")
}

fn tag_of(name: &str) -> &'static str {
    match name {
        "checked" | "value" => "input",
        "selected" => "option",
        _ => "div",
    }
}

fn value_of(v: &str) -> Option<serde_json::Value> {
    use serde_json::json;
    match v {
        "true" => Some(json!(true)),
        "false" => Some(json!(false)),
        "0" => Some(json!(0)),
        "1" => Some(json!(1)),
        "''" => Some(json!("")),
        "null" => Some(json!(null)),
        "undefined" => None,
        "'x'" => Some(json!("x")),
        other => panic!("{other}"),
    }
}

fn fixture() -> BTreeMap<String, BTreeMap<String, String>> {
    serde_json::from_str(
        &std::fs::read_to_string(repo().join("tests/fixtures/attr-parity/react.json")).unwrap(),
    )
    .unwrap()
}

/// Names whose value in a component prop path prints differently for a reason that is not the boolean rule.
/// Each is listed with the reason; the test fails if one starts to pass (so the list shrinks).
const KNOWN: &[(&str, &str, &str)] = &[];

#[test]
fn a_dynamic_attribute_prints_every_value_as_react_does() {
    let react = fixture();
    let mut bad = Vec::new();
    for (name, row) in &react {
        let tag = tag_of(name);
        let jinja = jinja_of(format!(
            "export default function T(props: any) {{ return <{tag} {name}={{props.v}} /> }}"
        ));
        for (v, want) in row {
            let props = match value_of(v) {
                Some(val) => serde_json::json!({ "v": val }),
                None => serde_json::json!({}),
            };
            let got = attrs_of(&render(&jinja, props));
            let want = react_attrs(want);
            let want_norm = want.clone();
            if got != want_norm && !KNOWN.contains(&(name.as_str(), v.as_str(), got.as_str())) {
                bad.push(format!("{name}={{{v}}}: React `{want}`, compiled `{got}`"));
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
fn a_literal_true_false_and_bare_attribute_prints_as_react_does() {
    let react = fixture();
    let mut bad = Vec::new();
    for (name, row) in &react {
        let tag = tag_of(name);
        for (lit, key) in [("{true}", "true"), ("{false}", "false"), ("", "true")] {
            let eq = if lit.is_empty() { "" } else { "=" };
            let jinja = jinja_of(format!(
                "export default function T() {{ return <{tag} {name}{eq}{lit} /> }}"
            ));
            let got = attrs_of(&render(&jinja, serde_json::json!({})));
            let want = react_attrs(&row[key]);
            if got != want {
                bad.push(format!("{name}{eq}{lit}: React `{want}`, compiled `{got}`"));
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
fn an_empty_src_or_href_is_dropped_except_on_an_anchor() {
    // React 19 (checked in packages/brust/test/attr-parity-react.test.ts): `<img src="">` and `<link href="">` print no
    // attribute, `<a href="">` keeps it. Dynamic, and written as a string literal.
    for (tag, name, keeps) in [
        ("img", "src", false),
        ("iframe", "src", false),
        ("link", "href", false),
        ("a", "href", true),
    ] {
        let dynamic = render(
            &jinja_of(format!(
                "export default function T(props: any) {{ return <{tag} {name}={{props.v}} /> }}"
            )),
            serde_json::json!({ "v": "" }),
        );
        let literal = render(
            &jinja_of(format!(
                "export default function T() {{ return <{tag} {name}=\"\" /> }}"
            )),
            serde_json::json!({}),
        );
        for html in [dynamic, literal] {
            assert_eq!(
                attrs_of(&html),
                if keeps {
                    format!("{name}=\"\"")
                } else {
                    String::new()
                },
                "{tag} {name}: {html}"
            );
        }
    }
}

fn custom_fixture() -> BTreeMap<String, BTreeMap<String, String>> {
    serde_json::from_str(
        &std::fs::read_to_string(repo().join("tests/fixtures/attr-parity/react-custom.json"))
            .unwrap(),
    )
    .unwrap()
}

/// F213: React passes every attribute of a custom element (a tag with `-`) through as given: `true` is `""`, `false`,
/// `null` and `undefined` omit it, anything else is its string. Dynamic and literal, as the server paints it.
#[test]
fn a_custom_element_attribute_prints_as_react_does() {
    let react = custom_fixture();
    let mut bad = Vec::new();
    for (name, row) in &react {
        let jinja = jinja_of(format!(
            "export default function T(props: any) {{ return <x-y {name}={{props.v}} /> }}"
        ));
        for (v, want) in row {
            let props = match value_of(v) {
                Some(val) => serde_json::json!({ "v": val }),
                None => serde_json::json!({}),
            };
            let got = attrs_of(&render(&jinja, props));
            let want = react_attrs(want);
            if got != want {
                bad.push(format!("{name}={{{v}}}: React `{want}`, compiled `{got}`"));
            }
        }
        for (lit, key) in [("{true}", "true"), ("{false}", "false")] {
            let jinja = jinja_of(format!(
                "export default function T() {{ return <x-y {name}={lit} /> }}"
            ));
            let got = attrs_of(&render(&jinja, serde_json::json!({})));
            let want = react_attrs(&row[key]);
            if got != want {
                bad.push(format!("{name}={lit}: React `{want}`, compiled `{got}`"));
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

/// The Overloaded print (custom elements, `download`) keeps the URL scheme check: a `javascript:` value on a custom
/// element's `href` / `src` is not printed, a safe one is; `true` still prints the empty value.
#[test]
fn a_custom_element_url_attribute_keeps_the_scheme_check() {
    for name in ["href", "src"] {
        let jinja = jinja_of(format!(
            "export default function T(props: any) {{ return <x-y {name}={{props.v}} /> }}"
        ));
        let p = |v: serde_json::Value| render(&jinja, serde_json::json!({ "v": v }));
        assert_eq!(attrs_of(&p(serde_json::json!("javascript:alert(1)"))), "");
        assert_eq!(attrs_of(&p(serde_json::json!(" JavaScript:alert(1)"))), "");
        assert_eq!(
            attrs_of(&p(serde_json::json!("https://a.dev/x"))),
            format!("{name}=\"https://a.dev/x\"")
        );
        assert_eq!(
            attrs_of(&p(serde_json::json!(true))),
            format!("{name}=\"\"")
        );
    }
}
