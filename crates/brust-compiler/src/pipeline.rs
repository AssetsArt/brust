//! Source to artifacts: analysis (with every child compiled through one module
//! cache) followed by lowering of each compiled component.
use crate::analyze::component::{AnalyzeOptions, analyze_with};
use crate::analyze::modules::ModuleCache;
use crate::ir::{ComponentIR, Diagnostic};
use crate::lower::{Artifacts, LowerCtx, lower};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// One compiled component and its artifacts.
pub struct Lowered {
    pub ir: Rc<ComponentIR>,
    pub artifacts: Artifacts,
}

/// Analyses `path` (`source` when the caller has the text) and lowers it and
/// every child it compiled; the root comes first, children by module key.
/// Call it inside [`crate::parse::run_on_compiler_thread`].
pub fn compile_tree(
    path: &str,
    source: Option<Vec<u8>>,
    opts: &AnalyzeOptions,
    runtime_import: &str,
) -> Result<Vec<Lowered>, Diagnostic> {
    let modules = RefCell::new(ModuleCache::default());
    let root = analyze_with(path, source, opts, &modules)?;
    let done = modules.borrow().done();
    let by_id: HashMap<String, Rc<ComponentIR>> = done
        .iter()
        .map(|(_, ir)| (ir.id.clone(), ir.clone()))
        .collect();
    let resolve = |id: &str| by_id.get(id).map(|rc| rc.as_ref());
    let ctx = LowerCtx {
        resolve: &resolve,
        runtime_import,
    };
    let root_rc = by_id
        .get(&root.id)
        .cloned()
        .unwrap_or_else(|| Rc::new(root));
    let mut out = vec![Lowered {
        artifacts: lower(&root_rc, &ctx)?,
        ir: root_rc.clone(),
    }];
    for (_, ir) in done {
        if ir.id == root_rc.id {
            continue;
        }
        out.push(Lowered {
            artifacts: lower(&ir, &ctx)?,
            ir,
        });
    }
    Ok(out)
}
