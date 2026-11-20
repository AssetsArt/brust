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
        RawKind::Member { .. } | RawKind::Index { .. } => member_path(e, ctx),
        RawKind::Unary { op, value } => match op {
            // JS truthiness (an empty list or object is true): brust-jinja's `truthy`.
            UnOp::Not => format!("(not {})", test(value, ctx)),
            UnOp::Neg if is_number(value, ctx) => format!("(-{})", raw(value, ctx)),
            UnOp::Neg => format!("({} | js_neg)", raw(value, ctx)),
            UnOp::Pos => format!("({} | js_num)", raw(value, ctx)),
            UnOp::Typeof => "none".into(),
        },
        RawKind::Binary {
            op: op @ (BinOp::And | BinOp::Or | BinOp::Nullish),
            ..
        } => logical_value(e, *op, ctx),
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
                BinOp::Nullish | BinOp::And | BinOp::Or => unreachable!(),
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
        RawKind::Cond {
            test: t, yes, no, ..
        } => format!(
            "({} if {} else {})",
            raw(yes, ctx),
            test(t, ctx),
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

/// F555: the operands of a chain of one logical operator, in source order. `&&`, `||` and `??` are each associative in
/// value, evaluation order and short-circuit, so `(a && b) && c` and `a && (b && c)` are the same chain.
fn chain<'a>(e: &'a RawExpr, op: BinOp, out: &mut Vec<&'a RawExpr>) {
    match &e.kind {
        RawKind::Binary { op: o, left, right } if *o == op => {
            chain(left, op, out);
            chain(right, op, out);
        }
        _ => out.push(e),
    }
}

/// F555: a `&&` / `||` / `??` chain as a value, nested to the right: `a && b && c` prints as `a && (b && c)`. Each
/// operand that may be returned is printed in its test and in its value, never inside another operand's copies, so the
/// text is linear in the chain (JS chains nest to the left: printing that left side twice per operator was 2^n, 3^n
/// for `??`).
fn logical_value(e: &RawExpr, op: BinOp, ctx: &JinjaCtx<'_>) -> String {
    let mut ops = Vec::new();
    chain(e, op, &mut ops);
    let (last, rest) = ops.split_last().expect("a chain has operands");
    let mut acc = raw(last, ctx);
    for o in rest.iter().rev() {
        acc = match op {
            // `&&` / `||` return an operand, chosen by JS truthiness.
            // `&&` / `||` return an operand, chosen by JS truthiness. The operand is printed as its test and then only as
            // the value it has once that test is known (F555 ruling 3): a falsy `||` chain is its last operand, a truthy
            // `&&` chain is its last operand.
            BinOp::And => format!("({acc} if {} else {})", test(o, ctx), known(o, false, ctx)),
            BinOp::Or => format!("({} if {} else {acc})", known(o, true, ctx), test(o, ctx)),
            _ => {
                let v = raw(o, ctx);
                format!("({v} if {v} is defined and {v} is not none else {acc})")
            }
        };
    }
    acc
}

/// F555 ruling 3: the value of `e` where its truthiness is already known (`truthy`). An `||` chain known falsy returned
/// its last operand (every operand was falsy); an `&&` chain known truthy returned its last operand (every operand was
/// truthy); that operand is itself known the same way. Anything else prints its whole value.
fn known(e: &RawExpr, truthy: bool, ctx: &JinjaCtx<'_>) -> String {
    let op = if truthy { BinOp::And } else { BinOp::Or };
    match &e.kind {
        RawKind::Binary { op: o, .. } if *o == op => {
            let mut ops = Vec::new();
            chain(e, op, &mut ops);
            known(ops.last().expect("a chain has operands"), truthy, ctx)
        }
        _ => raw(e, ctx),
    }
}

/// F557: a member / index path. An optional link (`a?.b`) makes the whole path undefined when its target is `undefined`
/// or `null` (JS short-circuits the rest of the chain), so the path prints once, plainly, under one guard: every
/// optional link's target present, tested left to right by jinja's short-circuit `and`. Printing each optional link as
/// `(t.b if t present else undefined)` repeated its target three times: `a?.b?.c?.d` was 3^depth copies.
fn member_path(e: &RawExpr, ctx: &JinjaCtx<'_>) -> String {
    let mut guards = Vec::new();
    let plain = plain_path(e, ctx, &mut guards);
    if guards.is_empty() {
        plain
    } else {
        format!("({plain} if {} else {UNDEFINED})", guards.join(" and "))
    }
}

fn plain_path(e: &RawExpr, ctx: &JinjaCtx<'_>, guards: &mut Vec<String>) -> String {
    match &e.kind {
        RawKind::Member {
            target,
            name,
            optional,
        } => {
            let t = plain_path(target, ctx, guards);
            if *optional {
                guards.push(format!("{t} is defined and {t} is not none"));
            }
            if name == "length" {
                format!("({t} | length)")
            } else {
                member_access(&t, name)
            }
        }
        RawKind::Index { target, index } => {
            format!("{}[{}]", plain_path(target, ctx, guards), raw(index, ctx))
        }
        _ => raw(e, ctx),
    }
}

/// F555: `e` tested for JS truthiness, as a jinja expression that is `true` or `false`. `&&`, `||` and `!` print as
/// jinja's own short-circuit `and` / `or` / `not` over `(x | truthy)` operands: each operand is printed once, whatever
/// the nesting or the mix, where the value form repeats the operands it may return.
fn test(e: &RawExpr, ctx: &JinjaCtx<'_>) -> String {
    match &e.kind {
        RawKind::Binary {
            op: op @ (BinOp::And | BinOp::Or),
            ..
        } => {
            let mut ops = Vec::new();
            chain(e, *op, &mut ops);
            let word = if matches!(op, BinOp::And) {
                " and "
            } else {
                " or "
            };
            format!(
                "({})",
                ops.iter()
                    .map(|o| test(o, ctx))
                    .collect::<Vec<_>>()
                    .join(word)
            )
        }
        RawKind::Unary {
            op: UnOp::Not,
            value,
        } => format!("(not {})", test(value, ctx)),
        _ => format!("({} | truthy)", raw(e, ctx)),
    }
}

/// F555: `e` as an `{% if %}` test, when it is a `&&` / `||` / `!` expression whose boolean form ([`test`]) is shorter
/// than its value under `| truthy`; `None` otherwise (the caller prints `(value) | truthy`, as before).
pub fn to_jinja_test(e: &ServerExpr, ctx: &JinjaCtx<'_>) -> Option<String> {
    match &e.0.kind {
        RawKind::Binary {
            op: BinOp::And | BinOp::Or,
            ..
        }
        | RawKind::Unary { op: UnOp::Not, .. } => Some(test(&e.0, ctx)),
        _ => None,
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
