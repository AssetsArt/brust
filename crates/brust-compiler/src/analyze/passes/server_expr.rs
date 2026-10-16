//! The template subset (spec §6.2) as one table: `try_server` accepts an
//! expression iff every node is a production of the grammar. Growing the subset
//! means adding a row here plus a golden test — never a special case elsewhere.
use crate::ir::{BinOp, IdentKind, Literal, RawExpr, RawKind, ServerExpr, UnOp};

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
            // A store read paints `__store.<name>.<key>` (M3-F D7); the bare view stays outside.
            IdentKind::Store { key: Some(_), .. } => Ok(()),
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
        RawKind::Call { callee, args } if is_throw(callee, args) => Ok(()),
        RawKind::Call { callee, args } => call(callee, args),
        RawKind::Array(items) => items.iter().try_for_each(check),
        RawKind::Object(props) => props.iter().try_for_each(|(_, v)| check(v)),
        RawKind::Arrow { .. } => Err("function"),
        RawKind::Jsx(_) => Err("jsx"),
        RawKind::Opaque { .. } => Err("opaque"),
    }
}

/// F287: `[lit, …].includes(x)` as the strict-equality chain the subset already prints: `x === lit1 || x === lit2`.
/// SameValueZero and `===` differ only for `NaN` (`[NaN].includes(NaN)` is true), so an array with a `NaN` member is not
/// rewritten (it stays a job, evaluated by JS); `-0` equals `0` under both. The needle is read once per member, which is
/// safe because every expression of the subset is pure. Arrays of more than 16 members are left alone.
pub fn includes_chain(callee: &RawExpr, args: &[RawExpr]) -> Option<RawExpr> {
    let RawKind::Member {
        target,
        name,
        optional: false,
    } = &callee.kind
    else {
        return None;
    };
    let ([needle], RawKind::Array(items)) = (args, &target.kind) else {
        return None;
    };
    if name != "includes" || items.len() > 16 {
        return None;
    }
    let plain = |m: &RawExpr| match &m.kind {
        RawKind::Lit(Literal::Num(n)) => !n.is_nan(),
        RawKind::Lit(_) => true,
        _ => false,
    };
    if !items.iter().all(plain) {
        return None;
    }
    let at = |kind| RawExpr {
        loc: callee.loc,
        kind,
    };
    let eq = |m: &RawExpr| {
        at(RawKind::Binary {
            op: BinOp::StrictEq,
            left: Box::new(needle.clone()),
            right: Box::new(m.clone()),
        })
    };
    // Folded from the right: the `||` printer repeats its left operand, so a left-leaning chain would grow with the
    // square (or worse) of its length, a right-leaning one grows linearly.
    let mut chain: Option<RawExpr> = None;
    for m in items.iter().rev() {
        chain = Some(match chain {
            None => eq(m),
            Some(r) => at(RawKind::Binary {
                op: BinOp::Or,
                left: Box::new(eq(m)),
                right: Box::new(r),
            }),
        });
    }
    Some(chain.unwrap_or_else(|| at(RawKind::Lit(Literal::Bool(false)))))
}

fn call(callee: &RawExpr, args: &[RawExpr]) -> Result<(), &'static str> {
    if let Some(chain) = includes_chain(callee, args) {
        return check(&chain);
    }
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
            // F277: an object spread (`{ ...a, k: v }`, read as `Object.assign({}, a, { k: v })`, B5) into a new object.
            ("Object", "assign", [first, rest @ ..]) if matches!(&first.kind, RawKind::Object(p) if p.is_empty()) => {
                rest.iter().try_for_each(check)
            }
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

/// W1d PR 3: the render-error arm (`ir::THROW_FN()`).
pub fn is_throw(callee: &RawExpr, args: &[RawExpr]) -> bool {
    args.is_empty()
        && matches!(&callee.kind, RawKind::Ident { name, kind: IdentKind::Global } if name == crate::ir::THROW_FN)
}
