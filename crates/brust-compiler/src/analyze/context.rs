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
                    B::BIdentifier(id) => {
                        if table.is_react_call(&call.target, "createContext") {
                            let name = table.local_name(id.r#ref);
                            out.providers.insert(table.key_of(id.r#ref), name.clone());
                            out.react.insert(table.key_of(id.r#ref), name);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}
