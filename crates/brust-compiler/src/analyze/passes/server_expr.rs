//! The template subset (spec §6.2) as one table: `try_server` accepts an
//! expression iff every node is a production of the grammar. Growing the subset
//! means adding a row here plus a golden test — never a special case elsewhere.
use crate::ir::{IdentKind, Literal, RawExpr, RawKind, ServerExpr, UnOp};

/// String / array methods callable on a subset value, with literal arguments.
const METHODS: &[&str] = &[
    "toUpperCase",
    "toLowerCase",
    "trim",
    "slice",
    "startsWith",
    "endsWith",
    "includes",
    "join",
];

/// Upper bound of `Array.from({ length: N })` (0.1.x rule).
pub const MAX_RANGE: f64 = 1024.0;

pub fn try_server(e: &RawExpr) -> Result<ServerExpr, &'static str> {
    check(e)?;
    Ok(ServerExpr(e.clone()))
}

fn check(e: &RawExpr) -> Result<(), &'static str> {
    match &e.kind {
        RawKind::Lit(_) => Ok(()),
        RawKind::Ident { kind, .. } => match kind {
            // A Local is accepted here; the placement pass requires that it is
            // itself placed (a template variable).
            IdentKind::Prop | IdentKind::Local | IdentKind::State | IdentKind::LoopBinding => {
                Ok(())
            }
            _ => Err("identifier kind"),
        },
        RawKind::Member { target, .. } => check(target),
        RawKind::Index { target, index } => match index.kind {
            RawKind::Lit(_) => check(target),
            _ => Err("computed index"),
        },
        RawKind::Unary { op, value } => match op {
            UnOp::Not | UnOp::Neg => check(value),
            _ => Err("operator"),
        },
        RawKind::Binary { left, right, .. } => {
            check(left)?;
            check(right)
        }
        RawKind::Cond { test, yes, no } => {
            check(test)?;
            check(yes)?;
            check(no)
        }
        RawKind::Template { parts, .. } => parts.iter().try_for_each(|(p, _)| check(p)),
        RawKind::Call { callee, args } => call(callee, args),
        RawKind::Array(items) => items.iter().try_for_each(check),
        RawKind::Object(props) => props.iter().try_for_each(|(_, v)| check(v)),
        RawKind::Arrow { .. } => Err("function"),
        RawKind::Jsx(_) => Err("jsx"),
        RawKind::Opaque { .. } => Err("opaque"),
    }
}

fn call(callee: &RawExpr, args: &[RawExpr]) -> Result<(), &'static str> {
    let RawKind::Member { target, name, .. } = &callee.kind else {
        return Err("call");
    };
    if name == "map" {
        return Err("map outside list");
    }
    if let RawKind::Ident {
        name: obj,
        kind: IdentKind::Global,
    } = &target.kind
    {
        return match (obj.as_str(), name.as_str(), args) {
            ("Object", "keys" | "entries", [arg]) => check(arg),
            ("Array", "from", [len]) if is_range(len) => Ok(()),
            _ => Err("call"),
        };
    }
    if !METHODS.contains(&name.as_str()) {
        return Err("call");
    }
    if name == "join"
        && !matches!(
            args,
            [RawExpr {
                kind: RawKind::Lit(Literal::Str(_)),
                ..
            }]
        )
    {
        return Err("join needs a string literal");
    }
    if !args.iter().all(literal_only) {
        return Err("method arguments must be literals");
    }
    check(target)
}

/// `{ length: N }` with a literal `N ≤ 1024`.
fn is_range(arg: &RawExpr) -> bool {
    matches!(&arg.kind, RawKind::Object(props) if matches!(props.as_slice(),
        [(k, RawExpr { kind: RawKind::Lit(Literal::Num(n)), .. })]
            if k == "length" && *n >= 0.0 && *n <= MAX_RANGE && n.fract() == 0.0))
}

/// A literal, or an array / object of literals (`includes(['a', 'b'])`).
fn literal_only(e: &RawExpr) -> bool {
    match &e.kind {
        RawKind::Lit(_) => true,
        RawKind::Array(items) => items.iter().all(literal_only),
        RawKind::Object(props) => props.iter().all(|(_, v)| literal_only(v)),
        _ => false,
    }
}
