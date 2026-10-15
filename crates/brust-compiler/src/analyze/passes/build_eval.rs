//! Which precompute slots the build may evaluate once instead of per request (L2, G4/H1).
//!
//! A slot qualifies when it has no inputs, is not state-dependent, sits in no list or condition
//! and is pure: only allowlisted globals, no module `let`/`var` captures, and (v1) no package
//! imports. `buildTime(() => …)` imported from `@brust/core` is the explicit opt-in that lifts the
//! package-import and `async` limits; the global denylist and the time/random rules still apply.
//!
//! F149 (R34.88-R34.90): an inlined instance whose child job reads only constants runs that job at
//! build when the job's code is allowed: allowlisted packages, pure relative modules, and constants of
//! other modules re-emitted folded ([`instance_job`]).
use super::deps::Deps;
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::Walk;
use crate::analyze::modules::resolve;
use crate::ir::{IdentKind, ModuleDecl, RawExpr, RawKind};
use bun_ast as js_ast;
use js_ast::stmt::Data as S;
use std::collections::HashSet;

/// The packages a build-evaluated instance job may import (F149 ruling Q2): exact package names.
pub const INSTANCE_PACKAGES: &[&str] =
    &["cn", "clsx", "tailwind-merge", "class-variance-authority"];

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
    // Build-host input: `import.meta.env` / `.url` / `.dir` (the reader records the read as this name).
    "import.meta",
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
pub fn reads_random(r: &RawExpr) -> bool {
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
            let relative = |s: &String| crate::analyze::modules::is_relative_spec(s);
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
const VALUE_GLOBALS: &[&str] = &["NaN", "Infinity", "undefined"];

/// A relatively imported module a pure slot may call into (R0.1: fail closed). Its body is read,
/// not assumed: no package or `node:` imports, no module `let` / `var`, no dynamic `import()`, no
/// global outside the allowlist (`process`, `require`, `Date`, …) and no `Math.random`; its own
/// relative imports must pass too (depth <= 8). `packages` are package imports it may also have
/// (F149: the classic shadcn `lib/utils.ts` imports `clsx` and `tailwind-merge`).
pub fn module_is_pure(from: &str, source: &str, opts: &AnalyzeOptions, packages: &[&str]) -> bool {
    fn go(
        from: &str,
        source: &str,
        opts: &AnalyzeOptions,
        packages: &[&str],
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
                if packages.contains(&spec.as_str()) {
                    continue;
                }
                if !crate::analyze::modules::is_relative_spec(&spec) {
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
            if w.dynamic_import.is_some() || w.import_meta {
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
            Some(rels) => rels
                .iter()
                .all(|r| go(&path, r, opts, packages, depth + 1, seen)),
            None => false,
        }
    }
    go(from, source, opts, packages, 0, &mut HashSet::new())
}

/// F149 (R34.89): whether the build may run the precompute job of the compiled child `ir` (its
/// source `path`) once for an instance with constant inputs. `Ok` carries the relative imports the
/// evaluation serves folded (rule 3); `Err` the first reason it may not. It runs nothing.
pub fn instance_job(
    ir: &crate::ir::ComponentIR,
    path: &str,
    opts: &AnalyzeOptions,
) -> Result<Vec<crate::ir::EvalStub>, String> {
    use crate::ir::{JobKind, Tier};
    // F153c N1: the authored source of a package never runs at build.
    if crate::analyze::modules::is_package_source(path) {
        return Err("it is compiled from a package's source".into());
    }
    if !matches!(ir.tier, Tier::Static) {
        return Err("it is not a static component".into());
    }
    if ir.use_id_slots > 0 {
        return Err("it has `useId` values".into());
    }
    if !ir.state.is_empty() || !ir.stores.is_empty() {
        return Err("it reads state or a store".into());
    }
    match ir.jobs.as_slice() {
        [j] if matches!(j.kind, JobKind::Precompute) => {}
        _ => return Err("it has a job other than its precompute job".into()),
    }
    if ir.jobs[0].inputs.iter().any(|i| i == "__store" || i == "*") {
        return Err("its job reads a store or the whole props object".into());
    }
    // R34.96 A1: a fused child's job runs inside this one, so it must be evaluable too.
    if let Some((f, why)) = ir
        .fused
        .iter()
        .find_map(|f| f.eval_refused.as_ref().map(|w| (f, w)))
    {
        return Err(format!("its fused child {} cannot: {why}", f.child_id));
    }
    let Some(reads) = crate::lower::server::job_reads(ir) else {
        return Err("its job could not be read".into());
    };
    if reads.per_item {
        return Err("its job computes a value per list item".into());
    }
    if let Some(n) = reads.opaque_decls.first() {
        return Err(format!(
            "its job runs the module declaration `{n}`, which is not a constant"
        ));
    }
    for g in &reads.globals {
        if DENIED_GLOBALS.contains(&g.as_str()) {
            return Err(format!("its job reads `{g}`, which differs between runs"));
        }
        if !ALLOWED_GLOBALS.contains(&g.as_str()) && !VALUE_GLOBALS.contains(&g.as_str()) {
            return Err(format!("its job reads the global `{g}`"));
        }
    }
    for e in &reads.exprs {
        if reads_random(e) {
            return Err("its job reads `Math.random`".into());
        }
        if opaque(e) {
            return Err("its job has code the compiler does not read (a block body)".into());
        }
    }
    let mut stubs: Vec<crate::ir::EvalStub> = Vec::new();
    let mut by_source: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
    for (_, source, imported) in &reads.imports {
        by_source.entry(source).or_default().push(imported);
    }
    for (source, names) in by_source {
        if INSTANCE_PACKAGES.contains(&source) {
            continue;
        }
        if !crate::analyze::modules::is_relative_spec(source) {
            return Err(format!(
                "its job imports the package `{source}`, which is not allowed at build"
            ));
        }
        if module_is_pure(path, source, opts, INSTANCE_PACKAGES) {
            continue;
        }
        let mut code = String::new();
        for name in names {
            match crate::analyze::const_fold::imported_call_const(
                path,
                source,
                name,
                opts,
                INSTANCE_PACKAGES,
            ) {
                Ok(c) => code.push_str(&c),
                Err(why) => return Err(format!("its job imports {why}")),
            }
        }
        stubs.push(crate::ir::EvalStub {
            source: source.to_string(),
            code,
        });
    }
    Ok(stubs)
}

/// Code the compiler keeps as text (a block body, an opaque construct) anywhere in `r`.
fn opaque(r: &RawExpr) -> bool {
    match &r.kind {
        RawKind::Opaque { .. } => true,
        RawKind::Arrow { body, .. } => match body {
            crate::ir::ArrowBody::Expr(b) => opaque(b),
            crate::ir::ArrowBody::Block { .. } => true,
        },
        RawKind::Member { target, .. } => opaque(target),
        RawKind::Index { target, index } => opaque(target) || opaque(index),
        RawKind::Unary { value, .. } => opaque(value),
        RawKind::Binary { left, right, .. } => opaque(left) || opaque(right),
        RawKind::Cond { test, yes, no } => opaque(test) || opaque(yes) || opaque(no),
        RawKind::Template { parts, .. } => parts.iter().any(|(p, _)| opaque(p)),
        RawKind::Call { callee, args } => opaque(callee) || args.iter().any(opaque),
        RawKind::Array(items) => items.iter().any(opaque),
        RawKind::Object(props) => props.iter().any(|(_, v)| opaque(v)),
        RawKind::Lit(_) | RawKind::Ident { .. } | RawKind::Jsx(_) => false,
    }
}
