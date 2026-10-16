//! `createCollection` of `@radix-ui/react-collection` (R34.140, the third structural recogniser): the module-level
//! `const [Collection, useCollection, createCollectionScope] = createCollection<…>(NAME)` binds
//! - `Collection`: an object whose members `Provider`, `Slot` and `ItemSlot` are elements the compiler lowers itself,
//! - `useCollection`: `useCollection(scope)` is the function that lists the items under the nearest collection root,
//! - `createCollectionScope`: a scope creator, only ever handed to `createContextScope(NAME, [createCollectionScope])`.
//!
//! The package is never read: the build pins it by version and by the hash of its published entry (`recognised.ts`), and
//! the compiler recognises this declaration only when the build reported the package as verified
//! (`PackageSources::recognised`). An import of any other version is a package the compiler cannot see into: the
//! components that use it stay React islands.
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashSet;

/// The recognised package.
pub const PACKAGE: &str = "@radix-ui/react-collection";
const FACTORY: &str = "createCollection";

/// The three bindings of the module's `createCollection` declarations, by symbol key.
#[derive(Default, Debug)]
pub struct Collections {
    /// `Collection` (the object of `Provider` / `Slot` / `ItemSlot`).
    pub objects: HashSet<u32>,
    /// `useCollection`.
    pub hooks: HashSet<u32>,
    /// `createCollectionScope`.
    pub scopes: HashSet<u32>,
}

impl Collections {
    pub fn is_empty(&self) -> bool {
        self.objects.is_empty() && self.hooks.is_empty() && self.scopes.is_empty()
    }
}

/// Reads the module's top-level `const [A, B, C] = createCollection(…)` where `createCollection` is the import of
/// [`PACKAGE`]. A different declaration shape (a rest, a hole, two names, another callee) is not recognised.
pub fn scan(table: &NameTable<'_>, ast: &js_ast::Ast<'_>) -> Collections {
    let mut out = Collections::default();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let S::SLocal(l) = &stmt.data else { continue };
            if !matches!(l.kind, js_ast::S::Kind::KConst) {
                continue;
            }
            for d in l.decls.iter() {
                let (B::BArray(arr), Some(value)) = (d.binding.data, &d.value) else {
                    continue;
                };
                let E::ECall(call) = &value.data else {
                    continue;
                };
                if !table.is_import_call(&call.target, PACKAGE, FACTORY) {
                    continue;
                }
                let items = arr.items();
                let ids: Vec<Option<js_ast::Ref>> = items
                    .iter()
                    .map(|i| match (i.binding.data, i.default_value.is_some()) {
                        (B::BIdentifier(id), false) => Some(id.r#ref),
                        _ => None,
                    })
                    .collect();
                if arr.has_spread || ids.len() != 3 || ids.iter().any(Option::is_none) {
                    continue;
                }
                // exactly one argument: the collection's name
                if call.args.len() != 1 {
                    continue;
                }
                out.objects.insert(table.key_of(ids[0].unwrap()));
                out.hooks.insert(table.key_of(ids[1].unwrap()));
                out.scopes.insert(table.key_of(ids[2].unwrap()));
            }
        }
    }
    out
}
