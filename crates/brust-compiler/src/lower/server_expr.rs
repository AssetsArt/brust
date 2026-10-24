//! The server half of the dual printer (spec §5.1, §6.2): a `ServerExpr` as a
//! minijinja expression. Its JS half is [`crate::ir::RawExpr::to_js_in`]; the
//! table test in `tests/dual_printer.rs` asserts both on the same rows.
//!
//! Every compound sub-expression is parenthesised, so jinja precedence never
//! matters. Filters are the `brust-jinja` set.
pub use crate::ir::JsCtx;
use crate::ir::{BinOp, IdentKind, Literal, RawExpr, RawKind, ServerExpr, UnOp};

/// How identifiers print in the template.
pub struct JinjaCtx<'a> {
    /// The index bindings of the loops in scope (`(todo, i) => …`): each is a plain template variable the template sets
    /// from `loop.index0`, and always a number (F427).
    pub loop_indexes: &'a [&'a str],
    /// Prefix for prop reads (`props.` style contexts); `None`: props are
    /// top-level template variables.
    pub props_prefix: Option<&'a str>,
    /// Overrides an identifier's printed name (seed renames, derived `_dN`,
    /// an inlined child's props bound to the parent's expressions). `None`
    /// keeps the default.
    pub names: &'a dyn Fn(&str, &IdentKind) -> Option<String>,
}

impl JinjaCtx<'_> {
    pub fn plain() -> JinjaCtx<'static> {
        JinjaCtx {
            loop_indexes: &[],
            props_prefix: None,
            names: &|_, _| None,
        }
    }
}

/// A JS number as a template expression: a finite one as its literal, `NaN` and `±Infinity` (no template literal names
/// them) as the `js_div` filter computes them, so they print as JS prints them and test as JS does.
fn jinja_number(n: f64) -> String {
    if n.is_nan() {
        "(0 | js_div(0))".into()
    } else if n.is_infinite() {
        format!("({} | js_div(0))", if n > 0.0 { 1 } else { -1 })
    } else {
        brust_jinja::js_number(n)
    }
}

pub fn to_jinja(e: &ServerExpr, ctx: &JinjaCtx<'_>) -> String {
    raw(&e.0, ctx)
}

/// A template variable that is never bound: it evaluates to undefined, which
/// jinja has no literal for (JS `undefined` and `null` differ under `String()`).
pub const UNDEFINED: &str = "__undefined";

/// A string literal in jinja syntax.
/// `t.name` for a plain identifier key, `t["name"]` otherwise. Jinja words stay
/// bracketed so the lowered text never depends on how a name lexes after a dot.
pub(crate) fn member_access(t: &str, name: &str) -> String {
    const WORDS: &[&str] = &[
        "true", "false", "none", "True", "False", "None", "and", "or", "not", "in", "is", "if",
        "else",
    ];
    let mut cs = name.chars();
    let ident = cs
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ident && !WORDS.contains(&name) {
        format!("{t}.{name}")
    } else {
        format!("{t}[{}]", jinja_string(name))
    }
}

pub fn jinja_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn is_stringy(e: &RawExpr) -> bool {
    matches!(
        e.kind,
        RawKind::Lit(Literal::Str(_)) | RawKind::Template { .. }
    )
}

/// An expression that is a number whatever its inputs: a numeric literal, the result of an arithmetic operator, a
/// `.length` (printed through the `length` filter), or the index of the loop being printed (F427).
fn is_number(e: &RawExpr, ctx: &JinjaCtx<'_>) -> bool {
    match &e.kind {
        RawKind::Lit(Literal::Num(_)) => true,
        RawKind::Unary {
            op: UnOp::Neg | UnOp::Pos,
            ..
        } => true,
        RawKind::Binary {
            op: BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Rem,
            ..
        } => true,
        RawKind::Binary {
            op: BinOp::Add,
            left,
            right,
        } => is_number(left, ctx) && is_number(right, ctx),
        RawKind::Member {
            name,
            optional: false,
            ..
        } => name == "length",
        RawKind::Ident {
            name,
            kind: IdentKind::LoopBinding,
        } => ctx.loop_indexes.contains(&name.as_str()),
        _ => false,
    }
}

/// An operand of `~`: literals as they are, anything else through JS `String()`.
fn concat_part(e: &RawExpr, ctx: &JinjaCtx<'_>) -> String {
    if is_stringy(e) {
        raw(e, ctx)
    } else {
        format!("({} | js_string)", raw(e, ctx))
    }
}

thread_local! {
    /// Set while a `style` value is printed: object literals in it print as `obj_lit` (source order).
    static ORDERED_OBJECTS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Runs `f` with object literals printing in source order (`obj_lit`), for a `style` value.
pub fn with_ordered_objects<T>(f: impl FnOnce() -> T) -> T {
    let before = ORDERED_OBJECTS.replace(true);
    let out = f();
    ORDERED_OBJECTS.set(before);
    out
}

/// F333: whether the keys of an object literal, enumerated as JS does, come out in the byte order a jinja map literal
/// sorts them to (so the plain literal prints the same order).
fn js_order_is_sorted(props: &[(String, RawExpr)]) -> bool {
    let is_index = brust_jinja::spread::is_array_index;
    let mut keys: Vec<&str> = props.iter().map(|(k, _)| k.as_str()).collect();
    let (mut idx, rest): (Vec<&str>, Vec<&str>) = keys.drain(..).partition(|k| is_index(k));
    idx.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
    idx.extend(rest);
    idx.windows(2).all(|w| w[0] <= w[1])
}

fn raw(e: &RawExpr, ctx: &JinjaCtx<'_>) -> String {
    match &e.kind {
        RawKind::Lit(l) => match l {
            Literal::Str(s) => jinja_string(s),
            Literal::Num(n) => jinja_number(*n),
            Literal::Bool(b) => b.to_string(),
            Literal::Null => "none".into(),
            Literal::Undefined => UNDEFINED.into(),
        },
        RawKind::Ident { name, kind } => {
            if let Some(n) = (ctx.names)(name, kind) {
                return n;
            }
            // F388: the globals `NaN` and `Infinity` are numbers; as template names they would be undefined (`NaN`
            // printed nothing where React prints "NaN").
            if matches!(kind, IdentKind::Global) {
                match name.as_str() {
                    "NaN" => return jinja_number(f64::NAN),
                    "Infinity" => return jinja_number(f64::INFINITY),
                    _ => {}
                }
            }
            match (kind, ctx.props_prefix) {
                (IdentKind::Prop, Some(p)) if name != "*" => format!("{p}{name}"),
                (IdentKind::Prop, Some(p)) => p.trim_end_matches('.').to_string(),
                _ => name.clone(),
            }
        }
        RawKind::Member {
            target,
            name,
            optional,
        } => {
            let t = raw(target, ctx);
            if name == "length" {
                return if *optional {
                    format!(
                        "(({t} | length) if {t} is defined and {t} is not none else {UNDEFINED})"
                    )
                } else {
                    format!("({t} | length)")
                };
            }
            let access = member_access(&t, name);
            if *optional {
                format!("({access} if {t} is defined and {t} is not none else {UNDEFINED})")
            } else {
                access
            }
        }
        RawKind::Index { target, index } => format!("{}[{}]", raw(target, ctx), raw(index, ctx)),
        RawKind::Unary { op, value } => match op {
            // JS truthiness (an empty list or object is true): brust-jinja's `truthy`.
            UnOp::Not => format!("(not ({} | truthy))", raw(value, ctx)),
            UnOp::Neg if is_number(value, ctx) => format!("(-{})", raw(value, ctx)),
            UnOp::Neg => format!("({} | js_neg)", raw(value, ctx)),
            UnOp::Pos => format!("({} | js_num)", raw(value, ctx)),
            UnOp::Typeof => "none".into(),
        },
        RawKind::Binary { op, left, right } => {
            let (l, r) = (raw(left, ctx), raw(right, ctx));
            match op {
                BinOp::Add if is_stringy(left) || is_stringy(right) => {
                    format!("({} ~ {})", concat_part(left, ctx), concat_part(right, ctx))
                }
                // F424: jinja's `+` errors on string + number (and on `none`); JS concatenates when either side is a string.
                // Only two operands proven numbers keep the native `+`.
                BinOp::Add if !(is_number(left, ctx) && is_number(right, ctx)) => {
                    format!("({l} | js_add({r}))")
                }
                // F428: jinja's `-` and `*` error on a string / `none` operand where JS coerces with `ToNumber`.
                BinOp::Sub | BinOp::Mul if !(is_number(left, ctx) && is_number(right, ctx)) => {
                    let f = if matches!(op, BinOp::Sub) {
                        "js_sub"
                    } else {
                        "js_mul"
                    };
                    format!("({l} | {f}({r}))")
                }
                // Relational operators: only two numbers or two strings compare as jinja does.
                BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge
                    if !((is_number(left, ctx) && is_number(right, ctx))
                        || (is_stringy(left) && is_stringy(right))) =>
                {
                    let o = match op {
                        BinOp::Lt => "<",
                        BinOp::Le => "<=",
                        BinOp::Gt => ">",
                        _ => ">=",
                    };
                    format!("({l} | js_cmp({r}, '{o}'))")
                }
                // Equality: `===` against a string literal is jinja's `==` (a string equals only a string); two numbers or
                // two strings too. Anything else follows JS (`1 == '1'`, `true === 1`, `null`/`undefined`).
                BinOp::Eq | BinOp::StrictEq | BinOp::Ne | BinOp::StrictNe
                    if !((is_number(left, ctx) && is_number(right, ctx))
                        || (is_stringy(left) && is_stringy(right))
                        || (matches!(op, BinOp::StrictEq | BinOp::StrictNe)
                            && (is_stringy(left) || is_stringy(right)))) =>
                {
                    let f = if matches!(op, BinOp::Eq | BinOp::Ne) {
                        "js_eq"
                    } else {
                        "js_seq"
                    };
                    if matches!(op, BinOp::Eq | BinOp::StrictEq) {
                        format!("({l} | {f}({r}))")
                    } else {
                        format!("(not ({l} | {f}({r})))")
                    }
                }
                BinOp::Nullish => {
                    format!("({l} if {l} is defined and {l} is not none else {r})")
                }
                // `&&` / `||` return an operand, chosen by JS truthiness.
                BinOp::And => format!("({r} if ({l} | truthy) else {l})"),
                BinOp::Or => format!("({l} if ({l} | truthy) else {r})"),
                // minijinja 3 floors `%` and errors on a zero divisor; JS does neither.
                BinOp::Div => format!("({l} | js_div({r}))"),
                BinOp::Rem => format!("({l} | js_mod({r}))"),
                _ => {
                    let o = match op {
                        BinOp::Add => "+",
                        BinOp::Sub => "-",
                        BinOp::Mul => "*",
                        BinOp::Eq | BinOp::StrictEq => "==",
                        BinOp::Ne | BinOp::StrictNe => "!=",
                        BinOp::Lt => "<",
                        BinOp::Le => "<=",
                        BinOp::Gt => ">",
                        BinOp::Ge => ">=",
                        BinOp::Div | BinOp::Rem | BinOp::And | BinOp::Or | BinOp::Nullish => {
                            unreachable!()
                        }
                    };
                    format!("({l} {o} {r})")
                }
            }
        }
        RawKind::Cond { test, yes, no } => format!(
            "({} if ({} | truthy) else {})",
            raw(yes, ctx),
            raw(test, ctx),
            raw(no, ctx)
        ),
        RawKind::Template { head, parts } => {
            let mut items = vec![jinja_string(head)];
            for (p, tail) in parts {
                items.push(concat_part(p, ctx));
                items.push(jinja_string(tail));
            }
            format!("({})", items.join(" ~ "))
        }
        RawKind::Call { callee, args } => call(callee, args, ctx),
        RawKind::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|i| raw(i, ctx))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        // F296 C3: an object printed for a `style` value keeps its source order (`obj_lit`): a jinja map literal sorts
        // its keys, and a style's declaration order decides a shorthand against its longhand.
        // F333: so does any object whose keys, in JS order (array-index keys first, ascending), are not already in the
        // sorted order a jinja map literal gives them: `Object.entries` / `Object.keys` of it observe the difference.
        RawKind::Object(props) if ORDERED_OBJECTS.get() || !js_order_is_sorted(props) => format!(
            "obj_lit({})",
            props
                .iter()
                .map(|(k, v)| format!("{}, {}", jinja_string(k), raw(v, ctx)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        RawKind::Object(props) => format!(
            "{{{}}}",
            props
                .iter()
                .map(|(k, v)| format!("{}: {}", jinja_string(k), raw(v, ctx)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        // Not in the subset: placement never makes these `Server`.
        RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => "none".into(),
    }
}

fn call(callee: &RawExpr, args: &[RawExpr], ctx: &JinjaCtx<'_>) -> String {
    // F287: `[lit, …].includes(x)` is printed as the strict-equality chain `check` accepted.
    if let Some(chain) = crate::analyze::passes::server_expr::includes_chain(callee, args) {
        return raw(&chain, ctx);
    }
    // W1d PR 3: a render error (a component threw): the filter fails the render, the server answers with its own 500
    if crate::analyze::passes::server_expr::is_throw(callee, args) {
        return "(none | render_error)".into();
    }
    let RawKind::Member { target, name, .. } = &callee.kind else {
        return "none".into();
    };
    let a: Vec<String> = args.iter().map(|x| raw(x, ctx)).collect();
    if let RawKind::Ident {
        name: obj,
        kind: IdentKind::Global,
    } = &target.kind
    {
        return match (obj.as_str(), name.as_str()) {
            ("Object", "keys") => format!("({} | keys)", a[0]),
            ("Object", "entries") => format!("({} | entries)", a[0]),
            // F277: `Object.assign({}, …)` (the subset admits only a fresh target): the sources merged as JS does, in
            // order. An object literal source is `obj_lit` (a jinja map literal would sort its keys, and a style's
            // declaration order decides a shorthand against its longhand).
            ("Object", "assign") => format!(
                "obj_assign({})",
                args[1..]
                    .iter()
                    .map(|x| match &x.kind {
                        RawKind::Object(props) => format!(
                            "obj_lit({})",
                            props
                                .iter()
                                .map(|(k, v)| format!("{}, {}", jinja_string(k), raw(v, ctx)))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                        _ => raw(x, ctx),
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            ("Array", "from") => match &args[0].kind {
                RawKind::Object(p) => format!("range({})", raw(&p[0].1, ctx)),
                _ => "[]".into(),
            },
            _ => "none".into(),
        };
    }
    let t = raw(target, ctx);
    match name.as_str() {
        "toUpperCase" => format!("({t} | upper)"),
        "toLowerCase" => format!("({t} | lower)"),
        "trim" => format!("({t} | trim)"),
        "slice" => format!("({t} | str_slice({}))", a.join(", ")),
        "startsWith" => format!("({t} | starts_with({}))", a.join(", ")),
        "endsWith" => format!("({t} | ends_with({}))", a.join(", ")),
        "includes" => format!("({t} | includes({}))", a.join(", ")),
        "join" => format!("({t} | join({}))", a.join(", ")),
        _ => "none".into(),
    }
}

#[cfg(test)]
mod member_access_tests {
    use super::member_access;

    #[test]
    fn identifier_keys_use_attribute_access() {
        assert_eq!(member_access("p", "name"), "p.name");
        assert_eq!(member_access("p", "_a1"), "p._a1");
        assert_eq!(member_access("p", "items"), "p.items");
    }

    #[test]
    fn other_keys_stay_bracketed() {
        for k in [
            "data-x", "a b", "1a", "", "é", "a.b", "none", "true", "not", "is", "in",
        ] {
            assert_eq!(
                member_access("p", k),
                format!("p[{}]", super::jinja_string(k)),
                "{k}"
            );
        }
    }
}
