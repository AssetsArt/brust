//! F585: a JS bigint a job slot returned (`10n`), as a template value. It prints its digits (text, attribute,
//! `String()`), is falsy only for `0n`, and follows JS in the operators the template subset prints: `+ - * / %` and unary
//! `-` with another bigint give a bigint; `+` with a string concatenates; mixing it with a number, a boolean, `null` or
//! `undefined` in arithmetic, or unary `+`, is the TypeError JS throws (the render fails, as React's render throws);
//! a zero divisor is JS's RangeError; comparisons and `==` with a number or a numeric string compare the mathematical
//! values; `===` is true only against an equal bigint. Arithmetic runs on `i128`: a result outside it fails the render
//! (JS would print it): the one known difference.
use std::cmp::Ordering;
use std::fmt;
use std::sync::Arc;

use minijinja::value::{Object, ObjectRepr, Value, ValueKind};
use minijinja::{Error, ErrorKind};

/// The digits, an optional leading `-`, no `n`.
#[derive(Debug)]
pub struct JsBigInt(pub Arc<str>);

impl Object for JsBigInt {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Plain
    }
    fn render(self: &Arc<Self>, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The bigint's digits when `v` is one.
pub fn digits(v: &Value) -> Option<Arc<str>> {
    v.downcast_object_ref::<JsBigInt>()
        .map(|b| Arc::clone(&b.0))
}

pub fn is_bigint(v: &Value) -> bool {
    v.downcast_object_ref::<JsBigInt>().is_some()
}

fn value(n: i128) -> Value {
    Value::from_object(JsBigInt(Arc::from(n.to_string())))
}

fn int(d: &str) -> Result<i128, Error> {
    d.parse::<i128>().map_err(|_| {
        Error::new(
            ErrorKind::InvalidOperation,
            "a bigint outside the range brust computes with (2^127) in a template operator",
        )
    })
}

fn type_error() -> Error {
    Error::new(
        ErrorKind::InvalidOperation,
        "TypeError: Cannot mix BigInt and other types, use explicit conversions",
    )
}

/// JS `Boolean(b)`.
pub fn truthy(d: &str) -> bool {
    d.trim_start_matches('-').bytes().any(|c| c != b'0')
}

/// `a op b` where at least one side is a bigint and neither is a string after `ToPrimitive` (the caller concatenates
/// those): both bigints give a bigint, anything else is JS's TypeError.
pub fn arith(a: &Value, b: &Value, op: char) -> Result<Value, Error> {
    let (Some(x), Some(y)) = (digits(a), digits(b)) else {
        return Err(type_error());
    };
    let (x, y) = (int(&x)?, int(&y)?);
    let over = || {
        Error::new(
            ErrorKind::InvalidOperation,
            "a bigint result outside 2^127 in a template operator",
        )
    };
    let zero = || Error::new(ErrorKind::InvalidOperation, "RangeError: Division by zero");
    let r = match op {
        '+' => x.checked_add(y).ok_or_else(over)?,
        '-' => x.checked_sub(y).ok_or_else(over)?,
        '*' => x.checked_mul(y).ok_or_else(over)?,
        // JS bigint `/` truncates toward zero and `%` takes the dividend's sign: Rust's i128 `/` and `%` do the same.
        '/' => {
            if y == 0 {
                return Err(zero());
            }
            x.checked_div(y).ok_or_else(over)?
        }
        _ => {
            if y == 0 {
                return Err(zero());
            }
            x.checked_rem(y).ok_or_else(over)?
        }
    };
    Ok(value(r))
}

/// JS unary `-b`.
pub fn neg(d: &str) -> Result<Value, Error> {
    let x = int(d)?;
    x.checked_neg()
        .map(value)
        .ok_or_else(|| Error::new(ErrorKind::InvalidOperation, "a bigint result outside 2^127"))
}

/// JS `StringToBigInt`: whitespace-trimmed decimal (or `0x` / `0o` / `0b`) digits; the empty string is `0n`; anything
/// else is not a bigint (`None`).
pub fn parse_str(s: &str) -> Option<i128> {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    if t.is_empty() {
        return Some(0);
    }
    for (p, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(p) {
            return i128::from_str_radix(rest, radix).ok();
        }
    }
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    if body.is_empty() || !body.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse().ok()
}

/// The mathematical order of the bigint `b` (digits) and the number `n`; `None` when `n` is NaN.
pub fn cmp_num(b: &str, n: f64) -> Option<Ordering> {
    if n.is_nan() {
        return None;
    }
    if n.is_infinite() {
        return Some(if n > 0.0 {
            Ordering::Less
        } else {
            Ordering::Greater
        });
    }
    let Ok(x) = b.parse::<i128>() else {
        // Outside i128: compare as a float (the number side is a float anyway).
        return b.parse::<f64>().ok()?.partial_cmp(&n);
    };
    let t = n.trunc();
    if t >= 1.7e38 {
        return Some(Ordering::Less);
    }
    if t <= -1.7e38 {
        return Some(Ordering::Greater);
    }
    match x.cmp(&(t as i128)) {
        Ordering::Equal if n > t => Some(Ordering::Less),
        Ordering::Equal if n < t => Some(Ordering::Greater),
        o => Some(o),
    }
}

/// The order of two bigints.
pub fn cmp_big(a: &str, b: &str) -> Option<Ordering> {
    match (a.parse::<i128>(), b.parse::<i128>()) {
        (Ok(x), Ok(y)) => Some(x.cmp(&y)),
        _ => a.parse::<f64>().ok()?.partial_cmp(&b.parse::<f64>().ok()?),
    }
}

/// The order of the bigint `b` and the primitive `v` (another bigint, a number, a string, a boolean, null or
/// undefined), as JS's relational operators and `==` see it; `None` = undefined (every comparison false).
pub fn cmp_with(b: &str, v: &Value) -> Option<Ordering> {
    if let Some(d) = digits(v) {
        return cmp_big(b, &d);
    }
    match v.kind() {
        ValueKind::Number => cmp_num(b, f64::try_from(v.clone()).ok()?),
        ValueKind::Bool => cmp_num(b, if v.is_true() { 1.0 } else { 0.0 }),
        ValueKind::None => cmp_num(b, 0.0),
        ValueKind::String => {
            let y = parse_str(v.as_str()?)?;
            Some(b.parse::<i128>().ok()?.cmp(&y))
        }
        _ => None,
    }
}
