//! F420 / F421: a controlled `<select>` paints `selected` on the option its value picks and no `value` attribute, and a
//! `<textarea>` paints its value as text content, as react-dom's `renderToString` does (expected strings were read off
//! react-dom's own output). The client side (`x-model`) is unchanged.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
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

/// The server markup of `<C/>` whose body is `jsx`, with `v` a prop (a string, an array or a number).
fn painted(jsx: &str, props: serde_json::Value) -> String {
    let src = format!("export default function C({{ v }}: {{ v?: any }}) {{ return {jsx} }}");
    render(&jinja_of(src), props)
}

/// Strips the attributes the client directives add (`x-data`, `x-props`, `x-model`, ...) and the `<brust-host>` wrapper,
/// leaving what react-dom prints (a boolean attribute prints bare here, `multiple=""` there: the same HTML).
fn markup(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let end = rest[i..].find('>').map(|e| i + e + 1).unwrap_or(rest.len());
        let tag = &rest[i..end];
        let mut kept = String::new();
        let mut t = &tag[..tag.len() - 1];
        // keep the name, then each attribute that is not an `x-` directive
        let name_end = t.find(char::is_whitespace).unwrap_or(t.len());
        kept.push_str(&t[..name_end]);
        t = &t[name_end..];
        while let Some(s) = t.find(|c: char| !c.is_whitespace()) {
            t = &t[s..];
            let eq = t.find(['=', ' ']).unwrap_or(t.len());
            let attr_end = if t[eq..].starts_with("=\"") {
                let q = eq + 2;
                q + t[q..].find('"').unwrap() + 1
            } else if t[eq..].starts_with("='") {
                let q = eq + 2;
                q + t[q..].find('\'').unwrap() + 1
            } else {
                eq
            };
            let attr = &t[..attr_end];
            if !attr.starts_with("x-") {
                kept.push(' ');
                kept.push_str(attr);
            }
            t = &t[attr_end..];
        }
        kept.push('>');
        out.push_str(&kept);
        rest = &rest[end..];
    }
    out.push_str(rest);
    out.replace("<brust-host>", "")
        .replace("<brust-host style=\"display:contents\">", "")
        .replace("</brust-host>", "")
}

fn check(jsx: &str, props: serde_json::Value, want: &str) {
    assert_eq!(markup(&painted(jsx, props)), want, "for {jsx}");
}

const NOOP: &str = "onChange={() => {}}";

#[test]
fn select_value_marks_the_matching_option() {
    check(
        &format!(
            "<select value=\"b\" {NOOP}><option value=\"a\">a</option><option value=\"b\">b</option></select>"
        ),
        serde_json::json!({}),
        "<select><option value=\"a\">a</option><option value=\"b\" selected=\"\">b</option></select>",
    );
}

#[test]
fn select_value_from_a_prop_and_an_array_for_multiple() {
    let opts = "<option value=\"a\">a</option><option value=\"b\">b</option><option value=\"c\">c</option>";
    check(
        &format!("<select multiple value={{v}} {NOOP}>{opts}</select>"),
        serde_json::json!({ "v": ["a", "c"] }),
        "<select multiple><option value=\"a\" selected=\"\">a</option><option value=\"b\">b</option><option value=\"c\" selected=\"\">c</option></select>",
    );
    check(
        &format!("<select value={{v}} {NOOP}>{opts}</select>"),
        serde_json::json!({ "v": "c" }),
        "<select><option value=\"a\">a</option><option value=\"b\">b</option><option value=\"c\" selected=\"\">c</option></select>",
    );
}

#[test]
fn select_default_value_is_the_same() {
    check(
        "<select defaultValue=\"b\"><option value=\"a\">a</option><option value=\"b\">b</option></select>",
        serde_json::json!({}),
        "<select><option value=\"a\">a</option><option value=\"b\" selected=\"\">b</option></select>",
    );
    check(
        "<select defaultValue={v}><option value=\"a\">a</option><option value=\"b\">b</option></select>",
        serde_json::json!({ "v": "a" }),
        "<select><option value=\"a\" selected=\"\">a</option><option value=\"b\">b</option></select>",
    );
}

#[test]
fn option_text_and_numbers_match_as_strings() {
    check(
        &format!("<select value=\"b\" {NOOP}><option>a</option><option>b</option></select>"),
        serde_json::json!({}),
        "<select><option>a</option><option selected=\"\">b</option></select>",
    );
    check(
        &format!(
            "<select value={{v}} {NOOP}><option value={{0}}>z</option><option value={{1}}>o</option></select>"
        ),
        serde_json::json!({ "v": 1 }),
        "<select><option value=\"0\">z</option><option value=\"1\" selected=\"\">o</option></select>",
    );
}

#[test]
fn an_unset_select_value_picks_nothing() {
    check(
        &format!("<select value={{v}} {NOOP}><option value=\"a\">a</option></select>"),
        serde_json::json!({}),
        "<select><option value=\"a\">a</option></select>",
    );
}

#[test]
fn options_in_a_group_and_a_list_are_matched() {
    check(
        &format!(
            "<select value=\"b\" {NOOP}><optgroup label=\"g\"><option value=\"b\">b</option></optgroup></select>"
        ),
        serde_json::json!({}),
        "<select><optgroup label=\"g\"><option value=\"b\" selected=\"\">b</option></optgroup></select>",
    );
    check(
        &format!(
            "<select value=\"b\" {NOOP}>{{['a', 'b'].map((o) => <option key={{o}} value={{o}}>{{o}}</option>)}}</select>"
        ),
        serde_json::json!({}),
        "<select><option value=\"a\">a</option><option value=\"b\" selected=\"\">b</option></select>",
    );
}

#[test]
fn a_second_select_without_a_value_picks_nothing() {
    check(
        &format!(
            "<div><select value=\"a\" {NOOP}><option value=\"a\">a</option></select><select><option value=\"a\">a</option></select></div>"
        ),
        serde_json::json!({}),
        "<div><select><option value=\"a\" selected=\"\">a</option></select><select><option value=\"a\">a</option></select></div>",
    );
}

#[test]
fn textarea_value_is_its_escaped_text() {
    check(
        &format!("<textarea value={{v}} {NOOP} />"),
        serde_json::json!({ "v": "a<b & \"c\"" }),
        "<textarea>a&lt;b &amp; &quot;c&quot;</textarea>",
    );
    check(
        "<textarea defaultValue=\"d\" />",
        serde_json::json!({}),
        "<textarea>d</textarea>",
    );
    check(
        &format!("<textarea value={{v}} {NOOP} />"),
        serde_json::json!({ "v": 3 }),
        "<textarea>3</textarea>",
    );
    check(
        &format!("<textarea value={{v}} {NOOP} />"),
        serde_json::json!({}),
        "<textarea></textarea>",
    );
}

#[test]
fn textarea_keeps_a_leading_newline() {
    check(
        &format!("<textarea value={{v}} {NOOP} />"),
        serde_json::json!({ "v": "\nx" }),
        "<textarea>\n\nx</textarea>",
    );
}

#[test]
fn controlled_values_paint_no_value_attribute() {
    for jsx in [
        format!("<select value={{v}} {NOOP}><option value=\"a\">a</option></select>"),
        format!("<textarea value={{v}} {NOOP} />"),
    ] {
        let html = markup(&painted(&jsx, serde_json::json!({ "v": "a" })));
        assert!(
            !html.contains(" value=\"a\"><")
                && !html.contains("<select value")
                && !html.contains("<textarea value"),
            "{html}"
        );
    }
}

/// The markup of a whole component source (`export default function C(...)`), for the shapes that need their own props.
fn painted_src(src: &str, props: serde_json::Value) -> String {
    markup(&render(&jinja_of(src.to_string()), props))
}

const OPTS: &str =
    "<option value=\"a\">a</option><option value=\"b\">b</option><option value=\"c\">c</option>";

// F432: the shadcn wrapper shape, the props (and so the value) arrive through a spread.

#[test]
fn a_select_value_through_a_spread_marks_the_matching_option() {
    let src = format!(
        "export default function C(props: any) {{ return <select {{...props}}>{OPTS}</select> }}"
    );
    assert_eq!(
        painted_src(&src, serde_json::json!({ "value": "b", "onChange": null })),
        "<select><option value=\"a\">a</option><option value=\"b\" selected=\"\">b</option><option value=\"c\">c</option></select>"
    );
    // defaultValue through the spread is the same; an absent value picks nothing and prints no attribute
    assert_eq!(
        painted_src(&src, serde_json::json!({ "defaultValue": "c", "id": "s" })),
        "<select id=\"s\"><option value=\"a\">a</option><option value=\"b\">b</option><option value=\"c\" selected=\"\">c</option></select>"
    );
    assert_eq!(
        painted_src(&src, serde_json::json!({})),
        "<select><option value=\"a\">a</option><option value=\"b\">b</option><option value=\"c\">c</option></select>"
    );
}

#[test]
fn a_multiple_select_array_through_a_spread_marks_every_pick() {
    let src = format!(
        "export default function C(props: any) {{ return <select multiple {{...props}}>{OPTS}</select> }}"
    );
    assert_eq!(
        painted_src(&src, serde_json::json!({ "value": ["a", "c"] })),
        "<select multiple><option value=\"a\" selected=\"\">a</option><option value=\"b\">b</option><option value=\"c\" selected=\"\">c</option></select>"
    );
}

#[test]
fn an_own_value_after_a_spread_wins_over_the_spreads() {
    let src = format!(
        "export default function C({{ v, ...rest }}: any) {{ return <select {{...rest}} value={{v}} onChange={{() => {{}}}}>{OPTS}</select> }}"
    );
    assert_eq!(
        painted_src(&src, serde_json::json!({ "v": "c", "value": "a" })),
        "<select><option value=\"a\">a</option><option value=\"b\">b</option><option value=\"c\" selected=\"\">c</option></select>"
    );
    // and one before it loses to the spread
    let src = format!(
        "export default function C({{ v, ...rest }}: any) {{ return <select value={{v}} {{...rest}}>{OPTS}</select> }}"
    );
    assert_eq!(
        painted_src(&src, serde_json::json!({ "v": "c", "value": "a" })),
        "<select><option value=\"a\" selected=\"\">a</option><option value=\"b\">b</option><option value=\"c\">c</option></select>"
    );
}

#[test]
fn a_textarea_value_through_a_spread_is_its_text() {
    let src =
        "export default function C(props: any) { return <textarea className=\"t\" {...props} /> }";
    assert_eq!(
        painted_src(
            src,
            serde_json::json!({ "value": "a<b & \"c\"", "rows": 3 })
        ),
        "<textarea class=\"t\" rows=\"3\">a&lt;b &amp; &quot;c&quot;</textarea>"
    );
    assert_eq!(
        painted_src(src, serde_json::json!({ "defaultValue": "d" })),
        "<textarea class=\"t\">d</textarea>"
    );
    assert_eq!(
        painted_src(src, serde_json::json!({ "value": "\nx" })),
        "<textarea class=\"t\">\n\nx</textarea>"
    );
    assert_eq!(
        painted_src(src, serde_json::json!({})),
        "<textarea class=\"t\"></textarea>"
    );
}

#[test]
fn a_textarea_without_a_value_keeps_its_children() {
    let src =
        "export default function C(props: any) { return <textarea {...props}>kept</textarea> }";
    assert_eq!(
        painted_src(src, serde_json::json!({})),
        "<textarea>kept</textarea>"
    );
    assert_eq!(
        painted_src(src, serde_json::json!({ "value": "v" })),
        "<textarea>v</textarea>"
    );
}

#[test]
fn options_handed_to_a_wrapper_component_are_matched_by_the_selects_value() {
    // the shadcn shape: the options are the wrapper's children (markup the call site prints), the value its rest
    let src = "function Select(props: any) { return <select {...props} /> }
export default function C() { return <Select value=\"b\" onChange={() => {}}><option value=\"a\">a</option><option value=\"b\">b</option></Select> }";
    assert_eq!(
        painted_src(src, serde_json::json!({})),
        "<select><option value=\"a\">a</option><option value=\"b\" selected=\"\">b</option></select>"
    );
    // an option outside any select, and in an uncontrolled wrapper, is not selected
    let src = "function Select(props: any) { return <select {...props} /> }
export default function C() { return <Select><option value=\"a\">a</option></Select> }";
    assert_eq!(
        painted_src(src, serde_json::json!({})),
        "<select><option value=\"a\">a</option></select>"
    );
}
