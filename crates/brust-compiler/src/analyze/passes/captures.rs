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

/// `source` (as written in the module at `ctx.path`) is server-only; a
/// relative specifier is also matched against `serverOnly` as a path from the
/// root (`../server/db` from `src/app/x.tsx` is `src/server/db`).
fn server_only_import(source: &str, ctx: &PassCtx<'_>) -> bool {
    if is_server_only(source, &ctx.opts.server_only) {
        return true;
    }
    if !(source.starts_with("./") || source.starts_with("../")) {
        return false;
    }
    let dir = ctx.path.rfind('/').map_or("", |i| &ctx.path[..i]);
    let resolved = crate::analyze::modules::normalize(&if dir.is_empty() {
        source.to_string()
    } else {
        format!("{dir}/{source}")
    });
    ctx.opts
        .server_only
        .iter()
        .any(|p| !p.is_empty() && resolved.starts_with(p.trim_start_matches("./")))
}

pub fn captures(ir: &mut ComponentIR, st: &mut PassState, ctx: &PassCtx<'_>) {
    // Locals as the client sees them: a props-only slot is a value computed
    // by the job, not code the chunk runs (its imports stay on the server).
    let cx = st.cx.client_view(ir);
    let mut uses: Vec<ClientUse> = Vec::new();
    for h in &ir.handlers {
        uses.push(ClientUse {
            loc: h.body.loc,
            deps: cx.deps(&h.body, &h.item_scoped),
            what: "a handler",
            raw: None,
        });
    }
    for e in &ir.effects {
        // F41 (§8.1): names the effect reads that its declared dependency array lacks.
        if let Some(declared) = &e.deps {
            let body = st.cx.deps(&e.body, &[]);
            let mut covered = super::deps::Deps::default();
            for d in declared {
                covered.union(&st.cx.deps(d, &[]));
            }
            let covered_props = covered.prop_roots();
            // A whole-props read (`*`, e.g. through an opaque function body) cannot name
            // the prop: it is missing only when nothing from props is declared.
            let mut missing: Vec<String> = body
                .prop_roots()
                .into_iter()
                .filter(|p| {
                    if p == "*" {
                        covered.props.is_empty()
                    } else {
                        !covered_props.contains(p) && !covered.props.contains("*")
                    }
                })
                .map(|p| if p == "*" { "props".to_string() } else { p })
                .collect();
            missing.extend(body.state.difference(&covered.state).cloned());
            if !missing.is_empty() {
                ir.diagnostics.push(Diagnostic::warning(
                    "effect-deps",
                    format!(
                        "the effect reads `{}` but its dependency array does not list it",
                        missing.join("`, `")
                    ),
                    e.body.loc,
                    "add the missing names to the dependency array",
                ));
            }
        }
        let mut deps = cx.deps(&e.body, &[]);
        for d in e.deps.iter().flatten() {
            deps.union(&cx.deps(d, &[]));
        }
        uses.push(ClientUse {
            loc: e.body.loc,
            deps,
            what: "an effect",
            raw: None,
        });
    }
    for s in &ir.state {
        let (loc, deps) = match &s.init {
            Expr::Precomputed { slot, .. } => match st.slots.get(slot) {
                Some(i) => (i.raw.loc, cx.deps(&i.raw, &[])),
                None => continue,
            },
            Expr::Server(crate::ir::ServerExpr(r)) | Expr::Raw(r) => (r.loc, cx.deps(r, &[])),
            Expr::ClientOnly { .. } => continue,
        };
        uses.push(ClientUse {
            loc,
            deps,
            what: "a state initializer",
            raw: None,
        });
    }
    let mut slots: Vec<_> = st.slots.iter().filter(|(_, i)| i.state_dependent).collect();
    slots.sort_by_key(|(s, _)| s[2..].parse::<u32>().unwrap_or(0));
    for (_, i) in slots {
        uses.push(ClientUse {
            loc: i.raw.loc,
            deps: cx.deps(&i.raw, &i.scope),
            what: "a state-dependent value",
            raw: None,
        });
    }
    uses.extend(st.client_uses.iter().cloned().map(|mut u| {
        if let Some((r, scope)) = &u.raw {
            u.deps = cx.deps(r, scope);
        }
        u
    }));

    let mut props = BTreeSet::new();
    let mut imports = BTreeSet::new();
    for u in &uses {
        props.extend(u.deps.prop_roots());
        imports.extend(u.deps.imports.iter().cloned());
    }
    ir.client_props = props.into_iter().collect();
    ir.client_imports = imports.iter().cloned().collect();
    let mut module = std::collections::BTreeSet::new();
    for u in &uses {
        module.extend(u.deps.module_locals.iter().cloned());
    }
    ir.client_module_locals = module.into_iter().collect();

    // §3.2 rule 2: a server-only module reached from client code.
    for (source, imported) in &imports {
        if !server_only_import(source, ctx) {
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
