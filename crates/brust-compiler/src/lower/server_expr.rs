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
    /// Loop bindings in scope, innermost last: `(item, index)`. Both are plain
    /// template variables (the template sets the index from `loop.index0`).
    pub in_loop: Option<(&'a str, Option<&'a str>)>,
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
            in_loop: None,
            props_prefix: None,
            names: &|_, _| None,
        }
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

fn raw(e: &RawExpr, ctx: &JinjaCtx<'_>) -> String {
    match &e.kind {
        RawKind::Lit(l) => match l {
            Literal::Str(s) => jinja_string(s),
            Literal::Num(n) => brust_jinja::js_number(*n),
            Literal::Bool(b) => b.to_string(),
            Literal::Null => "none".into(),
            Literal::Undefined => UNDEFINED.into(),
        },
        RawKind::Ident { name, kind } => {
            if let Some(n) = (ctx.names)(name, kind) {
                return n;
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
            UnOp::Neg => format!("(-{})", raw(value, ctx)),
            UnOp::Pos => format!("({} | float)", raw(value, ctx)),
            UnOp::Typeof => "none".into(),
        },
        RawKind::Binary { op, left, right } => {
            let (l, r) = (raw(left, ctx), raw(right, ctx));
            match op {
                BinOp::Add if is_stringy(left) || is_stringy(right) => {
                    format!("({} ~ {})", concat_part(left, ctx), concat_part(right, ctx))
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
        RawKind::Object(props) if ORDERED_OBJECTS.get() => format!(
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
