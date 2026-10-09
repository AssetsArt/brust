//! The minijinja environment brust templates are rendered with (spec §6.1).
//!
//! The compiler's template backend prints templates against these filter names,
//! and every renderer (the later server, the compiler's dual-evaluation harness)
//! calls [`register`], so both sides agree on one environment. Autoescape is
//! off; the template prints `| e` on every dynamic output (0.1.x XSS lesson).
//!
//! Painting follows React and `packages/runtime-dom`: `null`, `undefined` and
//! booleans paint as empty text, numbers print like JS `String(n)`; an attribute
//! whose value is `null`, `undefined` or `false` is omitted (`present`).
use minijinja::value::{Kwargs, Value, ValueKind};
use minijinja::{Environment, Error, ErrorKind};

/// Registers every brust filter on `env` (and the builtins they build on).
pub fn register(env: &mut Environment<'_>) {
    env.set_auto_escape_callback(|_| minijinja::AutoEscape::None);
    // `a.b` on a missing value is undefined (paints empty), never an error.
    env.set_undefined_behavior(minijinja::UndefinedBehavior::Chainable);
    env.add_filter("e", |v: Value| escape_text(&paint(&v)));
    env.add_filter("js_str", |v: Value| paint(&v));
    env.add_filter("js_string", |v: Value| js_string(&v));
    env.add_filter("attr_str", |v: Value| attr_string(&v));
    env.add_filter("present", |v: Value| present(&v));
    env.add_filter("url_ok", |v: Value| safe_url(&attr_string(&v)));
    env.add_filter("json_attr", json_attr);
    env.add_filter("str_slice", str_slice);
    env.add_filter("includes", includes);
    env.add_filter("starts_with", |s: Value, x: Value| {
        paint(&s).starts_with(paint(&x).as_str())
    });
    env.add_filter("ends_with", |s: Value, x: Value| {
        paint(&s).ends_with(paint(&x).as_str())
    });
    env.add_filter("join", join);
    env.add_filter("keys", keys);
    env.add_filter("entries", entries);
    env.add_filter("css_val", |v: Value, prop: String| css_value(&prop, &v));
}

/// Text of a painted value: what React (and `x-text`) shows.
pub fn paint(v: &Value) -> String {
    match v.kind() {
        ValueKind::Undefined | ValueKind::None | ValueKind::Bool => String::new(),
        ValueKind::Number => number_of(v).map(js_number).unwrap_or_default(),
        ValueKind::Seq | ValueKind::Iterable => v
            .try_iter()
            .map(|it| it.map(|x| paint(&x)).collect::<String>())
            .unwrap_or_default(),
        _ => v.to_string(),
    }
}

/// JS `String(v)`: what a template literal or `+` with a string produces.
pub fn js_string(v: &Value) -> String {
    match v.kind() {
        ValueKind::Undefined => "undefined".into(),
        ValueKind::None => "null".into(),
        ValueKind::Bool => v.is_true().to_string(),
        ValueKind::Number => number_of(v).map(js_number).unwrap_or_default(),
        ValueKind::Seq | ValueKind::Iterable => v
            .try_iter()
            .map(|it| {
                it.map(|x| match x.kind() {
                    ValueKind::Undefined | ValueKind::None => String::new(),
                    _ => js_string(&x),
                })
                .collect::<Vec<_>>()
                .join(",")
            })
            .unwrap_or_default(),
        ValueKind::Map => "[object Object]".into(),
        _ => v.to_string(),
    }
}

/// Attribute text of a value that is [`present`].
pub fn attr_string(v: &Value) -> String {
    match v.kind() {
        ValueKind::Bool => v.is_true().to_string(),
        ValueKind::Number => number_of(v).map(js_number).unwrap_or_default(),
        ValueKind::Undefined | ValueKind::None => String::new(),
        _ => v.to_string(),
    }
}

/// Whether an attribute with this value is rendered at all.
pub fn present(v: &Value) -> bool {
    !(v.is_undefined() || v.is_none() || (v.kind() == ValueKind::Bool && !v.is_true()))
}

fn number_of(v: &Value) -> Option<f64> {
    f64::try_from(v.clone()).ok()
}

/// `n` formatted like JS `String(n)`.
pub fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let a = n.abs();
    if !(1e-6..1e21).contains(&a) {
        // JS exponential form: mantissa, `e`, explicit sign.
        let s = format!("{n:e}");
        let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
        let e: i32 = e.parse().unwrap_or(0);
        return format!("{m}e{}{}", if e < 0 { "-" } else { "+" }, e.abs());
    }
    // Rust's Display is the shortest round-trip form, without exponent here.
    let s = format!("{n}");
    s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
}

/// Escapes text content: `& < > " '`.
pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Escapes an attribute value for a single- or double-quoted attribute.
pub fn escape_attr(s: &str) -> String {
    escape_text(s)
}

fn json_attr(v: Value) -> Result<String, Error> {
    let json = serde_json::to_string(&v)
        .map_err(|e| Error::new(ErrorKind::InvalidOperation, format!("json_attr: {e}")))?;
    Ok(escape_attr(&json))
}

/// JS `String.prototype.slice` over characters (negative indices count from the end).
fn str_slice(s: Value, start: i64, end: Option<i64>) -> String {
    let chars: Vec<char> = paint(&s).chars().collect();
    let len = chars.len() as i64;
    let clamp = |i: i64| if i < 0 { (len + i).max(0) } else { i.min(len) };
    let (a, b) = (clamp(start), clamp(end.unwrap_or(len)));
    if a >= b {
        return String::new();
    }
    chars[a as usize..b as usize].iter().collect()
}

/// JS `includes` on a string (substring) or a list (strict equality).
fn includes(hay: Value, needle: Value) -> bool {
    match hay.kind() {
        ValueKind::String => hay
            .as_str()
            .is_some_and(|h| h.contains(paint(&needle).as_str())),
        ValueKind::Seq | ValueKind::Iterable => hay
            .try_iter()
            .map(|mut it| it.any(|x| x == needle))
            .unwrap_or(false),
        _ => false,
    }
}

/// JS `Array.prototype.join`: `null`/`undefined` items join as empty.
fn join(list: Value, sep: Option<String>, _kw: Kwargs) -> String {
    let sep = sep.unwrap_or_else(|| ",".into());
    list.try_iter()
        .map(|it| {
            it.map(|x| match x.kind() {
                ValueKind::Undefined | ValueKind::None => String::new(),
                ValueKind::Bool => x.is_true().to_string(),
                _ => paint(&x),
            })
            .collect::<Vec<_>>()
            .join(&sep)
        })
        .unwrap_or_default()
}

/// `Object.keys`.
fn keys(v: Value) -> Value {
    match v.kind() {
        ValueKind::Map => Value::from(
            v.try_iter()
                .map(|it| it.collect::<Vec<_>>())
                .unwrap_or_default(),
        ),
        ValueKind::Seq => Value::from(
            (0..v.len().unwrap_or(0))
                .map(|i| Value::from(i.to_string()))
                .collect::<Vec<_>>(),
        ),
        _ => Value::from(Vec::<Value>::new()),
    }
}

/// `Object.entries`: a list of `[key, value]`.
fn entries(v: Value) -> Value {
    let pairs: Vec<Value> = match v.kind() {
        ValueKind::Map => v
            .try_iter()
            .map(|it| {
                it.map(|k| {
                    let val = v.get_item(&k).unwrap_or(Value::UNDEFINED);
                    Value::from(vec![k, val])
                })
                .collect()
            })
            .unwrap_or_default(),
        ValueKind::Seq => v
            .try_iter()
            .map(|it| {
                it.enumerate()
                    .map(|(i, x)| Value::from(vec![Value::from(i.to_string()), x]))
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    Value::from(pairs)
}

/// React's attribute names that differ from the HTML attribute.
pub fn attr_name(react_name: &str) -> String {
    let mapped = match react_name {
        "className" => "class",
        "htmlFor" => "for",
        "tabIndex" => "tabindex",
        "readOnly" => "readonly",
        "maxLength" => "maxlength",
        "minLength" => "minlength",
        "autoComplete" => "autocomplete",
        "autoFocus" => "autofocus",
        "autoPlay" => "autoplay",
        "spellCheck" => "spellcheck",
        "srcSet" => "srcset",
        "crossOrigin" => "crossorigin",
        "httpEquiv" => "http-equiv",
        "acceptCharset" => "accept-charset",
        "contentEditable" => "contenteditable",
        "dateTime" => "datetime",
        "encType" => "enctype",
        "noValidate" => "novalidate",
        "formAction" => "formaction",
        "colSpan" => "colspan",
        "rowSpan" => "rowspan",
        "defaultValue" => "value",
        "defaultChecked" => "checked",
        n if n.starts_with("data-") || n.starts_with("aria-") => return n.to_string(),
        n => return n.to_ascii_lowercase(),
    };
    mapped.to_string()
}

/// Attributes that load or execute a URL (`packages/runtime-dom` bind.ts).
pub const URL_ATTRS: &[&str] = &[
    "href",
    "src",
    "action",
    "formaction",
    "poster",
    "data",
    "xlink:href",
    "ping",
];

pub fn is_url_attr(html_name: &str) -> bool {
    URL_ATTRS.contains(&html_name)
}

/// Attributes never rendered from component code: inline event handlers and
/// `srcdoc` (the runtime refuses to bind them too).
pub fn is_refused_attr(html_name: &str) -> bool {
    html_name.starts_with("on") || html_name == "srcdoc"
}

/// The runtime's URL rule: the scheme of `new URL(v, base)` is http(s),
/// mailto or tel; a relative URL is fine. Like the URL parser, leading and
/// trailing C0 controls / spaces are trimmed and tabs and newlines removed
/// before the scheme is read (`java\tscript:` is caught).
pub fn safe_url(v: &str) -> bool {
    let cleaned: String = v
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let mut scheme = String::new();
    for c in cleaned.chars() {
        match c {
            ':' => {
                let s = scheme.to_ascii_lowercase();
                return matches!(s.as_str(), "http" | "https" | "mailto" | "tel");
            }
            c if c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.') => scheme.push(c),
            // `/`, `?`, `#` or anything else before a `:`: a relative URL.
            _ => return true,
        }
        if !scheme.starts_with(|c: char| c.is_ascii_alphabetic()) {
            return true;
        }
    }
    true
}

/// HTML boolean attributes: rendered present/absent, never `="false"`.
pub const BOOLEAN_ATTRS: &[&str] = &[
    "disabled",
    "checked",
    "selected",
    "readonly",
    "required",
    "hidden",
    "open",
    "multiple",
    "autofocus",
    "autoplay",
    "controls",
    "loop",
    "muted",
    "defer",
    "async",
    "novalidate",
];

pub fn is_boolean_attr(html_name: &str) -> bool {
    BOOLEAN_ATTRS.contains(&html_name)
}

/// React style properties whose numbers are unitless.
const UNITLESS: &[&str] = &[
    "zIndex",
    "opacity",
    "flex",
    "flexGrow",
    "flexShrink",
    "fontWeight",
    "lineHeight",
    "order",
    "zoom",
];

/// `backgroundColor` → `background-color`; `--custom` stays.
pub fn css_property(name: &str) -> String {
    if name.starts_with("--") {
        return name.to_string();
    }
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// A style value as React prints it: numbers get `px` unless unitless or 0.
pub fn css_value(prop: &str, v: &Value) -> String {
    match number_of(v) {
        Some(n) if v.kind() == ValueKind::Number => {
            if n == 0.0 || UNITLESS.contains(&prop) || prop.starts_with("--") {
                js_number(n)
            } else {
                format!("{}px", js_number(n))
            }
        }
        _ => {
            // A string must not end the declaration or open another construct
            // (CSS injection into the server-rendered style attribute; React
            // sets each property on its own, so nothing like it exists there).
            let s = paint(v);
            let lower = s.to_ascii_lowercase();
            let breaks = s.contains([';', '{', '}', '\\', '\n', '\r'])
                || lower.contains("/*")
                || lower.contains("expression(")
                || lower.contains("@import");
            if breaks { String::new() } else { s }
        }
    }
}

/// A literal style object as CSS text (`color:red;font-size:12px`).
pub fn style_obj_to_css(pairs: &[(String, Value)]) -> String {
    pairs
        .iter()
        .filter(|(_, v)| present(v) && !(v.kind() == ValueKind::String && paint(v).is_empty()))
        .map(|(k, v)| format!("{}:{}", css_property(k), css_value(k, v)))
        .collect::<Vec<_>>()
        .join(";")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(src: &str, ctx: Value) -> String {
        let mut env = Environment::new();
        register(&mut env);
        env.render_str(src, ctx).unwrap()
    }

    /// The 5-line attribute unquote a browser would apply.
    fn unescape(s: &str) -> String {
        s.replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
    }

    #[test]
    fn escaping_table() {
        assert_eq!(
            escape_text("a\"b</script>&'"),
            "a&quot;b&lt;/script&gt;&amp;&#39;"
        );
        assert_eq!(
            render("{{ x | e }}", minijinja::context! { x => "a\"b</script>" }),
            "a&quot;b&lt;/script&gt;"
        );
        // Painting: null / undefined / booleans are empty; numbers like JS.
        assert_eq!(
            render("[{{ x | e }}]", minijinja::context! { x => () }),
            "[]"
        );
        assert_eq!(render("[{{ y | e }}]", minijinja::context! {}), "[]");
        assert_eq!(
            render("[{{ x | e }}]", minijinja::context! { x => true }),
            "[]"
        );
        assert_eq!(render("{{ x | e }}", minijinja::context! { x => 2.0 }), "2");
    }

    #[test]
    fn json_attr_round_trips_through_an_attribute() {
        let v = serde_json::json!({ "name": "a\"b</script>", "n": 1, "q": "it's" });
        let html = render(
            "<i x-props='{{ p | json_attr }}'></i>",
            minijinja::context! { p => Value::from_serialize(&v) },
        );
        let inner = html
            .strip_prefix("<i x-props='")
            .and_then(|s| s.strip_suffix("'></i>"))
            .unwrap();
        assert!(!inner.contains('\'') && !inner.contains('<'));
        let back: serde_json::Value = serde_json::from_str(&unescape(inner)).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(js_number(1.0), "1");
        assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(1.5), "1.5");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(123456789012.0), "123456789012");
        assert_eq!(js_number(f64::NAN), "NaN");
        assert_eq!(js_number(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn string_and_list_filters() {
        let ctx = minijinja::context! { s => "Hello", xs => vec!["a", "b"], o => minijinja::context!{ a => 1 } };
        assert_eq!(render("{{ s | str_slice(1, -1) }}", ctx.clone()), "ell");
        assert_eq!(render("{{ s | str_slice(-2) }}", ctx.clone()), "lo");
        assert_eq!(
            render("{% if s | includes('ell') %}y{% endif %}", ctx.clone()),
            "y"
        );
        assert_eq!(
            render("{% if xs | includes('b') %}y{% endif %}", ctx.clone()),
            "y"
        );
        assert_eq!(
            render("{% if s | starts_with('He') %}y{% endif %}", ctx.clone()),
            "y"
        );
        assert_eq!(render("{{ xs | join(', ') }}", ctx.clone()), "a, b");
        assert_eq!(render("{{ o | keys | join }}", ctx.clone()), "a");
        assert_eq!(render("{{ (o | entries)[0][1] }}", ctx.clone()), "1");
        assert_eq!(
            render(
                "{% if x | present %}y{% endif %}",
                minijinja::context! { x => false }
            ),
            ""
        );
        assert_eq!(
            render("{{ x | attr_str }}", minijinja::context! { x => 3 }),
            "3"
        );
    }

    #[test]
    fn attribute_table() {
        for (react, html) in [
            ("className", "class"),
            ("htmlFor", "for"),
            ("tabIndex", "tabindex"),
            ("readOnly", "readonly"),
            ("httpEquiv", "http-equiv"),
            ("data-testId", "data-testId"),
            ("aria-label", "aria-label"),
            ("onClick", "onclick"),
            ("title", "title"),
        ] {
            assert_eq!(attr_name(react), html);
        }
        assert!(is_boolean_attr("disabled") && !is_boolean_attr("value"));
    }

    #[test]
    fn urls_follow_the_runtime_rule() {
        for ok in [
            "/a",
            "a/b:c",
            "https://x.y",
            "HTTP://x",
            "mailto:a@b",
            "tel:1",
            "?q=1",
            "#x",
            "",
        ] {
            assert!(safe_url(ok), "{ok}");
        }
        for bad in [
            "javascript:alert(1)",
            " JavaScript:x",
            "java\tscript:x",
            "java\nscript:x",
            "data:text/html,x",
            "vbscript:x",
        ] {
            assert!(!safe_url(bad), "{bad}");
        }
        assert!(
            is_refused_attr("onclick") && is_refused_attr("srcdoc") && !is_refused_attr("title")
        );
    }

    #[test]
    fn style_objects() {
        let css = style_obj_to_css(&[
            ("backgroundColor".into(), Value::from("red")),
            ("fontSize".into(), Value::from(12)),
            ("zIndex".into(), Value::from(2)),
            ("margin".into(), Value::from(0)),
            ("color".into(), Value::from(())),
        ]);
        assert_eq!(
            css,
            "background-color:red;font-size:12px;z-index:2;margin:0"
        );
    }
}
