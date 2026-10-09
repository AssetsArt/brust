//! Captures (spec §3.2 rules 1–3, §8.2): what the client chunk reads — the
//! props it needs serialized (`client_props`) and the modules it bundles
//! (`client_imports`) — plus the two errors that follow from it:
//! `server-only-in-client` and `request-state-in-render`.
use super::{ClientUse, PassCtx, PassState};
use crate::ir::{ComponentIR, Diagnostic, Expr};
use std::collections::BTreeSet;

/// Bare module names that are Node/Bun builtins (plan Global Constraints).
const SERVER_BUILTINS: &[&str] = &[
    "fs",
    "path",
    "os",
    "crypto",
    "child_process",
    "net",
    "http",
    "https",
    "stream",
    "zlib",
    "worker_threads",
    "cluster",
    "dns",
    "tls",
    "readline",
    "sqlite",
];

/// Prop names that carry request state (§3.2 rule 1).
const REQUEST_PROPS: &[&str] = &["req", "request", "cookies", "headers"];

pub fn is_server_only(source: &str, extra: &[String]) -> bool {
    source.starts_with("node:")
        || source.starts_with("bun:")
        || SERVER_BUILTINS
            .iter()
            .any(|b| source == *b || source.strip_prefix(b).is_some_and(|r| r.starts_with('/')))
        || extra
            .iter()
            .any(|p| !p.is_empty() && source.starts_with(p.as_str()))
}

pub fn captures(ir: &mut ComponentIR, st: &mut PassState, ctx: &PassCtx<'_>) {
    let mut uses: Vec<ClientUse> = Vec::new();
    for h in &ir.handlers {
        uses.push(ClientUse {
            loc: h.body.loc,
            deps: st.cx.deps(&h.body, &h.item_scoped),
            what: "a handler",
        });
    }
    for e in &ir.effects {
        let mut deps = st.cx.deps(&e.body, &[]);
        for d in e.deps.iter().flatten() {
            deps.union(&st.cx.deps(d, &[]));
        }
        uses.push(ClientUse {
            loc: e.body.loc,
            deps,
            what: "an effect",
        });
    }
    for s in &ir.state {
        let (loc, deps) = match &s.init {
            Expr::Precomputed { slot, .. } => match st.slots.get(slot) {
                Some(i) => (i.raw.loc, i.deps.clone()),
                None => continue,
            },
            Expr::Server(crate::ir::ServerExpr(r)) | Expr::Raw(r) => (r.loc, st.cx.deps(r, &[])),
            Expr::ClientOnly { .. } => continue,
        };
        uses.push(ClientUse {
            loc,
            deps,
            what: "a state initializer",
        });
    }
    let mut slots: Vec<_> = st.slots.iter().filter(|(_, i)| i.state_dependent).collect();
    slots.sort_by_key(|(s, _)| s[2..].parse::<u32>().unwrap_or(0));
    for (_, i) in slots {
        uses.push(ClientUse {
            loc: i.raw.loc,
            deps: i.deps.clone(),
            what: "a state-dependent value",
        });
    }
    uses.extend(st.client_uses.iter().cloned());

    let mut props = BTreeSet::new();
    let mut imports = BTreeSet::new();
    for u in &uses {
        props.extend(u.deps.prop_roots());
        imports.extend(u.deps.imports.iter().cloned());
    }
    ir.client_props = props.into_iter().collect();
    ir.client_imports = imports.iter().cloned().collect();

    // §3.2 rule 2: a server-only module reached from client code.
    for (source, imported) in &imports {
        if !is_server_only(source, &ctx.opts.server_only) {
            continue;
        }
        let Some(u) = uses
            .iter()
            .find(|u| u.deps.imports.contains(&(source.clone(), imported.clone())))
        else {
            continue;
        };
        ir.diagnostics.push(Diagnostic::error(
            "server-only-in-client",
            format!(
                "{imported} from {source} is server-only but is used by {} at line {}",
                u.what,
                ctx.line(u.loc)
            ),
            u.loc,
            "move the computation into the loader or make the module browser-safe",
        ));
    }

    // §3.2 rule 1: request state read in render, a job, or client code.
    let read: Vec<(u32, &super::deps::Deps)> = st
        .painted
        .iter()
        .map(|p| (p.loc, &p.deps))
        .chain(uses.iter().map(|u| (u.loc, &u.deps)))
        .collect();
    for name in REQUEST_PROPS {
        if let Some((loc, _)) = read.iter().find(|(_, d)| d.prop_roots().contains(*name)) {
            ir.diagnostics.push(Diagnostic::error(
                "request-state-in-render",
                format!(
                    "prop `{name}` carries request state and is read at line {}",
                    ctx.line(*loc)
                ),
                *loc,
                "read request values in the route loader and pass plain values as props",
            ));
        }
    }
    st.client_uses = uses;
}
