//! Ties the readers together into a `ComponentIR`.
use crate::analyze::expr::{Js, Reader, print_js};
use crate::analyze::hooks::{mark_state_bindings, read_body};
use crate::analyze::names::NameTable;
use crate::ir::{
    Attr, BinOp, ComponentIR, Diagnostic, Expr, Literal, Node, RawExpr, RawKind, component_id,
    line_col,
};
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

/// Reads the module's default-export component into a structural `ComponentIR`
/// (spec §5): declarations from the body, the template from the returned JSX,
/// every value as `Expr::Raw`, `tier: Pending`. Placement, jobs and the tier
/// decision are M1b-2. Call it inside [`crate::parse::run_on_compiler_thread`].
///
/// `Err` only when the module has no default export at all; every other problem
/// is a diagnostic on the returned IR.
pub fn analyze_component(parsed: &Parsed) -> Result<ComponentIR, Diagnostic> {
    let path = parsed.path();
    let mut ir = ComponentIR::new(component_id(&path), path);
    parsed.with_ast(|ast| {
        let Some(func) = default_export_fn(ast) else {
            if has_default_export(ast) {
                ir.diagnostics.push(Diagnostic::fallback(
                    "default-export-shape",
                    "the default export is not a function declaration",
                    0,
                    "write `export default function Name(props) { … }`",
                ));
                return Ok(());
            }
            return Err(Diagnostic::error(
                "no-default-export",
                "no default export in this module",
                0,
                "export the component with `export default function`",
            ));
        };
        let mut names = NameTable::new(ast, func);
        mark_state_bindings(func, &mut names);
        let print = |js: Js<'_>| print_js(parsed, ast, js);
        let mut reader = Reader::new(&mut names, &print);
        let body = read_body(func, &mut reader);
        ir.props = body.props;
        ir.state = body.state;
        ir.derived = body.derived;
        ir.effects = body.effects;
        ir.handlers = body.handlers;
        ir.refs = body.refs;
        ir.id_bindings = body.id_bindings;
        ir.diagnostics = body.diagnostics;
        let root_loc = match &body.return_expr {
            Some(Expr::Raw(r)) => r.loc,
            _ => 0,
        };
        let root = body
            .return_expr
            .map(root_node)
            .unwrap_or(Node::Fragment(vec![]));
        ir.template = host_root(root, root_loc, &mut ir.diagnostics);
        Ok(())
    })?;
    let text = parsed.text();
    for d in &mut ir.diagnostics {
        (d.line, d.col) = line_col(text, d.loc);
    }
    Ok(ir)
}

fn has_default_export(ast: &js_ast::Ast<'_>) -> bool {
    ast.parts.iter().any(|part| {
        part.stmts
            .slice()
            .iter()
            .any(|s| matches!(s.data, S::SExportDefault(_)))
    })
}

/// The template root from the returned value.
fn root_node(e: Expr) -> Node {
    let Expr::Raw(raw) = e else {
        return Node::Slot(e);
    };
    let mut nodes = arm(raw);
    if nodes.len() == 1 {
        nodes.remove(0)
    } else {
        Node::Fragment(nodes)
    }
}

/// One returned / conditional arm as template nodes.
fn arm(raw: RawExpr) -> Vec<Node> {
    match raw.kind {
        RawKind::Jsx(node) => vec![*node],
        RawKind::Lit(Literal::Null | Literal::Undefined | Literal::Bool(_)) => vec![],
        RawKind::Lit(Literal::Str(s)) => vec![Node::Text(s)],
        RawKind::Cond { test, yes, no }
            if matches!(yes.kind, RawKind::Jsx(_)) || matches!(no.kind, RawKind::Jsx(_)) =>
        {
            vec![Node::If {
                cond: Expr::Raw(*test),
                then: arm(*yes),
                else_: arm(*no),
            }]
        }
        RawKind::Binary {
            op: BinOp::And,
            left,
            right,
        } if matches!(right.kind, RawKind::Jsx(_)) => vec![Node::If {
            cond: Expr::Raw(*left),
            then: arm(*right),
            else_: vec![],
        }],
        kind => vec![Node::Slot(Expr::Raw(RawExpr { loc: raw.loc, kind }))],
    }
}

/// Spec §5.2: a single returned element is the mount host; anything else is
/// wrapped in `<brust-host style="display:contents">` with a warning.
fn host_root(node: Node, loc: u32, diagnostics: &mut Vec<Diagnostic>) -> Node {
    if let Node::Element { .. } = node {
        return mark_host(node);
    }
    let children = match node {
        Node::Fragment(children) => children,
        other => vec![other],
    };
    diagnostics.push(Diagnostic::warning(
        "fragment-root",
        "the component does not return a single element; it is wrapped in <brust-host>",
        loc,
        "return one element",
    ));
    Node::Element {
        loc,
        tag: "brust-host".into(),
        attrs: vec![Attr::Static {
            name: "style".into(),
            value: "display:contents".into(),
        }],
        children,
        host: true,
        ref_name: None,
    }
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
        let print = |js: Js<'_>| print_js(parsed, ast, js);
        let mut reader = Reader::new(&mut names, &print);
        Some(reader.expr(&slot))
    })
}

/// Test hook: the template of the returned JSX with the root host rule applied
/// (no fragment wrapping), plus the reader's diagnostics.
#[doc(hidden)]
pub fn debug_template(parsed: &Parsed) -> (Node, Vec<Diagnostic>) {
    parsed.with_ast(|ast| {
        let Some(func) = default_export_fn(ast) else {
            return (Node::Fragment(vec![]), vec![]);
        };
        let mut names = NameTable::new(ast, func);
        mark_state_bindings(func, &mut names);
        let print = |js: Js<'_>| print_js(parsed, ast, js);
        let mut reader = Reader::new(&mut names, &print);
        let node = match first_return(func) {
            Some(ret) => crate::analyze::jsx::read_jsx(&mut reader, &ret),
            None => Node::Fragment(vec![]),
        };
        let node = mark_host(node);
        (node, reader.diagnostics)
    })
}

/// Spec §5.2: a single returned element is the mount host.
fn mark_host(node: Node) -> Node {
    match node {
        Node::Element {
            loc,
            tag,
            attrs,
            children,
            ref_name,
            ..
        } => Node::Element {
            loc,
            tag,
            attrs,
            children,
            host: true,
            ref_name,
        },
        other => other,
    }
}
