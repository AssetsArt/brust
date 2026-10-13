//! Which precompute slots the build may evaluate once instead of per request (L2, G4/H1).
//!
//! A slot qualifies when it has no inputs, is not state-dependent, sits in no list or condition
//! and is pure: only allowlisted globals, no module `let`/`var` captures, and (v1) no package
//! imports. `buildTime(() => …)` imported from `@brust/core` is the explicit opt-in that lifts the
//! package-import and `async` limits; the global denylist and the time/random rules still apply.
use super::deps::Deps;
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::Walk;
use crate::analyze::modules::resolve;
use crate::ir::{IdentKind, ModuleDecl, RawExpr, RawKind};
use bun_ast as js_ast;
use js_ast::stmt::Data as S;
use std::collections::HashSet;

/// Globals a v1 slot may read.
const ALLOWED_GLOBALS: &[&str] = &[
    "Math",
    "JSON",
    "String",
    "Number",
    "Array",
    "Object",
    "RegExp",
    "encodeURIComponent",
    "decodeURIComponent",
];
/// Globals no build-time slot may read (time, randomness, the host, the network).
const DENIED_GLOBALS: &[&str] = &[
    "Date",
    "Intl",
    "crypto",
    "performance",
    "process",
    "fetch",
    "Bun",
    "globalThis",
];

pub enum Verdict {
    /// Stays a precompute job.
    Not,
    /// A pure helper call: evaluate at build, fall back to the job with a warning on failure.
    Pure,
    /// `buildTime(…)`: evaluate at build, a failure is a build error.
    BuildTime,
    /// `buildTime(…)` that reads props, state, a store or a loop value: it stays a job.
    BuildTimeInput(Vec<String>),
    /// `buildTime(…)` that reads a denied global.
    BuildTimeImpure(String),
}

/// The closure of a `buildTime(closure)` call imported from `@brust/core`.
pub fn build_time_call(r: &RawExpr) -> Option<&RawExpr> {
    let RawKind::Call { callee, args } = &r.kind else {
        return None;
    };
    let RawKind::Ident {
        kind: IdentKind::Import { source, imported },
        ..
    } = &callee.kind
    else {
        return None;
    };
    (source == "@brust/core" && imported == "buildTime" && args.len() == 1).then(|| &args[0])
}

/// `Math.random` anywhere in `r` (the global itself is allowlisted).
fn reads_random(r: &RawExpr) -> bool {
    match &r.kind {
        RawKind::Member { target, name, .. } => {
            (name == "random"
                && matches!(&target.kind, RawKind::Ident { name: n, kind: IdentKind::Global } if n == "Math"))
                || reads_random(target)
        }
        RawKind::Index { target, index } => reads_random(target) || reads_random(index),
        RawKind::Unary { value, .. } => reads_random(value),
        RawKind::Binary { left, right, .. } => reads_random(left) || reads_random(right),
        RawKind::Cond { test, yes, no } => {
            reads_random(test) || reads_random(yes) || reads_random(no)
        }
        RawKind::Template { parts, .. } => parts.iter().any(|(p, _)| reads_random(p)),
        RawKind::Call { callee, args } => reads_random(callee) || args.iter().any(reads_random),
        RawKind::Array(items) => items.iter().any(reads_random),
        RawKind::Object(props) => props.iter().any(|(_, v)| reads_random(v)),
        RawKind::Arrow { body, .. } => match body {
            crate::ir::ArrowBody::Expr(b) => reads_random(b),
            crate::ir::ArrowBody::Block { source, .. } => source.contains("Math.random"),
        },
        RawKind::Opaque { source, .. } => source.contains("Math.random"),
        RawKind::Lit(_) | RawKind::Ident { .. } | RawKind::Jsx(_) => false,
    }
}

/// What the build may do with the slot `r` (`deps` are its transitive dependencies). `placed`: the
/// slot sits in no list or condition and does not change with state.
pub fn classify(
    r: &RawExpr,
    deps: &Deps,
    placed: bool,
    module_decls: &[ModuleDecl],
    imports_pure: &dyn Fn(&str) -> bool,
) -> Verdict {
    let closure = build_time_call(r);
    let mut inputs: Vec<String> = Vec::new();
    inputs.extend(deps.props.iter().cloned());
    inputs.extend(deps.state.iter().map(|s| format!("state `{s}`")));
    inputs.extend(deps.stores.iter().cloned());
    inputs.extend(deps.loop_bindings.iter().cloned());
    inputs.extend(deps.setters.iter().map(|s| format!("setter `{s}`")));
    if deps.browser {
        inputs.push("a browser global".into());
    }
    if !inputs.is_empty() {
        return match closure {
            Some(_) => Verdict::BuildTimeInput(inputs),
            None => Verdict::Not,
        };
    }
    if !placed {
        return Verdict::Not;
    }
    // Time, randomness, the host: never at build, buildTime or not.
    if let Some(g) = deps
        .globals
        .iter()
        .find(|g| DENIED_GLOBALS.contains(&g.as_str()))
    {
        return match closure {
            Some(_) => Verdict::BuildTimeImpure(g.clone()),
            None => Verdict::Not,
        };
    }
    if reads_random(r) {
        return match closure {
            Some(_) => Verdict::BuildTimeImpure("Math.random".into()),
            None => Verdict::Not,
        };
    }
    // A module `let` / `var` can change between the build and a request.
    let mutable = |name: &String| {
        module_decls.iter().any(|d| {
            d.names.contains(name) && (d.source.starts_with("let ") || d.source.starts_with("var "))
        })
    };
    if deps.module_locals.iter().any(mutable) {
        return Verdict::Not;
    }
    match closure {
        Some(_) => Verdict::BuildTime,
        None => {
            let relative = |s: &String| s.starts_with("./") || s.starts_with("../");
            let known = deps
                .globals
                .iter()
                .all(|g| ALLOWED_GLOBALS.contains(&g.as_str()));
            if known
                && !deps.opaque
                && deps
                    .imports
                    .iter()
                    .all(|(src, _)| relative(src) && imports_pure(src))
            {
                Verdict::Pure
            } else {
                Verdict::Not
            }
        }
    }
}

/// Globals an imported module may read besides the allowlist (values, not capabilities).
const VALUE_GLOBALS: &[&str] = &["NaN", "Infinity"];

/// A relatively imported module a pure slot may call into (R0.1: fail closed). Its body is read,
/// not assumed: no package or `node:` imports, no module `let` / `var`, no dynamic `import()`, no
/// global outside the allowlist (`process`, `require`, `Date`, …) and no `Math.random`; its own
/// relative imports must pass too (depth <= 8).
pub fn module_is_pure(from: &str, source: &str, opts: &AnalyzeOptions) -> bool {
    fn go(
        from: &str,
        source: &str,
        opts: &AnalyzeOptions,
        depth: usize,
        seen: &mut HashSet<String>,
    ) -> bool {
        if depth > 8 {
            return false;
        }
        let Some(path) = resolve(from, source, opts) else {
            return false;
        };
        if !seen.insert(path.clone()) {
            return true;
        }
        let Ok(bytes) = std::fs::read(opts.root.join(&path)) else {
            return false;
        };
        if String::from_utf8_lossy(&bytes).contains("Math.random") {
            return false;
        }
        let Ok(parsed) = crate::parse::parse_tsx(&path, bytes) else {
            return false;
        };
        let rels: Option<Vec<String>> = parsed.with_ast(|ast| {
            let mut rels = Vec::new();
            for rec in ast.import_records.as_slice() {
                let spec = String::from_utf8_lossy(rec.path.text).into_owned();
                if !(spec.starts_with("./") || spec.starts_with("../")) {
                    return None;
                }
                rels.push(spec);
            }
            let mut w = Walk::default();
            for part in ast.parts.iter() {
                for stmt in part.stmts.slice() {
                    if let S::SLocal(l) = &stmt.data
                        && !matches!(l.kind, js_ast::S::Kind::KConst)
                    {
                        return None;
                    }
                    w.stmt(stmt);
                }
            }
            if w.dynamic_import.is_some() {
                return None;
            }
            for r in &w.used {
                let Some(sym) = ast.symbols.as_slice().get(r.inner_index() as usize) else {
                    continue;
                };
                if matches!(sym.kind, js_ast::symbol::Kind::Unbound) {
                    let name = String::from_utf8_lossy(sym.original_name.slice()).into_owned();
                    if !ALLOWED_GLOBALS.contains(&name.as_str())
                        && !VALUE_GLOBALS.contains(&name.as_str())
                    {
                        return None;
                    }
                }
            }
            Some(rels)
        });
        match rels {
            Some(rels) => rels.iter().all(|r| go(&path, r, opts, depth + 1, seen)),
            None => false,
        }
    }
    go(from, source, opts, 0, &mut HashSet::new())
}
