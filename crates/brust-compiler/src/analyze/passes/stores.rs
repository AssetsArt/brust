//! Stores pass (M3-F D7): resolves each `useStore` handle to the `defineStore('<name>', …)` it
//! names, through the handle's import (`analyze/stores.rs`). An unresolved handle is a
//! `store-name-unresolved` fallback (the tier pass then makes the component React); the same
//! name defined by two modules in one compile is a `store-name-duplicate` warning; a read whose
//! job-input path falls back to the coarse `__store` (R3) is a `store-name-dotted` warning.
use super::PassCtx;
use super::deps::{STORE_INPUT, store_input};
use crate::analyze::modules::resolve as resolve_module;
use crate::analyze::stores::read_store_export;
use crate::ir::{
    ArrowBody, Attr, ComponentIR, Diagnostic, Expr, IdentKind, Node, RawExpr, RawKind, ServerExpr,
    StoreRef,
};
use std::collections::BTreeSet;

/// Fills `StoreUse.resolved` for every `useStore` of `ir`.
pub fn resolve(ir: &mut ComponentIR, ctx: &PassCtx<'_>) {
    let mut diags = Vec::new();
    for u in &mut ir.stores {
        let (_, source, imported) = &u.import;
        // A namespace handle `stores.cart` reads the export after the dot.
        let export = match imported.as_str() {
            "*" => u.handle.rsplit('.').next().unwrap_or_default(),
            name => name,
        };
        match store_of(source, export, ctx) {
            Ok(r) => {
                let mut modules = ctx.modules.borrow_mut();
                match modules.store_names.get(&r.name) {
                    Some(other) if *other != r.module => diags.push(Diagnostic::warning(
                        "store-name-duplicate",
                        format!(
                            "useStore({}): the store name '{}' is defined by both {other} and {}; their state shares one snapshot entry",
                            u.handle, r.name, r.module
                        ),
                        u.loc,
                        "give every defineStore a distinct name",
                    )),
                    Some(_) => {}
                    None => {
                        modules.store_names.insert(r.name.clone(), r.module.clone());
                    }
                }
                u.resolved = Some(r);
            }
            Err(Unresolved { reason, own_module }) => {
                diags.push(Diagnostic::fallback(
                    "store-name-unresolved",
                    format!(
                        "useStore({}): {reason}; the component renders as a React island",
                        u.handle
                    ),
                    u.loc,
                    if own_module {
                        "define the store in its own module"
                    } else {
                        "import the handle from the module that calls defineStore('<name>', …) with a string-literal name"
                    },
                ));
            }
        }
    }
    dotted(ir, &mut diags);
    ir.diagnostics.extend(diags);
}

/// R3: a first-paint read of a resolved store whose name or key cannot be a job-input path
/// segment declares the coarse `__store` input. One warning per store name.
fn dotted(ir: &ComponentIR, diags: &mut Vec<Diagnostic>) {
    let mut reads = BTreeSet::new();
    node_reads(&ir.template, &mut reads);
    for s in &ir.state {
        expr_reads(&s.init, &mut reads);
    }
    for d in &ir.derived {
        expr_reads(&d.expr, &mut reads);
    }
    let mut warned = BTreeSet::new();
    for u in &ir.stores {
        let Some(r) = &u.resolved else { continue };
        let coarse = reads.iter().any(|(h, k)| {
            *h == u.handle && store_input(Some(&r.name), k.as_deref()) == STORE_INPUT
        });
        if coarse && warned.insert(r.name.clone()) {
            diags.push(Diagnostic::warning(
                "store-name-dotted",
                format!(
                    "useStore({}): the store name '{}' or a key read from it contains '.', '[' or ']'; its job inputs fall back to `{STORE_INPUT}`, so the job key hashes the whole snapshot",
                    u.handle, r.name
                ),
                u.loc,
                "prefer dot-free store names and keys",
            ));
        }
    }
}

type Reads = BTreeSet<(String, Option<String>)>;

fn expr_reads(e: &Expr, out: &mut Reads) {
    if let Expr::Raw(r) | Expr::Server(ServerExpr(r)) = e {
        raw_reads(r, out);
    }
}

/// Every store `(handle, key)` read in `r`, the whole subtree (JSX, arrow bodies and captures).
fn raw_reads(r: &RawExpr, out: &mut Reads) {
    let ident = |kind: &IdentKind, out: &mut Reads| {
        if let IdentKind::Store { handle, key } = kind {
            out.insert((handle.clone(), key.clone()));
        }
    };
    match &r.kind {
        RawKind::Lit(_) => {}
        RawKind::Ident { kind, .. } => ident(kind, out),
        RawKind::Member { target, .. } => raw_reads(target, out),
        RawKind::Index { target, index } => {
            raw_reads(target, out);
            raw_reads(index, out);
        }
        RawKind::Call { callee, args } => {
            raw_reads(callee, out);
            args.iter().for_each(|a| raw_reads(a, out));
        }
        RawKind::Binary { left, right, .. } => {
            raw_reads(left, out);
            raw_reads(right, out);
        }
        RawKind::Unary { value, .. } => raw_reads(value, out),
        RawKind::Cond { test, yes, no } => {
            raw_reads(test, out);
            raw_reads(yes, out);
            raw_reads(no, out);
        }
        RawKind::Template { parts, .. } => parts.iter().for_each(|(p, _)| raw_reads(p, out)),
        RawKind::Array(items) => items.iter().for_each(|i| raw_reads(i, out)),
        RawKind::Object(props) => props.iter().for_each(|(_, v)| raw_reads(v, out)),
        RawKind::Arrow { captures, body, .. } => {
            captures.iter().for_each(|(_, k)| ident(k, out));
            if let ArrowBody::Expr(b) = body {
                raw_reads(b, out);
            }
        }
        RawKind::Opaque { captures, .. } => captures.iter().for_each(|(_, k)| ident(k, out)),
        RawKind::Jsx(n) => node_reads(n, out),
    }
}

fn node_reads(n: &Node, out: &mut Reads) {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                if let Attr::Dynamic { value, .. } | Attr::Spread(value) = a {
                    expr_reads(value, out);
                }
            }
            children.iter().for_each(|c| node_reads(c, out));
        }
        Node::Slot(e) => expr_reads(e, out),
        Node::If { cond, then, else_ } => {
            expr_reads(cond, out);
            then.iter().chain(else_).for_each(|c| node_reads(c, out));
        }
        Node::For {
            source, key, body, ..
        } => {
            expr_reads(source, out);
            expr_reads(key, out);
            body.iter().for_each(|c| node_reads(c, out));
        }
        Node::Component {
            props, children, ..
        } => {
            props.iter().for_each(|(_, v)| expr_reads(v, out));
            children.iter().for_each(|c| node_reads(c, out));
        }
        Node::Fragment(cs) => cs.iter().for_each(|c| node_reads(c, out)),
        Node::Text(_) | Node::Outlet => {}
    }
}

struct Unresolved {
    reason: String,
    /// The store lives in the component's own module (R4).
    own_module: bool,
}

fn store_of(source: &str, export: &str, ctx: &PassCtx<'_>) -> Result<StoreRef, Unresolved> {
    let err = |reason: String| Unresolved {
        reason,
        own_module: false,
    };
    let own = || Unresolved {
        reason: "the store is defined in the component's own module".into(),
        own_module: true,
    };
    if !(source.starts_with("./") || source.starts_with("../")) {
        return Err(err(format!(
            "the handle is imported from the package {source}"
        )));
    }
    let path = resolve_module(ctx.path, source, ctx.opts)
        .ok_or_else(|| err(format!("cannot resolve {source} from {}", ctx.path)))?;
    if path == ctx.path {
        return Err(own());
    }
    let r = read_store_export(&path, export, ctx.opts, ctx.modules).map_err(err)?;
    if r.module == ctx.path {
        return Err(own());
    }
    Ok(r)
}
