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
pub mod slot;
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
    // W1d PR 3: a component threw while rendering (`throw new Error(…)` at the end of an early-return chain): the render
    // fails, the server answers with its own 500 and logs this. The message is fixed: nothing of the app reaches a body.
    env.add_filter(
        "render_error",
        |_v: Value| -> Result<Value, minijinja::Error> {
            Err(minijinja::Error::new(
                minijinja::ErrorKind::InvalidOperation,
                "a component threw while rendering",
            ))
        },
    );
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
    // F420 / F421: how react-dom prints a controlled `<select>` and `<textarea>` on the server.
    env.add_filter("selected_in", |opt: Value, sel: Value| {
        selected_in(&opt, &sel)
    });
    env.add_filter("textarea_text", |v: Value| textarea_text(&v));
    env.add_filter("url_ok", |v: Value| safe_url(&attr_string(&v)));
    env.add_filter("json_attr", json_attr);
    env.add_filter("js_mod", |a: Value, b: Value| {
        js_arith(&a, &b, |x, y| x % y)
    });
    env.add_filter("js_div", |a: Value, b: Value| {
        js_arith(&a, &b, |x, y| x / y)
    });
    env.add_filter("js_add", |a: Value, b: Value| js_add(&a, &b));
    env.add_filter("js_sub", |a: Value, b: Value| {
        js_arith(&a, &b, |x, y| x - y)
    });
    env.add_filter("js_mul", |a: Value, b: Value| {
        js_arith(&a, &b, |x, y| x * y)
    });
    env.add_filter("js_neg", |a: Value| {
        js_arith(&a, &Value::from(0), |x, _| -x)
    });
    env.add_filter("js_num", |a: Value| js_arith(&a, &Value::from(0), |x, _| x));
    env.add_filter("js_cmp", |a: Value, b: Value, op: String| {
        js_cmp(&a, &b, &op)
    });
    env.add_filter("js_eq", |a: Value, b: Value| js_loose_eq(&a, &b));
    env.add_filter("js_seq", |a: Value, b: Value| js_strict_eq(&a, &b));
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
    env.add_function("spread_attrs_control", spread::spread_attrs_control);
    env.add_function("spread_control_value", spread::spread_control_value);
    env.add_function("spread_children", spread::spread_children);
    env.add_function("spread_get", spread::spread_get);
    env.add_function("spread_merge", spread::spread_merge);
    env.add_function("obj_assign", spread::obj_assign);
    env.add_function("obj_lit", spread::obj_lit);
    env.add_function("class_join", spread::class_join);
    // F523 (C5): a recursive component nested past the depth cap: the render fails, naming the component and the cap
    // (minijinja's own `recursion limit exceeded` names neither).
    env.add_function(
        "recursion_limit",
        |component: String, cap: u32| -> Result<Value, minijinja::Error> {
            Err(minijinja::Error::new(
                minijinja::ErrorKind::InvalidOperation,
                format!("<{component}> nested more than {cap} levels"),
            ))
        },
    );
    // F519: a runtime component slot; the server's renderer is in the context, or the slot prints nothing.
    env.add_function("brust_dynamic", slot::brust_dynamic);
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
            let mut out = String::new();
            push_style_decls(&mut out, arg_pairs(&args));
            out
        },
    );
    // F296 C3: the whole ` style="…"` attribute, or nothing when no declaration is left (react-dom omits an
    // empty `style`, where `style=""` would be a different first paint). Same pairs as `css_decls`, in source order.
    env.add_function(
        "css_attr",
        |args: minijinja::value::Rest<Value>| -> String {
            let mut out = String::new();
            push_style_attr(&mut out, arg_pairs(&args), false);
            out
        },
    );
    env.add_filter("style_attr", |v: Value| {
        if v.kind() != ValueKind::Map {
            return String::new();
        }
        style_attr_of_map(&v, false)
    });
    env.add_filter("style_css", |v: Value| {
        // Only a style object has declarations (React throws on a string).
        if v.kind() != ValueKind::Map {
            return String::new();
        }
        style_css_of_map(&v)
    });
}

/// JS `ToNumber` for the operands of the arithmetic operators and `<` / `>`: `undefined` is `NaN`, `null` is 0, a boolean
/// 0 / 1, a string its numeric literal (blank is 0; `Infinity`, `0x` / `0o` / `0b` forms; anything else `NaN`), an
/// object or array `ToNumber` of its string.
fn js_to_number(v: &Value) -> f64 {
    match v.kind() {
        ValueKind::Bool => f64::from(u8::from(v.is_true())),
        ValueKind::None => 0.0,
        ValueKind::Undefined => f64::NAN,
        ValueKind::Number => number_of(v).unwrap_or(f64::NAN),
        ValueKind::String => string_to_number(&v.to_string()),
        ValueKind::Seq | ValueKind::Iterable | ValueKind::Map => string_to_number(&js_string(v)),
        _ => f64::NAN,
    }
}

fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    // Rust also parses `inf`, `nan` and `infinity`; JS does not.
    if !t
        .bytes()
        .all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
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

/// JS `a + b` for operands the compiler cannot prove are both numbers (F424): a string (or an object / array, which
/// `ToPrimitive` turns into one) on either side concatenates `String()` of both; otherwise `ToNumber` of each is added
/// (`undefined` is `NaN`, `null` is 0, `true` is 1). jinja's own `+` errors on string + number and on `none`.
pub fn js_add(a: &Value, b: &Value) -> Value {
    let stringy = |v: &Value| {
        !matches!(
            v.kind(),
            ValueKind::Undefined | ValueKind::None | ValueKind::Bool | ValueKind::Number
        )
    };
    if stringy(a) || stringy(b) {
        return Value::from(format!("{}{}", js_string(a), js_string(b)));
    }
    js_arith(a, b, |x, y| x + y)
}

/// `ToPrimitive` for the operators: an object or array is its string.
fn js_primitive(v: &Value) -> Value {
    match v.kind() {
        ValueKind::Seq | ValueKind::Iterable | ValueKind::Map => Value::from(js_string(v)),
        _ => v.clone(),
    }
}

/// JS `a < b`, `a <= b`, `a > b`, `a >= b` (`op` is the operator): two strings compare by UTF-16 code unit, anything
/// else by `ToNumber` of each (`NaN` is false for all four).
pub fn js_cmp(a: &Value, b: &Value, op: &str) -> bool {
    use std::cmp::Ordering;
    let (a, b) = (js_primitive(a), js_primitive(b));
    let ord = if a.kind() == ValueKind::String && b.kind() == ValueKind::String {
        a.to_string()
            .encode_utf16()
            .cmp(b.to_string().encode_utf16())
    } else {
        match js_to_number(&a).partial_cmp(&js_to_number(&b)) {
            Some(o) => o,
            None => return false,
        }
    };
    match op {
        "<" => ord == Ordering::Less,
        "<=" => ord != Ordering::Greater,
        ">" => ord == Ordering::Greater,
        _ => ord != Ordering::Less,
    }
}

fn is_nullish(v: &Value) -> bool {
    matches!(v.kind(), ValueKind::Undefined | ValueKind::None)
}

fn is_container(v: &Value) -> bool {
    matches!(
        v.kind(),
        ValueKind::Seq | ValueKind::Iterable | ValueKind::Map
    )
}

/// JS `a === b`. Two arrays or objects are never equal here (JS compares identity, which a template cannot see).
pub fn js_strict_eq(a: &Value, b: &Value) -> bool {
    match (a.kind(), b.kind()) {
        (ValueKind::Undefined, ValueKind::Undefined) | (ValueKind::None, ValueKind::None) => true,
        (ValueKind::Bool, ValueKind::Bool) => a.is_true() == b.is_true(),
        (ValueKind::Number, ValueKind::Number) => number_of(a) == number_of(b),
        (ValueKind::String, ValueKind::String) => a.to_string() == b.to_string(),
        _ => false,
    }
}

/// JS `a == b`: `null` and `undefined` equal each other and nothing else; a boolean is its number; a number and a string
/// compare as numbers; an object or array is its string against a primitive; two objects are never equal here.
pub fn js_loose_eq(a: &Value, b: &Value) -> bool {
    if is_nullish(a) || is_nullish(b) {
        return is_nullish(a) && is_nullish(b);
    }
    if is_container(a) && is_container(b) {
        return false;
    }
    let (a, b) = (js_primitive(a), js_primitive(b));
    match (a.kind(), b.kind()) {
        (ValueKind::String, ValueKind::String) => a.to_string() == b.to_string(),
        (ValueKind::Bool, ValueKind::Bool) => a.is_true() == b.is_true(),
        _ => js_to_number(&a) == js_to_number(&b),
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

/// Whether `<option>` text `opt` is picked by the value of its `<select>` (react-dom marks it `selected`): the select's
/// value, or any element of an array, as a string equals the option's; a `null` / `undefined` select value picks none.
pub fn selected_in(opt: &Value, sel: &Value) -> bool {
    let opt = js_string(opt);
    match sel.kind() {
        ValueKind::Undefined | ValueKind::None => false,
        ValueKind::Seq | ValueKind::Iterable => sel
            .try_iter()
            .map(|mut it| it.any(|x| js_string(&x) == opt))
            .unwrap_or(false),
        _ => js_string(sel) == opt,
    }
}

/// The text content of a `<textarea>` with this `value`: `String(v)` (`null` and `undefined` are empty), with the
/// newline react-dom adds after a leading one, because the parser drops the first newline of a textarea.
pub fn textarea_text(v: &Value) -> String {
    let s = match v.kind() {
        ValueKind::Undefined | ValueKind::None => String::new(),
        _ => js_string(v),
    };
    if s.starts_with('\n') {
        format!("\n{s}")
    } else {
        s
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
/// The `json_attr` filter as a function: the JSON of `v` escaped for a single-quoted attribute, exactly as a built
/// island's `x-props` (F546: an island artifact's host is written by the server, not by a template).
pub fn to_json_attr(v: Value) -> Result<String, Error> {
    json_attr(v)
}

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
        ctx::write_map(out, m, &[]);
        return Ok(());
    }
    if let Some(a) = v.downcast_object_ref::<ctx::CtxArr>() {
        ctx::write_arr(out, a);
        return Ok(());
    }
    if let Some(p) = v.downcast_object_ref::<ctx::MapView>() {
        ctx::write_map(out, &p.map, p.hidden);
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
            // own map usually iterates in that order already). F282: an object the compiler built in source
            // order (`obj_lit` / `obj_assign`, JS key order, unique keys) keeps it, as `JSON.stringify` writes it:
            // the order of a style's declarations decides a shorthand against its longhand.
            if v.downcast_object_ref::<spread::OrderedMap>().is_none() {
                let sorted = |m: &[(Value, Value)]| {
                    m.windows(2).all(|w| *key_str(&w[0].0) < *key_str(&w[1].0))
                };
                if !sorted(&members) {
                    members.sort_by(|a, b| key_str(&a.0).cmp(&key_str(&b.0)));
                    if !sorted(&members) {
                        return Err(Bail); // a key string repeats
                    }
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

/// JS `slice`: `Array.prototype.slice` on a list (a list comes back, so `length`, `for` and `join` keep working),
/// `String.prototype.slice` over characters on a string. Negative indices count from the end. F537: a list used to be
/// printed and its text sliced. Any other value keeps that behaviour.
fn str_slice(s: Value, start: i64, end: Option<i64>) -> Value {
    fn bounds(len: usize, start: i64, end: Option<i64>) -> Option<(usize, usize)> {
        let len = len as i64;
        let clamp = |i: i64| if i < 0 { (len + i).max(0) } else { i.min(len) };
        let (a, b) = (clamp(start), clamp(end.unwrap_or(len)));
        (a < b).then_some((a as usize, b as usize))
    }
    if matches!(s.kind(), ValueKind::Seq | ValueKind::Iterable) {
        let items: Vec<Value> = s.try_iter().map(|it| it.collect()).unwrap_or_default();
        return Value::from(match bounds(items.len(), start, end) {
            Some((a, b)) => items[a..b].to_vec(),
            None => Vec::new(),
        });
    }
    let chars: Vec<char> = paint(&s).chars().collect();
    Value::from(match bounds(chars.len(), start, end) {
        Some((a, b)) => chars[a..b].iter().collect::<String>(),
        None => String::new(),
    })
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

/// `Object.keys`. F318: an object parsed from the worker's JSON keeps the text order, which is JS's own, so server, client
/// (x-props JSON) and React iterate alike; any other map iterates as it always did (sorted).
fn keys(v: Value) -> Value {
    match v.kind() {
        ValueKind::Map => Value::from(
            map_entries(&v)
                .into_iter()
                .map(|(k, _)| k)
                .collect::<Vec<_>>(),
        ),
        ValueKind::Seq => Value::from(
            (0..v.len().unwrap_or(0))
                .map(|i| Value::from(i.to_string()))
                .collect::<Vec<_>>(),
        ),
        _ => Value::from(Vec::<Value>::new()),
    }
}

/// The `(key, value)` entries of a map value in the order JS iterates it (F318): the text order of a parsed object, else
/// the order the map yields.
pub(crate) fn map_entries(v: &Value) -> Vec<(Value, Value)> {
    if let Some(m) = v.downcast_object_ref::<ctx::CtxMap>() {
        let mut out = Vec::with_capacity(m.0.len());
        m.each_ordered(|k, n| out.push((Value::from(std::sync::Arc::clone(k)), n.to_value())));
        return out;
    }
    if let Some(p) = v.downcast_object_ref::<ctx::MapView>() {
        let mut out = Vec::new();
        p.map.each_ordered(|k, n| {
            if !p.hidden.contains(&&**k) {
                out.push((Value::from(std::sync::Arc::clone(k)), n.to_value()));
            }
        });
        return out;
    }
    v.try_iter()
        .map(|it| {
            it.map(|k| {
                let val = v.get_item(&k).unwrap_or(Value::UNDEFINED);
                (k, val)
            })
            .collect()
        })
        .unwrap_or_default()
}

/// `Object.entries`: a list of `[key, value]`.
fn entries(v: Value) -> Value {
    let pairs: Vec<Value> = match v.kind() {
        ValueKind::Map => map_entries(&v)
            .into_iter()
            .map(|(k, val)| Value::from(vec![k, val]))
            .collect(),
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

/// React style properties whose numbers are unitless (react-dom's `isUnitlessNumber`, read off its output by
/// `tests/server/live-style.chromium.test.ts`); the vendor-prefixed spellings (`WebkitLineClamp`) count too. The
/// chunk's `__css` helper (`lower/client.rs`) is generated from this list.
pub const UNITLESS: &[&str] = &[
    "animationIterationCount",
    "aspectRatio",
    "borderImageOutset",
    "borderImageSlice",
    "borderImageWidth",
    "boxFlex",
    "boxFlexGroup",
    "boxOrdinalGroup",
    "columnCount",
    "columns",
    "flex",
    "flexGrow",
    "flexPositive",
    "flexShrink",
    "flexNegative",
    "flexOrder",
    "gridArea",
    "gridRow",
    "gridRowEnd",
    "gridRowSpan",
    "gridRowStart",
    "gridColumn",
    "gridColumnEnd",
    "gridColumnSpan",
    "gridColumnStart",
    "fontWeight",
    "lineClamp",
    "lineHeight",
    "opacity",
    "order",
    "orphans",
    "scale",
    "tabSize",
    "widows",
    "zIndex",
    "zoom",
    "fillOpacity",
    "floodOpacity",
    "stopOpacity",
    "strokeDasharray",
    "strokeDashoffset",
    "strokeMiterlimit",
    "strokeOpacity",
    "strokeWidth",
];

/// `prop` is a unitless number property, under its own name or a vendor-prefixed one (`WebkitLineClamp`, `msFlex`).
fn is_unitless(prop: &str) -> bool {
    if UNITLESS.contains(&prop) {
        return true;
    }
    for prefix in ["Webkit", "Moz", "ms", "O"] {
        if let Some(rest) = prop.strip_prefix(prefix)
            && rest.starts_with(|c: char| c.is_ascii_uppercase())
        {
            let mut chars = rest.chars();
            let first = chars.next().unwrap_or_default().to_ascii_lowercase();
            return UNITLESS.contains(&format!("{first}{}", chars.as_str()).as_str());
        }
    }
    false
}

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

/// `backgroundColor` → `background-color`; `--custom` stays; `msTransform` → `-ms-transform` (react-dom's
/// `hyphenateStyleName`: the `ms` prefix is lowercase, so hyphenating alone leaves it without its leading dash).
pub fn css_property(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    push_css_property(&mut out, name);
    out
}

/// [`css_property`] written onto the end of `out`, with no String of its own.
fn push_css_property(out: &mut String, name: &str) {
    if name.starts_with("--") {
        out.push_str(name);
        return;
    }
    // `ms` followed by an uppercase letter (hyphenated to `ms-x`) or by a dash is the vendor prefix that gets a dash
    // in front; the check is on the name, so the text is written once.
    let b = name.as_bytes();
    if b.starts_with(b"ms") && matches!(b.get(2), Some(b'-' | b'A'..=b'Z')) {
        out.push('-');
    }
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
}

/// A style value as React prints it: numbers get `px` unless unitless or 0.
pub fn css_value(prop: &str, v: &Value) -> String {
    let mut out = String::new();
    push_css_value(&mut out, prop, v);
    out
}

/// `n` as [`js_number`] prints it, written onto the end of `out` (an integer below 1e15, the common case, with no
/// intermediate String).
fn push_js_number(out: &mut String, n: f64) {
    use std::fmt::Write;
    if n == 0.0 {
        out.push('0');
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        let _ = write!(out, "{}", n as i64);
    } else {
        out.push_str(&js_number(n));
    }
}

/// Whether `s` holds `needle` (given in lowercase ASCII) at any position, ignoring the ASCII case of `s`: the same
/// answer as `s.to_ascii_lowercase().contains(needle)`, with no lowercase copy.
fn contains_ci(s: &str, needle: &[u8]) -> bool {
    let h = s.as_bytes();
    h.len() >= needle.len()
        && (0..=h.len() - needle.len()).any(|k| h[k..k + needle.len()].eq_ignore_ascii_case(needle))
}

/// [`css_value`] written onto the end of `out`; nothing is written for a string that must not reach a style attribute
/// (see below) or one that is empty once trimmed.
fn push_css_value(out: &mut String, prop: &str, v: &Value) {
    if v.kind() == ValueKind::Number
        && let Some(n) = number_of(v)
    {
        push_js_number(out, n);
        if !(n == 0.0 || is_unitless(prop) || prop.starts_with("--")) {
            out.push_str("px");
        }
        return;
    }
    // A string must not end the declaration or open another construct
    // (CSS injection into the server-rendered style attribute; React
    // sets each property on its own, so nothing like it exists there).
    // react-dom prints `('' + value).trim()`
    let painted;
    let s = match (v.kind() == ValueKind::String)
        .then(|| v.as_str())
        .flatten()
    {
        Some(s) => s,
        None => {
            painted = paint(v);
            painted.as_str()
        }
    }
    .trim();
    let breaks = s
        .bytes()
        .any(|b| matches!(b, b';' | b'{' | b'}' | b'\\' | b'\n' | b'\r'))
        || contains_ci(s, b"/*")
        || contains_ci(s, b"expression(")
        || contains_ci(s, b"@import");
    if !breaks {
        out.push_str(s);
    }
}

/// The declarations of a style object, `prop:value` separated by `;`, written onto the end of `out` in one pass: a
/// property is dropped when its value is null, undefined, false, or a string that is empty or could end the
/// declaration. Returns whether any declaration was written.
fn push_style_decls<'a>(
    out: &mut String,
    pairs: impl IntoIterator<Item = (&'a str, &'a Value)>,
) -> bool {
    let first = out.len();
    for (k, v) in pairs {
        if !(present(v) && css_key(k)) {
            continue;
        }
        let mark = out.len();
        if mark > first {
            out.push(';');
        }
        push_css_property(out, k);
        out.push(':');
        let value_at = out.len();
        push_css_value(out, k, v);
        if out.len() == value_at {
            out.truncate(mark);
        }
    }
    out.len() > first
}

/// ` style="decls"` written onto the end of `out`, the declarations escaped as they are written; with `keep_empty` an
/// object with no declaration leaves ` style=""`, without it nothing is written.
fn push_style_attr<'a>(
    out: &mut String,
    pairs: impl IntoIterator<Item = (&'a str, &'a Value)>,
    keep_empty: bool,
) {
    let mark = out.len();
    out.push_str(" style=\"");
    let at = out.len();
    if !push_style_decls(out, pairs) && !keep_empty {
        out.truncate(mark);
        return;
    }
    // the declarations are written as they are; the few that hold an escapable byte are rewritten in place
    if out.as_bytes()[at..]
        .iter()
        .any(|b| matches!(b, b'&' | b'<' | b'>' | b'"' | b'\''))
    {
        let raw = out.split_off(at);
        out.push_str(&escape_text(&raw));
    }
    out.push('"');
}

/// A literal style object as CSS text (`color:red;font-size:12px`).
/// The same rule as the chunk's `__css` helper (`lower/client.rs`): a
/// property is dropped when its value is null, undefined, false, or a string
/// that is empty or could end the declaration.
pub fn style_obj_to_css(pairs: &[(String, Value)]) -> String {
    let mut out = String::new();
    push_style_decls(&mut out, pairs.iter().map(|(k, v)| (k.as_str(), v)));
    out
}

/// `key, value, key, value, …` as the compiled `css_decls` / `css_attr` calls pass them: a key that is not a string is
/// the empty key (dropped), a missing last value is undefined.
/// (A missing last value would be undefined, which is dropped, so the pair is left out.)
fn arg_pairs(args: &[Value]) -> impl Iterator<Item = (&str, &Value)> {
    args.chunks(2)
        .filter_map(|kv| Some((kv[0].as_str().unwrap_or_default(), kv.get(1)?)))
}

/// The same for an object's entries as [`map_entries`] gives them, with `keep_empty` as in [`push_style_attr`].
pub(crate) fn style_attr_of_map(v: &Value, keep_empty: bool) -> String {
    let entries = map_entries(v);
    let mut out = String::new();
    push_style_attr(
        &mut out,
        entries
            .iter()
            .filter_map(|(k, val)| Some((k.as_str()?, val))),
        keep_empty,
    );
    out
}

/// The declarations of an object's entries as [`map_entries`] gives them.
fn style_css_of_map(v: &Value) -> String {
    let entries = map_entries(v);
    let mut out = String::new();
    push_style_decls(
        &mut out,
        entries
            .iter()
            .filter_map(|(k, val)| Some((k.as_str()?, val))),
    );
    out
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

    /// F420: an option is picked by the select's value as a string, or by any element of an array; `null` and
    /// `undefined` pick none.
    #[test]
    fn selected_in_matches_as_strings_like_react_dom() {
        let t = |opt: Value, sel: Value| selected_in(&opt, &sel);
        assert!(t(Value::from("b"), Value::from("b")));
        assert!(!t(Value::from("a"), Value::from("b")));
        assert!(t(Value::from("1"), Value::from(1)));
        assert!(t(Value::from(1), Value::from("1")));
        assert!(t(Value::from("c"), Value::from(vec!["a", "c"])));
        assert!(!t(Value::from("b"), Value::from(vec!["a", "c"])));
        assert!(!t(Value::from("undefined"), Value::UNDEFINED));
        assert!(!t(Value::from("null"), Value::from(())));
    }

    /// F421: a textarea's text is `String(value)`, empty for `null` / `undefined`, and a leading newline gets a second.
    #[test]
    fn textarea_text_doubles_a_leading_newline() {
        assert_eq!(textarea_text(&Value::from("a<b")), "a<b");
        assert_eq!(textarea_text(&Value::from(3)), "3");
        assert_eq!(textarea_text(&Value::UNDEFINED), "");
        assert_eq!(textarea_text(&Value::from(())), "");
        assert_eq!(textarea_text(&Value::from("\nx")), "\n\nx");
        assert_eq!(textarea_text(&Value::from("x\n")), "x\n");
    }

    /// W1d PR 3: `render_error` fails the whole render with a fixed message, whatever it is given, and only where it is
    /// reached (an untaken branch renders).
    #[test]
    fn render_error_fails_the_render_where_it_is_reached_with_a_fixed_message() {
        let mut env = Environment::new();
        register(&mut env);
        let e = env
            .render_str(
                "a{% if t %}{{ (none | render_error) | e }}{% endif %}b",
                minijinja::context! { t => true },
            )
            .unwrap_err();
        assert!(
            e.to_string().contains("a component threw while rendering"),
            "{e}"
        );
        assert!(!e.to_string().contains("secret"), "{e}");
        let ok = env
            .render_str(
                "a{% if t %}{{ (none | render_error) | e }}{% endif %}b",
                minijinja::context! { t => false },
            )
            .unwrap();
        assert_eq!(ok, "ab");
    }

    /// F602: the style code as it was before the one-buffer rewrite (a Vec of Strings joined, a String per name and per
    /// value, a lowercase copy for the injection check), kept as the reference the new code must equal byte for byte.
    mod old {
        use super::*;

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
            if out.starts_with("ms-") {
                out.insert(0, '-');
            }
            out
        }

        pub fn css_value(prop: &str, v: &Value) -> String {
            match number_of(v) {
                Some(n) if v.kind() == ValueKind::Number => {
                    if n == 0.0 || is_unitless(prop) || prop.starts_with("--") {
                        js_number(n)
                    } else {
                        format!("{}px", js_number(n))
                    }
                }
                _ => {
                    let s = paint(v).trim().to_string();
                    let lower = s.to_ascii_lowercase();
                    let breaks = s.contains([';', '{', '}', '\\', '\n', '\r'])
                        || lower.contains("/*")
                        || lower.contains("expression(")
                        || lower.contains("@import");
                    if breaks { String::new() } else { s }
                }
            }
        }

        pub fn style_attr_text(css: &str) -> String {
            if css.is_empty() {
                String::new()
            } else {
                format!(" style=\"{}\"", escape_attr(css))
            }
        }

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
    }

    const STYLE_KEYS: &[&str] = &[
        "color",
        "fontSize",
        "backgroundColor",
        "WebkitLineClamp",
        "msTransform",
        "ms-flex",
        "msFlex",
        "MsX",
        "mozAppearance",
        "--gap",
        "--Custom-Prop",
        "--",
        "-x",
        "1a",
        "",
        "a b",
        "a;b",
        "lineHeight",
        "zIndex",
        "opacity",
        "margin",
        "width",
        "gridColumn",
        "OTransition",
        "strokeWidth",
        "flexGrow",
        "borderRadius",
        "ms",
        "ms-",
        "msA",
    ];

    fn gen_style_value(r: &mut Rng) -> Value {
        const STRS: &[&str] = &[
            "red",
            " red ",
            "  ",
            "",
            "10px",
            "calc(1px + 2px)",
            "a;b",
            "a{b",
            "a}b",
            "a\\b",
            "a\nb",
            "a\rb",
            "/* c */",
            "x/*y",
            "EXPRESSION(1)",
            "Expression (x)",
            "@IMPORT url(x)",
            "@Import",
            "url(\"x\")",
            "'Foo', serif",
            "a&b<c>",
            "é日本",
            "\t tab \t",
            "ex pression(",
            "/",
            "*",
            "@impor",
            "expressio",
        ];
        match r.below(14) {
            0 => Value::from(FLOATS[r.below(FLOATS.len() as u64) as usize]),
            1 => Value::from(r.below(2000) as i64 - 1000),
            2 => Value::from(0),
            3 => Value::from(-0.0_f64),
            4 => Value::from(f64::NAN),
            5 => Value::from(if r.below(2) == 0 {
                f64::INFINITY
            } else {
                f64::NEG_INFINITY
            }),
            6 => Value::from(()),
            7 => Value::UNDEFINED,
            8 => Value::from(false),
            9 => Value::from(true),
            10 => Value::from(1.5e300),
            11 => Value::from(STRS[r.below(STRS.len() as u64) as usize]),
            12 => Value::from_safe_string(STRS[r.below(STRS.len() as u64) as usize].to_string()),
            _ => Value::from(gen_string(r)),
        }
    }

    /// F602: `style_obj_to_css`, `css_value`, `css_property` and the attribute forms equal the code they replaced on
    /// 20,000+ generated style objects: camelCase, custom and invalid keys; numbers (0, -0, NaN, ±Infinity, floats,
    /// unitless properties), strings with every character the injection check names, mixed case, spaces, empty, null,
    /// undefined and booleans; a repeated key; an odd argument count.
    #[test]
    fn style_output_equals_the_previous_implementation_on_generated_objects() {
        let mut r = Rng(0xC0FF_EE15_BADC_0DE5);
        for case in 0..25_000 {
            let n = r.below(7) as usize;
            let pairs: Vec<(String, Value)> = (0..n)
                .map(|_| {
                    let k = if r.below(8) == 0 {
                        gen_string(&mut r)
                    } else {
                        STYLE_KEYS[r.below(STYLE_KEYS.len() as u64) as usize].to_string()
                    };
                    (k, gen_style_value(&mut r))
                })
                .collect();
            let want = old::style_obj_to_css(&pairs);
            assert_eq!(style_obj_to_css(&pairs), want, "case {case}: {pairs:?}");
            // the attribute forms: `css_attr` (omitted when empty), the map form used by `render_attr` (kept)
            let mut attr = String::new();
            push_style_attr(&mut attr, pairs.iter().map(|(k, v)| (k.as_str(), v)), false);
            assert_eq!(attr, old::style_attr_text(&want), "case {case}: {pairs:?}");
            let mut kept = String::new();
            push_style_attr(&mut kept, pairs.iter().map(|(k, v)| (k.as_str(), v)), true);
            assert_eq!(
                kept,
                format!(" style=\"{}\"", escape_text(&want)),
                "case {case}: {pairs:?}"
            );
            // the compiled call shape: flat key, value arguments (the last value may be missing)
            let mut flat: Vec<Value> = pairs
                .iter()
                .flat_map(|(k, v)| [Value::from(k.as_str()), v.clone()])
                .collect();
            if r.below(10) == 0 {
                flat.pop();
            }
            let want_flat = {
                let ps: Vec<(String, Value)> = flat
                    .chunks(2)
                    .map(|kv| {
                        (
                            kv[0].as_str().unwrap_or_default().to_string(),
                            kv.get(1).cloned().unwrap_or(Value::UNDEFINED),
                        )
                    })
                    .collect();
                old::style_obj_to_css(&ps)
            };
            let mut got = String::new();
            push_style_decls(&mut got, arg_pairs(&flat));
            assert_eq!(got, want_flat, "case {case}: {flat:?}");
            // each value and each name on its own
            for (k, v) in &pairs {
                assert_eq!(
                    css_value(k, v),
                    old::css_value(k, v),
                    "case {case}: {k} {v:?}"
                );
                assert_eq!(css_property(k), old::css_property(k), "case {case}: {k}");
            }
        }
    }

    /// F602: the vendor-prefix dash and the other `css_property` shapes, against the reference.
    #[test]
    fn css_property_equals_the_previous_implementation() {
        for k in STYLE_KEYS.iter().copied().chain([
            "msTransformOrigin",
            "ms-transform",
            "Ms",
            "MS",
            "mS",
            "m",
            "s",
            "ms1",
            "msa",
            "msAb",
            "a-ms-b",
            "É",
            "fooBarBaz",
        ]) {
            assert_eq!(css_property(k), old::css_property(k), "{k}");
        }
    }

    /// F296 C3: style declarations print as react-dom prints them (values read off react-dom 19 by
    /// `tests/server/live-style.chromium.test.ts`): unitless numbers (also vendor-prefixed), `px` otherwise, custom
    /// properties as given, the `ms` prefix with its dash, string values trimmed, booleans and nulls dropped.
    #[test]
    fn style_declarations_print_as_react_dom_does() {
        let css = |pairs: &[(&str, Value)]| {
            style_obj_to_css(
                &pairs
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect::<Vec<_>>(),
            )
        };
        let n = |x: f64| Value::from(x);
        let s = |x: &str| Value::from(x);
        assert_eq!(css(&[("aspectRatio", n(1.0))]), "aspect-ratio:1");
        assert_eq!(css(&[("WebkitLineClamp", n(3.0))]), "-webkit-line-clamp:3");
        assert_eq!(
            css(&[("MozAnimationIterationCount", n(2.0))]),
            "-moz-animation-iteration-count:2"
        );
        assert_eq!(css(&[("msFlex", n(1.0))]), "-ms-flex:1");
        assert_eq!(
            css(&[("msTransform", s("scale(2)"))]),
            "-ms-transform:scale(2)"
        );
        assert_eq!(
            css(&[("WebkitTransform", s("none"))]),
            "-webkit-transform:none"
        );
        assert_eq!(
            css(&[
                ("gridRow", n(2.0)),
                ("strokeWidth", n(3.0)),
                ("tabSize", n(4.0))
            ]),
            "grid-row:2;stroke-width:3;tab-size:4"
        );
        assert_eq!(
            css(&[
                ("width", n(0.0)),
                ("opacity", n(0.5)),
                ("marginTop", n(-3.0)),
                ("height", n(1.5))
            ]),
            "width:0;opacity:0.5;margin-top:-3px;height:1.5px"
        );
        assert_eq!(
            css(&[("--gap", n(7.0)), ("--z", n(0.0)), ("--x", s("2px"))]),
            "--gap:7;--z:0;--x:2px"
        );
        assert_eq!(css(&[("color", s(" red "))]), "color:red");
        assert_eq!(
            css(&[
                ("color", Value::from(true)),
                ("width", Value::from(false)),
                ("top", s("")),
                ("left", Value::from(()))
            ]),
            ""
        );
        assert_eq!(css(&[]), "");
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
    fn js_add_follows_javascript() {
        let ctx = || Value::from(());
        for (expr, want) in [
            ("'x' | js_add(0)", "x0"),
            ("0 | js_add('x')", "0x"),
            ("1 | js_add(2)", "3"),
            ("'a' | js_add('b')", "ab"),
            ("undefined | js_add('x')", "undefinedx"),
            ("'x' | js_add(1.5)", "x1.5"),
            ("1.5 | js_add(1.5)", "3"),
            ("0.1 | js_add(0.2)", "0.30000000000000004"),
            ("none | js_add(1)", "1"),
            ("true | js_add(1)", "2"),
            ("undefined | js_add(1)", "NaN"),
            ("[1, 2] | js_add(1)", "1,21"),
            ("{} | js_add('a')", "[object Object]a"),
        ] {
            assert_eq!(
                render(&format!("{{{{ ({expr}) | js_string }}}}"), ctx()),
                want,
                "{expr}"
            );
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

    /// F282: an object built by `obj_lit` / `obj_assign` crosses as JSON in its insertion order, as `JSON.stringify`
    /// writes it (a style's declaration order decides a shorthand against its longhand); a plain map stays sorted.
    #[test]
    fn json_attr_keeps_the_order_of_an_ordered_object() {
        let ctx = Value::from(());
        assert_eq!(
            render(
                "{{ {\"style\": obj_lit(\"marginTop\", 5, \"margin\", 0, \"color\", \"red\")} | json_attr }}",
                ctx.clone()
            ),
            "{&quot;style&quot;:{&quot;marginTop&quot;:5,&quot;margin&quot;:0,&quot;color&quot;:&quot;red&quot;}}"
        );
        // a later assignment keeps its place and takes the new value; an undefined member is left out
        assert_eq!(
            render(
                "{{ obj_assign(obj_lit(\"b\", 1, \"a\", 2), obj_lit(\"b\", 3, \"c\", undefined)) | json_attr }}",
                ctx.clone()
            ),
            "{&quot;b&quot;:3,&quot;a&quot;:2}"
        );
        // a plain jinja map is still sorted (serde_json without preserve_order)
        assert_eq!(
            render("{{ {\"b\": 1, \"a\": 2} | json_attr }}", ctx),
            "{&quot;a&quot;:2,&quot;b&quot;:1}"
        );
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
        // F537: a list slices as a list.
        let l = minijinja::context! { xs => vec!["a", "b", "c"], none => Value::from(()) };
        for (e, want) in [
            ("xs | str_slice(0, 1) | join('')", "a"),
            ("xs | str_slice(1) | join('')", "bc"),
            ("xs | str_slice(-2) | join('')", "bc"),
            ("xs | str_slice(5, 1) | join('')", ""),
            ("xs | str_slice(2, 1) | join('')", ""),
            ("xs | str_slice(1, 99) | join('')", "bc"),
            ("xs | str_slice(-99, 2) | join('')", "ab"),
            ("xs | str_slice(1) | length", "2"),
            ("xs | str_slice(3) | length", "0"),
            ("none | str_slice(0, 1)", ""),
        ] {
            assert_eq!(render(&format!("{{{{ {e} }}}}"), l.clone()), want, "{e}");
        }
        assert_eq!(
            render(
                "{% for x in xs | str_slice(0, 2) %}<{{ x }}>{% endfor %}",
                l
            ),
            "<a><b>"
        );
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
