//! React contexts (S2 context lowering, R34.100-R34.101): the module-level declarations that make a context, found by
//! shape, never by name.
//!
//! - React's own: `const C = createContext(default)` (`createContext` imported from `react`, or `React.createContext`),
//!   `<C.Provider value={…}>` and `useContext(C)`.
//! - Radix's `createContextScope` from `@radix-ui/react-context` (the second, and last, structural recogniser after
//!   `Primitive`, lead ruling Q1): `const [createX, createXScope] = createContextScope(NAME)` and
//!   `const [XProvider, useXContext] = createX(NAME)`. Its package source is integrity-checked like every package
//!   (R34.62), and the call shape below is all this compiler relies on: the Provider takes the value fields as props
//!   (`scope` is the nesting disambiguation, accepted only as a pass-through, R34.101), the hook is called with
//!   `(NAME, scope)`.
//!
//! A context is then an implicit prop: the Provider component hands fields to the consumers under it (see
//! `passes/contexts.rs`), and a consumer reads them as hidden props (`ir::ctx_prop`).
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashMap;

/// The module-level context declarations, by symbol key.
#[derive(Default, Debug)]
pub struct Contexts {
    /// A Provider component (`XProvider`) or a React context object (`C`) → the context's name.
    pub providers: HashMap<u32, String>,
    /// A Radix hook (`useXContext`) → the context's name. React's `useContext(C)` is recognised by its argument.
    pub hooks: HashMap<u32, String>,
    /// React contexts (`C` of `createContext`) → the context's name (the same name `providers` maps it to).
    pub react: HashMap<u32, String>,
}

impl Contexts {
    pub fn is_empty(&self) -> bool {
        self.providers.is_empty() && self.hooks.is_empty() && self.react.is_empty()
    }
}

const RADIX_PKG: &str = "@radix-ui/react-context";

/// Reads the module's top-level `const` declarations for contexts.
pub fn scan(table: &NameTable<'_>, ast: &js_ast::Ast<'_>) -> Contexts {
    let mut out = Contexts::default();
    // Local names of `createContextScope`'s first result (`createX`).
    let mut factories: HashMap<u32, ()> = HashMap::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let S::SLocal(l) = &stmt.data else { continue };
            if !matches!(l.kind, js_ast::S::Kind::KConst) {
                continue;
            }
            for d in l.decls.iter() {
                let Some(value) = &d.value else { continue };
                let E::ECall(call) = &value.data else {
                    continue;
                };
                match d.binding.data {
                    B::BArray(arr) => {
                        let items = arr.items();
                        let names: Vec<Option<js_ast::Ref>> = items
                            .iter()
                            .map(|i| match i.binding.data {
                                B::BIdentifier(id) => Some(id.r#ref),
                                _ => None,
                            })
                            .collect();
                        if arr.has_spread
                            || items.len() != 2
                            || items.iter().any(|i| i.default_value.is_some())
                        {
                            continue;
                        }
                        // `const [createX, createXScope] = createContextScope(NAME)`
                        if table.is_import_call(&call.target, RADIX_PKG, "createContextScope") {
                            if let Some(c) = names[0] {
                                factories.insert(table.key_of(c), ());
                            }
                            continue;
                        }
                        // `const [XProvider, useXContext] = createX(NAME)`
                        if let E::EIdentifier(id) = &call.target.data
                            && factories.contains_key(&table.key_of(id.ref_))
                            && let (Some(p), Some(h)) = (names[0], names[1])
                        {
                            let name = table.local_name(p);
                            out.providers.insert(table.key_of(p), name.clone());
                            out.hooks.insert(table.key_of(h), name);
                        }
                    }
                    // `const C = createContext(default)`
                    B::BIdentifier(id) if table.is_react_call(&call.target, "createContext") => {
                        let name = table.local_name(id.r#ref);
                        out.providers.insert(table.key_of(id.r#ref), name.clone());
                        out.react.insert(table.key_of(id.r#ref), name);
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// Why one of this component's Provider values cannot be expressed in the scope that renders it (state, a setter, a
/// handler or arrow, JSX, a loop value, a store, a name of the body that is not a derived value or a module name).
pub fn provider_problem(ir: &crate::ir::ComponentIR) -> Option<(u32, String)> {
    provider_problem_in(ir, false)
}

/// R34.116: what a NATIVE Provider cannot hand out. State, a setter, a derived value over state, a handler and an arrow
/// are members of its own instance and are fine; JSX, a loop value, a store, an import read as a value, a module
/// function read as a value and verbatim code outside the subset are not.
pub fn native_provider_problem(ir: &crate::ir::ComponentIR) -> Option<(u32, String)> {
    provider_problem_in(ir, true)
}

/// Whether every field of every Provider this component renders is a plain value of its call site (S2, §3.2): such a
/// frame is substituted at the call site. Any other (and not refused) frame is a native frame (R34.116).
pub fn frames_are_plain(ir: &crate::ir::ComponentIR) -> bool {
    provider_problem_in(ir, false).is_none()
}

fn provider_problem_in(ir: &crate::ir::ComponentIR, native: bool) -> Option<(u32, String)> {
    for p in &ir.provides {
        for (k, v) in &p.fields {
            if let Some(why) = field_bad(ir, v, 0, false, native) {
                return Some((v.loc, format!("`{k}` reading {why}")));
            }
        }
    }
    None
}

/// Why `r` is not an acceptable Provider field value (`None`: fine). `callee`: the identifier is the function being
/// called (a helper of the Provider's module is fine there). `native`: members of the Provider's own instance are fine.
fn field_bad(
    ir: &crate::ir::ComponentIR,
    r: &crate::ir::RawExpr,
    depth: u8,
    callee: bool,
    native: bool,
) -> Option<String> {
    use crate::ir::{Expr, IdentKind, RawKind};
    if depth > 8 {
        return Some("a chain of derived values deeper than 8".into());
    }
    let bad = |x: &crate::ir::RawExpr| field_bad(ir, x, depth, false, native);
    match &r.kind {
        RawKind::Lit(_) => None,
        RawKind::Ident { name, kind } => match kind {
            IdentKind::Prop | IdentKind::Global => None,
            // F-fix (Mellow): an imported binding read as a VALUE may be an element (`value={{ icon: el }}`), which the
            // consumer would print as nothing; only a called helper is fine.
            IdentKind::Import { .. } if callee => None,
            IdentKind::Import { .. } => Some(format!("`{name}`, an import read as a value")),
            IdentKind::State | IdentKind::Setter if native => None,
            IdentKind::Local => {
                if let Some(d) = ir.derived.iter().find(|d| &d.name == name) {
                    return match &d.expr {
                        Expr::Raw(e) => field_bad(ir, e, depth + 1, false, native),
                        _ => Some(format!("`{name}`, which is not a plain expression")),
                    };
                }
                // A handler (`useCallback`) is a member of the instance: a native frame hands it out.
                if native && ir.handlers.iter().any(|h| &h.name == name) {
                    return None;
                }
                // A module const is judged by its value (a JSX element, an import or a call there is not a plain value).
                if let Some(c) = ir
                    .module_decls
                    .iter()
                    .flat_map(|d| &d.consts)
                    .find(|c| &c.name == name)
                {
                    return field_bad(ir, &c.value, depth + 1, false, native)
                        .map(|w| format!("`{name}`, a module const holding {w}"));
                }
                if callee && ir.module_scope.iter().any(|(n, _)| n == name) {
                    None
                } else if ir.module_scope.iter().any(|(n, _)| n == name) {
                    Some(format!("`{name}`, a module function read as a value"))
                } else {
                    Some(format!("`{name}`, a local of the component"))
                }
            }
            _ => Some(format!(
                "`{name}`, which is state, a handler or a loop value"
            )),
        },
        RawKind::Member { target, .. } => bad(target),
        RawKind::Index { target, index } => bad(target).or_else(|| bad(index)),
        RawKind::Call { callee, args } => {
            field_bad(ir, callee, depth, true, native).or_else(|| args.iter().find_map(bad))
        }
        RawKind::Binary { left, right, .. } => bad(left).or_else(|| bad(right)),
        RawKind::Unary { value, .. } => bad(value),
        RawKind::Cond { test, yes, no } => bad(test).or_else(|| bad(yes)).or_else(|| bad(no)),
        RawKind::Template { parts, .. } => parts.iter().find_map(|(p, _)| bad(p)),
        RawKind::Array(xs) => xs.iter().find_map(bad),
        RawKind::Object(ps) => ps.iter().find_map(|(_, v)| bad(v)),
        // An arrow is a handler member of the instance in a native frame.
        RawKind::Arrow { .. } if native => None,
        RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => {
            Some("a function or an expression outside the subset".into())
        }
    }
}

/// F1 (Mellow): a context field becomes part of an identifier (`__ctx_<ctx>_<field>`) in the job module and the
/// template, so a key that is not a plain identifier (`'x-y'`) would print as an expression. Same rule as props.
pub fn field_problem(field: &str) -> Option<&'static str> {
    crate::analyze::names::template_name_problem(field).map(|(_, what)| what)
}
