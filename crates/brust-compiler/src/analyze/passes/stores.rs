//! Stores pass (M3-F D7): resolves each `useStore` handle to the `defineStore('<name>', …)` it
//! names, through the handle's import (`analyze/stores.rs`). An unresolved handle is a
//! `store-name-unresolved` fallback (the tier pass then makes the component React); the same
//! name defined by two modules in one compile is a `store-name-duplicate` warning.
use super::PassCtx;
use crate::analyze::modules::resolve as resolve_module;
use crate::analyze::stores::read_store_export;
use crate::ir::{ComponentIR, Diagnostic, StoreRef};

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
    ir.diagnostics.extend(diags);
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
