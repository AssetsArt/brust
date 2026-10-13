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
    let root_text = source.clone();
    let root = analyze_with(path, source, opts, &modules)?;
    let done = modules.borrow().done();
    let by_id: HashMap<String, Rc<ComponentIR>> = done
        .iter()
        .map(|(_, ir)| (ir.id.clone(), ir.clone()))
        .collect();
    let resolve = |id: &str| by_id.get(id).map(|rc| rc.as_ref());
    let linked_ids: std::collections::HashSet<String> = done
        .iter()
        .flat_map(|(_, ir)| ir.child_links.iter().map(|l| l.child.clone()))
        .collect();
    let linked = |id: &str| linked_ids.contains(id);
    let ctx = LowerCtx {
        resolve: &resolve,
        runtime_import,
        linked: &linked,
    };
    let root_rc = by_id
        .get(&root.id)
        .cloned()
        .unwrap_or_else(|| Rc::new(root));
    let mut out = vec![Lowered {
        artifacts: locate(lower(&root_rc, &ctx)?, &root_rc, opts, root_text.as_deref()),
        ir: root_rc.clone(),
    }];
    for (_, ir) in done {
        if ir.id == root_rc.id {
            continue;
        }
        out.push(Lowered {
            artifacts: locate(lower(&ir, &ctx)?, &ir, opts, None),
            ir,
        });
    }
    Ok(out)
}

/// Lowering diagnostics carry only a byte offset; resolve line and column from the component's source
/// (`text` when the caller supplied it, else the file under `opts.root`).
fn locate(
    mut a: Artifacts,
    ir: &ComponentIR,
    opts: &AnalyzeOptions,
    text: Option<&[u8]>,
) -> Artifacts {
    if a.diagnostics.iter().all(|d| d.line != 0 || d.loc == 0) {
        return a;
    }
    let read: Vec<u8>;
    let text = match text {
        Some(t) => t,
        None => match std::fs::read(opts.root.join(&ir.source)) {
            Ok(b) => {
                read = b;
                &read
            }
            Err(_) => return a,
        },
    };
    for d in a.diagnostics.iter_mut().filter(|d| d.line == 0) {
        (d.line, d.col) = crate::ir::line_col(text, d.loc);
    }
    a
}
