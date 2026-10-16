//! Export bindings of a component module (shadcn S1.1, R34.11): which declaration an import of
//! `{ X }` names. `export function X`, `export { A as X }`, `export const X = …` and
//! `export { X } from './x'` (an `index.ts` barrel) all spell "the component X of this project", and an
//! island imports it by that binding. Everything that cannot be proven falls back to the binding itself
//! (an opaque island), never to a guess.
use crate::analyze::component::{AnalyzeOptions, FoundFn, module_component, module_fn};
use crate::analyze::modules::{Export, resolve_module};
use crate::analyze::names::{MemberRef, member_of};
use crate::analyze::stores::Module;
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;

/// How many modules a re-export chain may cross before the reader gives up.
const MAX_DEPTH: usize = 8;

/// What an export of a module is.
#[derive(Debug, PartialEq, Eq)]
pub enum Binding {
    /// Declared here by the module-level function of this local name.
    Fn(String),
    /// A module-level function of this name that nothing exports (a helper component of the module).
    Local(String),
    /// Declared here, but not as a function declaration the compiler reads (`export const X = () => …`,
    /// `export const X = forwardRef(…)`, a namespace import): the component is an island.
    Opaque,
    /// `export default …`: the default export is read by the default path.
    Default,
    /// Declared here as an alias of a member of a package import (`const Root = Dialog.Root`, R34.35):
    /// the component is that package member.
    Member(MemberRef),
    /// Re-exported from another module: `(specifier, name there)`; `default` there is the default.
    Follow(String, String),
    /// `export * from …` clauses that may carry it.
    Stars(Vec<String>),
    /// A namespace of the module the specifier names: `export * as X from '…'`, or `import * as X from '…'`
    /// re-exported (F153c: the `radix-ui` barrel). A member of it (`X.Root`) is that module's export.
    Namespace(String),
    /// Nothing exports it.
    Absent,
}

/// What the export `export` of the module `ast` is.
pub fn find(ast: &js_ast::Ast<'_>, export: &str) -> Binding {
    let m = Module::new(ast);
    let records = ast.import_records.as_slice();
    let spec_of = |i: u32| {
        records
            .get(i as usize)
            .map(|r| String::from_utf8_lossy(r.path.text).into_owned())
    };
    let mut stars = Vec::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SLocal(l) if l.is_export => {
                    for d in l.decls.iter() {
                        if let B::BIdentifier(id) = d.binding.data
                            && m.name(id.r#ref) == export
                        {
                            if let Some(mr) = d.value.and_then(|v| m.member_ref(&v)) {
                                return Binding::Member(mr);
                            }
                            // `export const X = forwardRef(function (props, ref) {…})` (R34.63)
                            if matches!(
                                module_component(ast, export),
                                Some(FoundFn::ForwardRef(_) | FoundFn::Arrow(_))
                            ) {
                                return Binding::Fn(export.to_string());
                            }
                            return match d.value.map(|v| v.data) {
                                Some(E::EImportIdentifier(i)) => m.reexport(i.ref_),
                                _ => Binding::Opaque,
                            };
                        }
                    }
                }
                S::SExportDefault(_) if export == "default" => return Binding::Default,
                S::SExportClause(c) => {
                    for item in c.items.slice() {
                        if item.alias.slice() == export.as_bytes() {
                            let r = item.name.ref_;
                            let local = m.name(r);
                            return match m.reexport(r) {
                                Binding::Opaque if module_component(ast, &local).is_some() => {
                                    Binding::Fn(local)
                                }
                                Binding::Opaque => m
                                    .const_value(r)
                                    .and_then(|v| m.member_ref(&v))
                                    .map_or(Binding::Opaque, Binding::Member),
                                b => b,
                            };
                        }
                    }
                }
                S::SExportFrom(f) => {
                    for item in f.items.slice() {
                        if item.alias.slice() == export.as_bytes()
                            && let Some(spec) = spec_of(f.import_record_index)
                        {
                            let original = String::from_utf8_lossy(item.original_name.slice());
                            return Binding::Follow(spec, original.into_owned());
                        }
                    }
                }
                // `export *` never re-exports the default (ES spec).
                S::SExportStar(st) if st.alias.is_none() && export != "default" => {
                    stars.extend(spec_of(st.import_record_index));
                }
                S::SExportStar(st)
                    if st
                        .alias
                        .as_ref()
                        .is_some_and(|a| a.original_name.slice() == export.as_bytes()) =>
                {
                    if let Some(spec) = spec_of(st.import_record_index) {
                        return Binding::Namespace(spec);
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(FoundFn::ForwardRef(_) | FoundFn::Arrow(_)) = module_component(ast, export) {
        return Binding::Local(export.to_string());
    }
    if let Some(f) = module_fn(ast, export) {
        let exported = f.flags.contains(js_ast::flags::Function::IsExport);
        return if exported {
            Binding::Fn(export.to_string())
        } else {
            Binding::Local(export.to_string())
        };
    }
    if stars.is_empty() {
        Binding::Absent
    } else {
        Binding::Stars(stars)
    }
}

impl Module<'_> {
    /// `BASE.MEMBER` with `BASE` imported from a package.
    fn member_ref(&self, e: &js_ast::Expr) -> Option<MemberRef> {
        member_of(e, |r| {
            self.import_of(r)
                .map(|(s, i)| (s.to_string(), i.to_string()))
        })
    }

    /// An exported binding that is itself an import is a re-export; anything else is declared here.
    fn reexport(&self, r: js_ast::Ref) -> Binding {
        match self.import_of(r) {
            Some((spec, "*")) => Binding::Namespace(spec.to_string()),
            None => Binding::Opaque,
            Some((spec, imported)) => Binding::Follow(spec.to_string(), imported.to_string()),
        }
    }
}

/// The package member that the export `export` of the project module at `path` is an alias of
/// (`export { Root }` after `const Root = Dialog.Root`), if it is one.
pub fn package_member(path: &str, export: &Export, opts: &AnalyzeOptions) -> Option<MemberRef> {
    let bytes = std::fs::read(opts.root.join(path)).ok()?;
    let parsed = crate::parse::parse_tsx(path, bytes).ok()?;
    let name = match export {
        Export::Default => "default",
        Export::Named(n) => n,
    };
    match parsed.with_ast(|ast| find(ast, name)) {
        Binding::Member(m) => Some(m),
        _ => None,
    }
}

/// The module that declares `export` of the project module at `path`, and the export there: follows
/// `export { X } from`, `export * from` and import-then-export through relative specifiers. A chain that
/// cannot be followed (a package, a missing file, a cycle) stops where it is: the caller then compiles
/// (or fails closed on) the export at the module it was imported from.
pub fn declared_in(path: &str, export: &Export, opts: &AnalyzeOptions) -> (String, Export) {
    follow(path, export, opts, 0).unwrap_or_else(|| (path.to_string(), export.clone()))
}

fn follow(
    path: &str,
    export: &Export,
    opts: &AnalyzeOptions,
    depth: usize,
) -> Option<(String, Export)> {
    if depth > MAX_DEPTH {
        return None;
    }
    let bytes = std::fs::read(opts.root.join(path)).ok()?;
    let parsed = crate::parse::parse_tsx(path, bytes).ok()?;
    let name = match export {
        Export::Default => "default",
        Export::Named(n) => n,
    };
    let found = parsed.with_ast(|ast| find(ast, name));
    let next = |spec: &str, there: &str| {
        let target = resolve_module(path, spec, opts)?;
        let export = if there == "default" {
            Export::Default
        } else {
            Export::Named(there.to_string())
        };
        follow(&target, &export, opts, depth + 1)
    };
    match found {
        Binding::Follow(spec, there) => next(&spec, &there),
        Binding::Stars(specs) => specs.iter().find_map(|s| next(s, name)),
        Binding::Absent => None,
        _ => Some((path.to_string(), export.clone())),
    }
}

/// The module and export a component import names, member path included (F153c): `imported` of the module at
/// `path`, followed through barrels, then each `member` off a namespace export (`Label.Root` of
/// `export * as Label from '@radix-ui/react-label'`). `None` when a step cannot be proven.
pub fn declared_member(
    path: &str,
    imported: &str,
    member: &[String],
    opts: &AnalyzeOptions,
) -> Option<(String, Export)> {
    let as_export = |n: &str| {
        if n == "default" {
            Export::Default
        } else {
            Export::Named(n.to_string())
        }
    };
    // `import * as X` then `<X.Root>`: the namespace is the module itself.
    let (mut path, mut rest) = if imported == "*" {
        let (first, rest) = member.split_first()?;
        (declared_in(path, &as_export(first), opts), rest)
    } else {
        (declared_in(path, &as_export(imported), opts), member)
    };
    for _ in 0..MAX_DEPTH {
        let Some((first, tail)) = rest.split_first() else {
            return Some(path);
        };
        let bytes = std::fs::read(opts.root.join(&path.0)).ok()?;
        let parsed = crate::parse::parse_tsx(&path.0, bytes).ok()?;
        let name = match &path.1 {
            Export::Default => "default".to_string(),
            Export::Named(n) => n.clone(),
        };
        let Binding::Namespace(spec) = parsed.with_ast(|ast| find(ast, &name)) else {
            return None;
        };
        let target = resolve_module(&path.0, &spec, opts)?;
        path = declared_in(&target, &as_export(first), opts);
        rest = tail;
    }
    None
}
