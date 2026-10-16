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

pub mod ctx;

#[path = "filters/project.rs"]
mod project;
#[path = "filters/spread.rs"]
pub mod spread;

/// Registers every brust filter on `env` (and the builtins they build on).
/// The one way brust converts serde data into a template value (minijinja 3:
/// `value::Serde`). Takes the data by value; pass a reference to borrow.
pub fn value_of<T: serde::Serialize>(v: T) -> Value {
    Value::from(minijinja::value::Serde(v))
}

pub fn register(env: &mut Environment<'_>) {
    env.set_auto_escape_callback(|_| minijinja::AutoEscape::None);
    // `a.b` on a missing value is undefined (paints empty), never an error.
    env.set_undefined_behavior(minijinja::UndefinedBehavior::Chainable);
    env.add_filter("e", |v: Value| match v.kind() {
        // A string paints as itself: escape it in place, no painted copy.
        ValueKind::String => escape_text(v.as_str().unwrap_or_default()),
        _ => escape_text(&paint(&v)),
    });
    // The ONE unescaped sink: `dangerouslySetInnerHTML` (React's contract: the
    // author owns the markup). null/undefined paint empty, anything else is
    // `String(v)`. The compiler emits it only for an `Attr::InnerHtml`.
    env.add_filter("html_raw", |v: Value| match v.kind() {
        ValueKind::Undefined | ValueKind::None => String::new(),
        ValueKind::String => v.as_str().unwrap_or_default().to_string(),
        _ => js_string(&v),
    });
    env.add_filter("js_str", |v: Value| paint(&v));
    env.add_filter("js_string", |v: Value| js_string(&v));
    env.add_filter("attr_str", |v: Value| attr_string(&v));
    env.add_filter("present", |v: Value| present(&v));
    env.add_filter("present_plain", |v: Value| present_plain(&v));
    env.add_filter("present_str", |v: Value| present_str(&v));
    env.add_filter("bool_true", |v: Value| {
        v.kind() == ValueKind::Bool && v.is_true()
    });
    env.add_filter("truthy", |v: Value| truthy(&v));
    env.add_filter("url_ok", |v: Value| safe_url(&attr_string(&v)));
    env.add_filter("json_attr", json_attr);
    env.add_filter("js_mod", |a: Value, b: Value| {
        js_arith(&a, &b, |x, y| x % y)
    });
    env.add_filter("js_div", |a: Value, b: Value| {
        js_arith(&a, &b, |x, y| x / y)
    });
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
    env.add_filter("project", project::project); // F71, filters/project.rs
    // shadcn S1.2 (R34.15 b): props spread onto an element, keys unknown at compile time.
    env.add_function("spread_attrs", spread::spread_attrs);
    env.add_function("spread_children", spread::spread_children);
    env.add_function("spread_get", spread::spread_get);
    env.add_function("spread_merge", spread::spread_merge);
    env.add_function("obj_assign", spread::obj_assign);
    env.add_function("class_join", spread::class_join);
    env.add_filter("omit", spread::omit);
    env.add_filter("omit_attrs", spread::omit_attrs);
    env.add_filter("css_val", |v: Value, prop: String| css_value(&prop, &v));
    // M3-P P7: a literal style object lowered at compile time. Arguments are
    // `key, value` pairs, already in the order minijinja's dict literal would
    // iterate (sorted by key bytes, last duplicate wins); same CSS as
    // `style_css` on that dict, with no per-element dict built.
    env.add_function(
        "css_decls",
        |args: minijinja::value::Rest<Value>| -> String {
            let pairs: Vec<(String, Value)> = args
                .chunks(2)
                .map(|kv| {
                    (
                        kv[0].as_str().unwrap_or_default().to_string(),
                        kv.get(1).cloned().unwrap_or(Value::UNDEFINED),
                    )
                })
                .collect();
            style_obj_to_css(&pairs)
        },
    );
    env.add_filter("style_css", |v: Value| {
        // Only a style object has declarations (React throws on a string).
        if v.kind() != ValueKind::Map {
            return String::new();
        }
        let pairs: Vec<(String, Value)> = v
            .try_iter()
            .map(|it| {
                it.map(|k| {
                    let val = v.get_item(&k).unwrap_or(Value::UNDEFINED);
                    (k.to_string(), val)
                })
                .collect()
            })
            .unwrap_or_default();
        style_obj_to_css(&pairs)
    });
}

/// JS `ToNumber` for the operands of `%` and `/`.
fn js_to_number(v: &Value) -> f64 {
    match v.kind() {
        ValueKind::Bool => f64::from(u8::from(v.is_true())),
        ValueKind::None => 0.0,
        ValueKind::Number => number_of(v).unwrap_or(f64::NAN),
        ValueKind::String => {
            let t = v.to_string();
            let t = t.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// `%` and `/` with JS semantics (minijinja 3 follows Jinja2: floored
/// modulo, an error on a zero divisor). Rust's f64 `%` and `/` are the
/// IEEE ones JS uses: the remainder takes the dividend's sign, `x / 0` is
/// `±Infinity`, `0 / 0` and `x % 0` are `NaN`. A finite whole result stays
/// an integer so it still indexes, compares and paints like one.
fn js_arith(a: &Value, b: &Value, op: fn(f64, f64) -> f64) -> Value {
    let r = op(js_to_number(a), js_to_number(b));
    if r.is_finite() && r.fract() == 0.0 && r.abs() < 9e15 {
        Value::from(r as i64)
    } else {
        Value::from(r)
    }
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

/// JS `ToBoolean`: false only for undefined, null, false, 0, NaN and "";
/// an empty list or object is true (unlike jinja's own truthiness).
pub fn truthy(v: &Value) -> bool {
    match v.kind() {
        ValueKind::Undefined | ValueKind::None => false,
        ValueKind::Bool => v.is_true(),
        ValueKind::Number => number_of(v).is_some_and(|n| n != 0.0 && !n.is_nan()),
        ValueKind::String => v.as_str().is_some_and(|s| !s.is_empty()),
        _ => true,
    }
}

/// Whether a `Plain` attribute with this value is rendered: React omits `null`, `undefined` and every boolean there.
pub fn present_plain(v: &Value) -> bool {
    !(v.is_undefined() || v.is_none() || v.kind() == ValueKind::Bool)
}

/// Whether a `Stringify` attribute with this value is rendered: only `null` and `undefined` are not (`false` → `"false"`).
pub fn present_str(v: &Value) -> bool {
    !(v.is_undefined() || v.is_none())
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
    let mut last = 0;
    for (i, b) in s.bytes().enumerate() {
        let rep = match b {
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'"' => "&quot;",
            b'\'' => "&#39;",
            _ => continue,
        };
        out.push_str(&s[last..i]);
        out.push_str(rep);
        last = i + 1;
    }
    out.push_str(&s[last..]);
    out
}

/// Escapes an attribute value for a single- or double-quoted attribute.
pub fn escape_attr(s: &str) -> String {
    escape_text(s)
}

/// `JSON.stringify(v)` escaped for an attribute, written in one pass: the JSON
/// text goes straight into the output with the attribute escape applied as
/// it is written. Byte-identical to escaping `serde_json::to_string` of
/// [`to_json`] (kept as the test reference): object keys are sorted and a
/// repeated key keeps its last value (`serde_json::Map` without
/// `preserve_order`), an undefined member is left out, an undefined item is
/// `null`, and every other leaf is written exactly as serde_json prints it.
///
/// A leaf serde_json refuses, or a map whose keys repeat as strings, bails
/// out to the three-pass [`json_attr_slow`], which then decides the exact
/// error (the first in iteration order) or which member wins.
fn json_attr(v: Value) -> Result<String, Error> {
    let mut out = String::new();
    match write_json_attr(&mut out, &v) {
        Ok(()) => Ok(out),
        Err(Bail) => json_attr_slow(v),
    }
}

/// The one-pass writer met a case it leaves to [`json_attr_slow`].
struct Bail;

fn json_attr_err(e: serde_json::Error) -> Error {
    Error::new(ErrorKind::InvalidOperation, format!("json_attr: {e}"))
}

fn write_json_attr(out: &mut String, v: &Value) -> Result<(), Bail> {
    // The render tree writes itself (M3-P P2): sorted string keys, no undefined
    // members, serde_json's own number text — never a bail-out.
    if let Some(m) = v.downcast_object_ref::<ctx::CtxMap>() {
        ctx::write_map(out, &m.0, &[]);
        return Ok(());
    }
    if let Some(a) = v.downcast_object_ref::<ctx::CtxArr>() {
        ctx::write_arr(out, a);
        return Ok(());
    }
    if let Some(p) = v.downcast_object_ref::<ctx::MapView>() {
        ctx::write_map(out, &p.map.0, p.hidden);
        return Ok(());
    }
    match v.kind() {
        ValueKind::Undefined | ValueKind::None => out.push_str("null"),
        ValueKind::Bool => out.push_str(if v.is_true() { "true" } else { "false" }),
        ValueKind::String => write_json_attr_str(out, v.as_str().unwrap_or_default()),
        ValueKind::Map => {
            let mut members: Vec<(Value, Value)> = Vec::new();
            if let Ok(keys) = v.try_iter() {
                for k in keys {
                    let item = v.get_item(&k).unwrap_or(Value::UNDEFINED);
                    if !item.is_undefined() {
                        members.push((k, item));
                    }
                }
            }
            // serde_json's map is ordered by the key string (minijinja's
            // own map usually iterates in that order already).
            let sorted =
                |m: &[(Value, Value)]| m.windows(2).all(|w| *key_str(&w[0].0) < *key_str(&w[1].0));
            if !sorted(&members) {
                members.sort_by(|a, b| key_str(&a.0).cmp(&key_str(&b.0)));
                if !sorted(&members) {
                    return Err(Bail); // a key string repeats
                }
            }
            out.push('{');
            for (i, (k, item)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_attr_str(out, &key_str(k));
                out.push(':');
                write_json_attr(out, item)?;
            }
            out.push('}');
        }
        ValueKind::Seq | ValueKind::Iterable => {
            out.push('[');
            if let Ok(items) = v.try_iter() {
                for (i, x) in items.enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_attr(out, &x)?;
                }
            }
            out.push(']');
        }
        ValueKind::Number => {
            // A number (or `null` for a non-finite float) never holds an
            // attribute special: print serde_json's own text, no copy.
            use std::fmt::Write as _;
            let n = serde_json::to_value(v).map_err(|_| Bail)?;
            let _ = write!(out, "{n}");
        }
        _ => {
            let json = serde_json::to_value(v)
                .and_then(|j| serde_json::to_string(&j))
                .map_err(|_| Bail)?;
            out.push_str(&escape_attr(&json));
        }
    }
    Ok(())
}

/// A map key as serde_json names it (`Value`'s `Display`).
fn key_str(k: &Value) -> std::borrow::Cow<'_, str> {
    match k.as_str() {
        Some(s) => std::borrow::Cow::Borrowed(s),
        None => std::borrow::Cow::Owned(k.to_string()),
    }
}

/// A JSON string literal (serde_json's escapes) with the attribute escape
/// applied on top, in one byte scan; unescaped runs are copied whole.
pub(crate) fn write_json_attr_str(out: &mut String, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.reserve(s.len() + 12);
    out.push_str("&quot;");
    let mut last = 0;
    for (i, b) in s.bytes().enumerate() {
        let rep: &str = match b {
            b'"' => "\\&quot;",
            b'\\' => "\\\\",
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'\'' => "&#39;",
            0x08 => "\\b",
            0x09 => "\\t",
            0x0A => "\\n",
            0x0C => "\\f",
            0x0D => "\\r",
            0x00..=0x1F => {
                out.push_str(&s[last..i]);
                out.push_str("\\u00");
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0xF) as usize] as char);
                last = i + 1;
                continue;
            }
            _ => continue,
        };
        out.push_str(&s[last..i]);
        out.push_str(rep);
        last = i + 1;
    }
    out.push_str(&s[last..]);
    out.push_str("&quot;");
}

/// The pre-one-pass `json_attr` (three passes: `Value` → `serde_json::Value`
/// → JSON text → attribute escape): the bail-out path, and the reference the
/// one-pass writer is pinned against in the tests.
fn json_attr_slow(v: Value) -> Result<String, Error> {
    let json = serde_json::to_string(&to_json(&v)?).map_err(json_attr_err)?;
    Ok(escape_attr(&json))
}

/// `JSON.stringify` semantics: an undefined object member is left out (so a
/// destructuring default still applies on the client); in a list it is `null`.
fn to_json(v: &Value) -> Result<serde_json::Value, Error> {
    let err = json_attr_err;
    Ok(match v.kind() {
        ValueKind::Undefined | ValueKind::None => serde_json::Value::Null,
        ValueKind::Map => {
            let mut m = serde_json::Map::new();
            if let Ok(keys) = v.try_iter() {
                for k in keys {
                    let item = v.get_item(&k).unwrap_or(Value::UNDEFINED);
                    if item.is_undefined() {
                        continue;
                    }
                    m.insert(k.to_string(), to_json(&item)?);
                }
            }
            serde_json::Value::Object(m)
        }
        ValueKind::Seq | ValueKind::Iterable => serde_json::Value::Array(
            v.try_iter()
                .map(|it| it.map(|x| to_json(&x)).collect::<Result<Vec<_>, _>>())
                .unwrap_or(Ok(Vec::new()))?,
        ),
        _ => serde_json::to_value(v).map_err(err)?,
    })
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
        "xlinkHref" => "xlink:href",
        "xmlLang" => "xml:lang",
        // SVG presentation attributes React writes in kebab case.
        n if SVG_KEBAB.contains(&n) => return css_property(n),
        // Anything else keeps its case: HTML attributes are case-insensitive,
        // SVG ones (`viewBox`, `preserveAspectRatio`) are not.
        n => return n.to_string(),
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

/// Case-insensitive: HTML attribute names are (`HREF` is `href`).
pub fn is_url_attr(html_name: &str) -> bool {
    URL_ATTRS.contains(&html_name.to_ascii_lowercase().as_str())
}

/// Attributes never rendered from component code: inline event handlers and
/// `srcdoc` (the runtime refuses to bind them too), and every `x-` name: those are
/// runtime-dom directives, which only the compiler may emit (F94).
pub fn is_refused_attr(html_name: &str) -> bool {
    let n = html_name.to_ascii_lowercase();
    n.starts_with("on") || n == "srcdoc" || n.starts_with("x-")
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

/// SVG attributes React maps from camelCase to kebab-case.
const SVG_KEBAB: &[&str] = &[
    "alignmentBaseline",
    "baselineShift",
    "clipPath",
    "clipRule",
    "colorInterpolation",
    "colorInterpolationFilters",
    "dominantBaseline",
    "enableBackground",
    "fillOpacity",
    "fillRule",
    "floodColor",
    "floodOpacity",
    "fontFamily",
    "fontSize",
    "fontSizeAdjust",
    "fontStretch",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "imageRendering",
    "letterSpacing",
    "lightingColor",
    "markerEnd",
    "markerMid",
    "markerStart",
    "paintOrder",
    "pointerEvents",
    "shapeRendering",
    "stopColor",
    "stopOpacity",
    "strokeDasharray",
    "strokeDashoffset",
    "strokeLinecap",
    "strokeLinejoin",
    "strokeMiterlimit",
    "strokeOpacity",
    "strokeWidth",
    "textAnchor",
    "textDecoration",
    "textRendering",
    "unicodeBidi",
    "vectorEffect",
    "wordSpacing",
    "writingMode",
];

/// HTML boolean attributes: rendered present/absent, never `="false"`. React's own list (ReactDOM's property table
/// for `BOOLEAN` and the property-only booleans `checked` and `selected`), lowercase; `tests` compare it with react-dom.
pub const BOOLEAN_ATTRS: &[&str] = &[
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "disablepictureinpicture",
    "disableremoteplayback",
    "formnovalidate",
    "hidden",
    "inert",
    "itemscope",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "scoped",
    "seamless",
    "selected",
];

/// Attributes React writes `true` as `""` and `false` as nothing, and any other value as a string.
pub const OVERLOADED_ATTRS: &[&str] = &["capture", "download"];

/// Attributes React writes a boolean as the string `"true"` / `"false"` (the "booleanish string" attributes), besides
/// every `aria-*` and `data-*`.
pub const STRINGIFY_ATTRS: &[&str] = &[
    "autoreverse",
    "contenteditable",
    "draggable",
    "externalresourcesrequired",
    "focusable",
    "preservealpha",
    "spellcheck",
    "value",
];

/// What React does with a boolean value (`true`/`false`) on an attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttrKind {
    /// `true` → present with `""`, `false` (and any falsy value) → absent.
    Boolean,
    /// `true` → `""`, `false` → absent, any other present value → its string.
    Overloaded,
    /// `true` → `"true"`, `false` → `"false"`.
    Stringify,
    /// Any other attribute: a boolean prints nothing (React warns and omits it).
    Plain,
}

/// The kind of an HTML attribute name (case-insensitive).
pub fn attr_kind(html_name: &str) -> AttrKind {
    let n = html_name.to_ascii_lowercase();
    if n.starts_with("aria-") || n.starts_with("data-") || STRINGIFY_ATTRS.contains(&n.as_str()) {
        AttrKind::Stringify
    } else if BOOLEAN_ATTRS.contains(&n.as_str()) {
        AttrKind::Boolean
    } else if OVERLOADED_ATTRS.contains(&n.as_str()) {
        AttrKind::Overloaded
    } else {
        AttrKind::Plain
    }
}

pub fn is_boolean_attr(html_name: &str) -> bool {
    attr_kind(html_name) == AttrKind::Boolean
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

/// A style key that is a CSS identifier (`fontSize`, `--gap`): anything else
/// could inject declarations.
pub fn css_key(k: &str) -> bool {
    let word = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    match k.strip_prefix("--") {
        Some(custom) => !custom.is_empty() && word(custom),
        None => k.starts_with(|c: char| c.is_ascii_alphabetic()) && word(k),
    }
}

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
/// The same rule as the chunk's `__css` helper (`lower/client.rs`): a
/// property is dropped when its value is null, undefined, false, or a string
/// that is empty or could end the declaration.
pub fn style_obj_to_css(pairs: &[(String, Value)]) -> String {
    pairs
        .iter()
        .filter(|(k, v)| present(v) && css_key(k))
        .filter_map(|(k, v)| {
            let val = css_value(k, v);
            (!val.is_empty()).then(|| format!("{}:{val}", css_property(k)))
        })
        .collect::<Vec<_>>()
        .join(";")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::{FLOATS, Rng, gen_string, unescape};

    fn render(src: &str, ctx: Value) -> String {
        let mut env = Environment::new();
        register(&mut env);
        env.render_str(src, ctx).unwrap()
    }

    /// C4: `t.name` must read the same key as `t["name"]` for every name the
    /// compiler may emit it for, including names that are map methods.
    #[test]
    fn attribute_access_equals_subscript_for_map_keys() {
        let names = [
            "items",
            "keys",
            "values",
            "get",
            "length",
            "len",
            "count",
            "update",
            "pop",
            "title",
            "upper",
            "lower",
            "name",
            "_x",
            "a1",
            "loop",
            "self",
            "super",
            "caller",
            "varargs",
            "kwargs",
            "true",
            "false",
            "none",
            "True",
            "False",
            "None",
            "and",
            "or",
            "not",
            "in",
            "is",
            "if",
            "else",
            "for",
            "set",
            "with",
            "block",
            "import",
            "macro",
            "filter",
            "call",
            "do",
            "extends",
            "include",
            "from",
            "as",
            "recursive",
            "ignore",
            "missing",
            "context",
            "without",
            "scoped",
            "elif",
            "endif",
            "raw",
            "test",
        ];
        for n in names {
            let map: serde_json::Value = serde_json::json!({ n: "V" });
            let ctx = value_of(serde_json::json!({ "t": map }));
            let bracket = format!("{{{{ t[\"{n}\"] }}}}");
            let dotted = format!("{{{{ t.{n} }}}}");
            let mut env = Environment::new();
            register(&mut env);
            let b = env.render_str(&bracket, ctx.clone()).unwrap();
            let d = env.render_str(&dotted, ctx).unwrap();
            assert_eq!(b, "V", "{n}");
            assert_eq!(d, b, "{n}");
        }
        // Non-map targets and absent keys fail or render identically both ways.
        for t in [
            serde_json::json!(null),
            serde_json::json!("str"),
            serde_json::json!([1, 2]),
            serde_json::json!(3),
            serde_json::json!({}),
            serde_json::json!({ "a": null }),
        ] {
            for n in ["items", "name", "length", "a"] {
                let ctx = value_of(serde_json::json!({ "t": t }));
                let mut env = Environment::new();
                register(&mut env);
                let b = env.render_str(&format!("{{{{ t[\"{n}\"] }}}}"), ctx.clone());
                let d = env.render_str(&format!("{{{{ t.{n} }}}}"), ctx);
                assert_eq!(
                    b.map_err(|e| e.to_string()),
                    d.map_err(|e| e.to_string()),
                    "{t} {n}"
                );
            }
        }
    }

    #[test]
    fn js_mod_and_js_div_follow_javascript() {
        let ctx = || Value::from(());
        for (expr, want) in [
            ("-7 | js_mod(3)", "-1"),
            ("7 | js_mod(-3)", "1"),
            ("6 | js_mod(3)", "0"),
            ("5.5 | js_mod(2)", "1.5"),
            ("3 | js_mod(0)", "NaN"),
            ("7 | js_div(2)", "3.5"),
            ("6 | js_div(3)", "2"),
            ("1 | js_div(0)", "Infinity"),
            ("-1 | js_div(0)", "-Infinity"),
            ("0 | js_div(0)", "NaN"),
            ("true | js_div(2)", "0.5"),
            ("none | js_mod(2)", "0"),
            ("'8' | js_div(2)", "4"),
            ("'x' | js_div(2)", "NaN"),
        ] {
            assert_eq!(
                render(&format!("{{{{ ({expr}) | js_string }}}}"), ctx()),
                want,
                "{expr}"
            );
        }
        // A whole result stays an integer: it still indexes a list.
        assert_eq!(
            render("{{ ['a','b','c'][7 | js_mod(2)] }}", Value::from(())),
            "b"
        );
    }

    #[test]
    fn escaping_table() {
        assert_eq!(
            escape_text("a\"b</script>&'"),
            "a&quot;b&lt;/script&gt;&amp;&#39;"
        );
        // `e` on a string escapes it directly (short inline and long heap
        // strings, a safe-marked one too) — same as escaping its paint.
        assert_eq!(
            render(
                "{{ a | e }}|{{ b | e }}|{{ a | safe | e }}",
                minijinja::context! { a => "<a>", b => "x".repeat(40) + "&" }
            ),
            format!("&lt;a&gt;|{}&amp;|&lt;a&gt;", "x".repeat(40))
        );
        // Byte scan == the char-by-char table: multi-byte text, runs at both
        // ends, adjacent specials, empty.
        for s in ["", "&", "plain", "ไทย<é>😀&'\"", "<<>>", "x&y", "é"] {
            let want: String = s
                .chars()
                .map(|c| match c {
                    '&' => "&amp;".to_string(),
                    '<' => "&lt;".to_string(),
                    '>' => "&gt;".to_string(),
                    '"' => "&quot;".to_string(),
                    '\'' => "&#39;".to_string(),
                    c => c.to_string(),
                })
                .collect();
            assert_eq!(escape_text(s), want, "{s:?}");
        }
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
            minijinja::context! { p => value_of(&v) },
        );
        let inner = html
            .strip_prefix("<i x-props='")
            .and_then(|s| s.strip_suffix("'></i>"))
            .unwrap();
        assert!(!inner.contains('\'') && !inner.contains('<'));
        let back: serde_json::Value = serde_json::from_str(&unescape(inner)).unwrap();
        assert_eq!(back, v);
        // Undefined members are left out, like JSON.stringify.
        assert_eq!(
            render(
                "{{ {\"a\": 1, \"b\": missing} | json_attr }}",
                minijinja::context! {}
            ),
            "{&quot;a&quot;:1}"
        );
    }

    /// A map object that enumerates its keys in the given order (unsorted,
    /// repeating key strings) — what a minijinja map never does.
    #[derive(Debug)]
    struct Pairs(Vec<(Value, Value)>);
    impl minijinja::value::Object for Pairs {
        fn get_value(self: &std::sync::Arc<Self>, key: &Value) -> Option<Value> {
            self.0
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        }
        fn enumerate(self: &std::sync::Arc<Self>) -> minijinja::value::Enumerator {
            let keys: Vec<Value> = self.0.iter().map(|(k, _)| k.clone()).collect();
            minijinja::value::Enumerator::Iter(Box::new(keys.into_iter()))
        }
    }
    #[derive(Debug)]
    struct Opaque;
    impl minijinja::value::Object for Opaque {
        fn repr(self: &std::sync::Arc<Self>) -> minijinja::value::ObjectRepr {
            minijinja::value::ObjectRepr::Plain
        }
    }

    fn gen_number(r: &mut Rng) -> Value {
        match r.below(8) {
            0 => Value::from(FLOATS[r.below(FLOATS.len() as u64) as usize]),
            1 => Value::from(f64::from_bits(r.next())),
            2 => Value::from(r.next() as i64),
            3 => Value::from(r.next()),
            4 => Value::from([i64::MIN, i64::MAX, 0, -1][r.below(4) as usize]),
            5 => Value::from(i128::from(r.next() as i64) * i128::from(r.next())), // may overflow JSON
            6 => Value::from(u128::from(r.below(1000))),
            _ => Value::from(r.below(1000) as f64 / 8.0),
        }
    }

    fn gen_value(r: &mut Rng, depth: u32) -> Value {
        let leaf = depth == 0 || r.below(3) == 0;
        match if leaf { r.below(8) } else { 8 + r.below(5) } {
            0 => Value::UNDEFINED,
            1 => Value::from(()),
            2 => Value::from(r.below(2) == 0),
            3 | 4 => gen_number(r),
            5 => Value::from(gen_string(r)),
            6 => Value::from_safe_string(gen_string(r)),
            7 => match r.below(3) {
                0 => Value::from_bytes(gen_string(r).into_bytes()),
                1 => Value::from_object(Opaque),
                _ => Value::from(gen_string(r)),
            },
            8 => Value::from(
                (0..r.below(5))
                    .map(|_| gen_value(r, depth - 1))
                    .collect::<Vec<_>>(),
            ),
            9 => {
                let items: Vec<Value> = (0..r.below(4)).map(|_| gen_value(r, depth - 1)).collect();
                Value::make_iterable(move || items.clone().into_iter())
            }
            10 | 11 => (0..r.below(6))
                .map(|_| (gen_string(r), gen_value(r, depth - 1)))
                .collect::<Value>(),
            _ => {
                let n = r.below(5);
                let pairs = (0..n)
                    .map(|_| {
                        let k = match r.below(4) {
                            0 => Value::from(r.below(3) as i64),
                            1 => Value::from(r.below(3).to_string()),
                            2 => Value::from(r.below(2) == 0),
                            _ => Value::from(gen_string(r)),
                        };
                        (k, gen_value(r, depth - 1))
                    })
                    .collect();
                Value::from_object(Pairs(pairs))
            }
        }
    }

    #[test]
    fn json_attr_one_pass_matches_the_three_pass_reference() {
        let err = |r: Result<String, Error>| r.map_err(|e| e.to_string());
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        let (mut fast, mut bails) = (0, 0);
        for i in 0..20_000 {
            let v = gen_value(&mut r, 4);
            // The writer alone (no bail-out) where it does not bail.
            let mut out = String::new();
            if write_json_attr(&mut out, &v).is_ok() {
                fast += 1;
                assert_eq!(Ok(out), err(json_attr_slow(v.clone())), "#{i}: {v:?}");
            } else {
                bails += 1;
            }
            assert_eq!(
                err(json_attr(v.clone())),
                err(json_attr_slow(v.clone())),
                "#{i}: {v:?}"
            );
        }
        // Bail-outs are the rare shapes (refused numbers, repeated keys).
        assert!(fast > bails * 2, "fast {fast}, bails {bails}");
        // Every C0 control, the JSON and the attribute specials, together.
        let all: String = (0u8..0x80).map(char::from).collect::<String>() + "é😀\u{2028}";
        let v = Value::from(all.clone());
        let mut out = String::new();
        assert!(write_json_attr(&mut out, &v).is_ok());
        assert_eq!(Ok(out), err(json_attr_slow(v)));
        // serde_json orders a map by key string: an unsorted map is sorted.
        let v = Value::from_object(Pairs(vec![
            (Value::from("b"), Value::from(1)),
            (Value::from("a"), Value::from(2)),
        ]));
        assert_eq!(json_attr(v).unwrap(), "{&quot;a&quot;:2,&quot;b&quot;:1}");
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
        // html_raw: the one unescaped sink; null/undefined paint empty, else String(v).
        let raw = |t: &str, c: Value| render(t, c);
        assert_eq!(
            raw(
                "{{ x | html_raw }}",
                minijinja::context! { x => "<b>&</b>" }
            ),
            "<b>&</b>"
        );
        assert_eq!(
            raw("{{ x | html_raw }}", minijinja::context! { x => () }),
            ""
        );
        assert_eq!(raw("{{ x | html_raw }}", minijinja::context! {}), "");
        assert_eq!(
            raw("{{ x | html_raw }}", minijinja::context! { x => 7 }),
            "7"
        );
        assert_eq!(
            raw("{{ x | html_raw }}", minijinja::context! { x => 1.5 }),
            "1.5"
        );
        assert_eq!(
            raw("{{ x | html_raw }}", minijinja::context! { x => true }),
            "true"
        );
        assert!(is_refused_attr("x-html") && is_refused_attr("X-HTML"));
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
            ("onClick", "onClick"),
            ("viewBox", "viewBox"),
            ("strokeWidth", "stroke-width"),
            ("xlinkHref", "xlink:href"),
            ("title", "title"),
        ] {
            assert_eq!(attr_name(react), html);
        }
        assert!(is_boolean_attr("disabled") && !is_boolean_attr("value"));
        // F196: what React does with a boolean value, by attribute
        for (n, k) in [
            ("aria-checked", AttrKind::Stringify),
            ("data-state", AttrKind::Stringify),
            ("draggable", AttrKind::Stringify),
            ("spellcheck", AttrKind::Stringify),
            ("value", AttrKind::Stringify),
            ("hidden", AttrKind::Boolean),
            ("PlaysInline", AttrKind::Boolean),
            ("inert", AttrKind::Boolean),
            ("download", AttrKind::Overloaded),
            ("title", AttrKind::Plain),
            ("class", AttrKind::Plain),
        ] {
            assert_eq!(attr_kind(n), k, "{n}");
        }
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
        // F94: every runtime directive family is reserved; near-misses stay allowed.
        for d in [
            "x-data",
            "x-props",
            "x-props-bind",
            "x-on-click",
            "x-bind-class",
            "x-text",
            "x-html",
            "x-raw",
            "x-if",
            "x-for",
            "x-show",
            "x-model",
            "x-ref",
            "X-On-Click",
        ] {
            assert!(is_refused_attr(d), "{d}");
        }
        for ok in ["xlink:href", "data-x-foo", "x", "xmlns", "max"] {
            assert!(!is_refused_attr(ok), "{ok}");
        }
    }

    #[test]
    fn truthiness_is_javascripts() {
        for (v, want) in [
            (Value::from(Vec::<i32>::new()), true),
            (value_of(serde_json::json!({})), true),
            (Value::from(""), false),
            (Value::from(0), false),
            (Value::from(f64::NAN), false),
            (Value::from(()), false),
            (Value::UNDEFINED, false),
            (Value::from("0"), true),
        ] {
            assert_eq!(truthy(&v), want, "{v:?}");
        }
        assert_eq!(
            render(
                "{{ s | style_css }}",
                minijinja::context! { s => minijinja::context!{ color => "red", fontSize => 12 } }
            ),
            "color:red;font-size:12px"
        );
        assert_eq!(
            render(
                "[{{ s | style_css }}]",
                minijinja::context! { s => "color:red" }
            ),
            "[]"
        );
        assert!(css_key("fontSize") && css_key("--gap") && !css_key("a;b") && !css_key("x:y"));
    }

    /// HTML attribute names are case-insensitive: so are the guards.
    #[test]
    fn attribute_guards_ignore_case() {
        assert!(
            is_refused_attr("ONCLICK")
                && is_refused_attr("srcDoc")
                && is_refused_attr("onMouseOver")
        );
        assert!(is_url_attr("HREF") && is_url_attr("Src") && is_boolean_attr("DISABLED"));
    }

    /// M3-P P7: `css_decls(k1, v1, k2, v2, ...)` (pairs already sorted and
    /// de-duplicated by the compiler) prints what `style_css` prints for the
    /// equivalent dict literal. Also proves minijinja's dict literal iterates
    /// sorted and keeps the last value of a duplicate key.
    #[test]
    fn css_decls_equals_style_css_on_the_dict_literal() {
        let vals = [
            ("str", Value::from("red")),
            ("num", Value::from(12)),
            ("zero", Value::from(0)),
            ("null", Value::from(())),
            ("undef", Value::UNDEFINED),
            ("false", Value::from(false)),
            ("breaker", Value::from("red; x:y")),
            ("empty", Value::from("")),
        ];
        let keys = ["opacity", "--custom", "fontSize", "color", "bad key", "9x"];
        for (name, v) in &vals {
            for k in keys {
                let ctx = minijinja::context! { x => v.clone(), y => "blue" };
                let lit = render(
                    &format!("{{{{ {{\"b\": y, {k:?}: x, \"a\": y}} | style_css }}}}"),
                    ctx.clone(),
                );
                // the compiler's form: sorted by key bytes
                let mut ks = vec![("b", "y"), ("a", "y"), (k, "x")];
                ks.sort();
                let args = ks
                    .iter()
                    .map(|(kk, vv)| format!("{kk:?}, {vv}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let got = render(&format!("{{{{ css_decls({args}) }}}}"), ctx);
                assert_eq!(got, lit, "{name} / {k}");
            }
        }
        // duplicate key: the last value wins in the literal; unsorted source
        // order iterates sorted.
        let ctx = minijinja::context! { x => 1, y => 2 };
        let lit = render(
            "{{ {\"z\": x, \"a\": y, \"z\": y} | style_css }}",
            ctx.clone(),
        );
        assert_eq!(lit, "a:2px;z:2px");
        assert_eq!(render("{{ css_decls(\"a\", y, \"z\", y) }}", ctx), lit);
        assert_eq!(render("{{ css_decls() }}", Value::from(())), "");
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

/// Generators shared by the test modules (`lib.rs`, `ctx.rs`).
#[cfg(test)]
pub(crate) mod tests_support {
    /// The 5-line attribute unquote a browser would apply.
    pub(crate) fn unescape(s: &str) -> String {
        s.replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
    }

    /// xorshift64*: a deterministic generator for the equivalence sweep.
    pub(crate) struct Rng(pub(crate) u64);
    impl Rng {
        pub(crate) fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        pub(crate) fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    pub(crate) fn gen_string(r: &mut Rng) -> String {
        const PIECES: &[&str] = &[
            "a",
            "Z",
            "0",
            " ",
            "&",
            "<",
            ">",
            "\"",
            "'",
            "\\",
            "/",
            "\u{7f}",
            "é",
            "ไทย",
            "😀",
            "\u{2028}",
            "\u{feff}",
            "&amp;",
            "</script>",
            "{}",
            "[],:",
            "plain text",
        ];
        let mut s = String::new();
        for _ in 0..r.below(12) {
            if r.below(4) == 0 {
                // Every C0 control: the short escapes and the \u00XX ones.
                s.push(char::from(r.below(0x20) as u8));
            } else {
                s.push_str(PIECES[r.below(PIECES.len() as u64) as usize]);
            }
        }
        s
    }

    pub(crate) const FLOATS: &[f64] = &[
        0.0,
        -0.0,
        1.0,
        -1.5,
        0.1,
        0.30000000000000004,
        1e21,
        1e-7,
        123456789012.0,
        f64::MAX,
        f64::MIN_POSITIVE,
        5e-324,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];

    /// A JSON number from the same corpus as `gen_number` (non-finite floats
    /// have no JSON form and are skipped by `Number::from_f64`).
    pub(crate) fn gen_number_json(r: &mut Rng) -> serde_json::Value {
        let f = |x: f64| {
            serde_json::Number::from_f64(x)
                .map_or(serde_json::Value::Null, serde_json::Value::Number)
        };
        match r.below(6) {
            0 => f(FLOATS[r.below(FLOATS.len() as u64) as usize]),
            1 => f(f64::from_bits(r.next())),
            2 => serde_json::Value::from(r.next() as i64),
            3 => serde_json::Value::from(r.next()),
            4 => serde_json::Value::from([i64::MIN, i64::MAX, 0, -1][r.below(4) as usize]),
            _ => f(r.below(1000) as f64 / 8.0),
        }
    }

    /// Random JSON: unsorted keys (generated in random order), nested
    /// arrays/objects, every number form, the `gen_string` corpus.
    pub(crate) fn gen_json(r: &mut Rng, depth: u32) -> serde_json::Value {
        use serde_json::Value as J;
        let leaf = depth == 0 || r.below(3) == 0;
        match if leaf { r.below(5) } else { 5 + r.below(2) } {
            0 => J::Null,
            1 => J::Bool(r.below(2) == 0),
            2 | 3 => gen_number_json(r),
            4 => J::String(gen_string(r)),
            5 => J::Array((0..r.below(5)).map(|_| gen_json(r, depth - 1)).collect()),
            _ => J::Object(
                (0..r.below(6))
                    .map(|_| (gen_string(r), gen_json(r, depth - 1)))
                    .collect(),
            ),
        }
    }
}
