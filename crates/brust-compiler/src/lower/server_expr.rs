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
                return format!("({t} | length)");
            }
            let access = format!("{t}[{}]", jinja_string(name));
            if *optional {
                format!("({access} if {t} is defined and {t} is not none else {UNDEFINED})")
            } else {
                access
            }
        }
        RawKind::Index { target, index } => format!("{}[{}]", raw(target, ctx), raw(index, ctx)),
        RawKind::Unary { op, value } => match op {
            UnOp::Not => format!("(not {})", raw(value, ctx)),
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
                _ => {
                    let o = match op {
                        BinOp::Add => "+",
                        BinOp::Sub => "-",
                        BinOp::Mul => "*",
                        BinOp::Div => "/",
                        BinOp::Rem => "%",
                        BinOp::Eq | BinOp::StrictEq => "==",
                        BinOp::Ne | BinOp::StrictNe => "!=",
                        BinOp::Lt => "<",
                        BinOp::Le => "<=",
                        BinOp::Gt => ">",
                        BinOp::Ge => ">=",
                        BinOp::And => "and",
                        BinOp::Or => "or",
                        BinOp::Nullish => unreachable!(),
                    };
                    format!("({l} {o} {r})")
                }
            }
        }
        RawKind::Cond { test, yes, no } => format!(
            "({} if {} else {})",
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
