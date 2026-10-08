//! Ties the readers together into a `ComponentIR`.
use crate::analyze::expr::{Reader, print_expr_js};
use crate::analyze::hooks::mark_state_bindings;
use crate::analyze::names::NameTable;
use crate::ir::RawExpr;
use crate::parse::Parsed;
use bun_ast as js_ast;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;

/// The `export default function` of the module.
pub(crate) fn default_export_fn<'x>(ast: &'x js_ast::Ast<'_>) -> Option<&'x js_ast::G::Fn> {
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SExportDefault(ed) = &stmt.data
                && let js_ast::StmtOrExpr::Stmt(inner) = &ed.value
                && let S::SFunction(sf) = &inner.data
            {
                return Some(&sf.func);
            }
        }
    }
    None
}

/// The value of the first top-level `return` in `func`.
fn first_return(func: &js_ast::G::Fn) -> Option<js_ast::Expr> {
    func.body.stmts.slice().iter().find_map(|s| match &s.data {
        S::SReturn(r) => r.value,
        _ => None,
    })
}

/// Test hook: the first `{expr}` child of the returned JSX element, read as a
/// `RawExpr` with the component's names (state marked).
#[doc(hidden)]
pub fn debug_first_slot(parsed: &Parsed) -> Option<RawExpr> {
    parsed.with_ast(|ast| {
        let func = default_export_fn(ast)?;
        let ret = first_return(func)?;
        let E::ECall(call) = &ret.data else {
            return None;
        };
        let props = call.args.get(1)?;
        let E::EObject(obj) = &props.data else {
            return None;
        };
        let children = obj
            .properties
            .iter()
            .find_map(|p| match p.key.map(|k| k.data) {
                Some(E::EString(s)) if s.slice8() == b"children" => p.value,
                _ => None,
            })?;
        let slot = match &children.data {
            E::EArray(a) => *a.items.iter().find(|x| !matches!(x.data, E::EString(_)))?,
            _ => children,
        };
        let mut names = NameTable::new(ast, func);
        mark_state_bindings(func, &mut names);
        let print = |e: &js_ast::Expr| print_expr_js(parsed, ast, e);
        let mut reader = Reader::new(&mut names, &print);
        Some(reader.expr(&slot))
    })
}
