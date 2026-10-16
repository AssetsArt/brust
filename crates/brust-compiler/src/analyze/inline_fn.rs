//! F279: module functions of ONE `return <expression>` over their parameters, among those `plain_fn` proves
//! primitive-valued. A call of one with plain-read arguments is replaced by the expression (`passes::helpers`), so the
//! server prints it where a precompute job would have run the function (Radix's `getState(checked)`).
use crate::analyze::expr::Reader;
use crate::ir::{IdentKind, InlineFn, RawExpr, RawKind};
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::stmt::Data as S;

/// The inlinable functions among `plain` (the names `plain_fn::plain_fns` proved).
pub fn inline_fns(
    ast: &js_ast::Ast<'_>,
    reader: &mut Reader<'_, '_>,
    plain: &[String],
) -> Vec<InlineFn> {
    let mut out = Vec::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let S::SFunction(f) = &stmt.data else {
                continue;
            };
            let Some(n) = &f.func.name else { continue };
            let name = reader.names.name(n.ref_);
            if !plain.contains(&name) {
                continue;
            }
            let mut params = Vec::new();
            for a in f.func.args.slice() {
                match a.binding.data {
                    B::BIdentifier(id) if a.default.is_none() => {
                        params.push(reader.names.name(id.r#ref));
                    }
                    _ => {
                        params.clear();
                        break;
                    }
                }
            }
            let [only] = f.func.body.stmts.slice() else {
                continue;
            };
            let S::SReturn(ret) = &only.data else {
                continue;
            };
            let Some(value) = &ret.value else { continue };
            if params.len() != f.func.args.len() {
                continue;
            }
            let before = reader.diagnostics.len();
            let body = reader.expr(value);
            let clean = reader.diagnostics.len() == before;
            reader.diagnostics.truncate(before);
            if clean && only_params(&body, &params, 0) {
                out.push(InlineFn { name, params, body });
            }
        }
    }
    out
}

/// Every identifier of `e` is one of `params` or a global, and `e` is an operator tree (no call, function or element:
/// the other helpers it calls are inlined one level at a time by the pass).
fn only_params(e: &RawExpr, params: &[String], depth: u8) -> bool {
    if depth > 8 {
        return false;
    }
    let go = |x: &RawExpr| only_params(x, params, depth + 1);
    match &e.kind {
        RawKind::Lit(_) => true,
        RawKind::Ident { name, kind } => params.contains(name) || matches!(kind, IdentKind::Global),
        RawKind::Unary { value, .. } => go(value),
        RawKind::Binary { left, right, .. } => go(left) && go(right),
        RawKind::Cond { test, yes, no } => go(test) && go(yes) && go(no),
        RawKind::Call { callee, args } => {
            // a call of another module function, read as a name that is not a parameter
            matches!(&callee.kind, RawKind::Ident { name, kind: IdentKind::Local } if !params.contains(name))
                && args.iter().all(go)
        }
        RawKind::Template { parts, .. } => parts.iter().all(|(p, _)| go(p)),
        RawKind::Member { .. }
        | RawKind::Index { .. }
        | RawKind::Array(_)
        | RawKind::Object(_)
        | RawKind::Arrow { .. }
        | RawKind::Jsx(_)
        | RawKind::Opaque { .. } => false,
    }
}
