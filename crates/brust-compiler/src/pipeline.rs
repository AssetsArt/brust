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
        artifacts: locate(
            lower(&root_rc, &ctx)
                .map_err(|d| in_module(d, &root_rc, opts, root_text.as_deref()))?,
            &root_rc,
            opts,
            root_text.as_deref(),
        ),
        ir: root_rc.clone(),
    }];
    // F153c: a package component compiled from source whose import fell back to the published export's island
    // (or an island only such a component asked for) is not part of the tree: never lowered, never bundled.
    let reachable = reachable_from(&root_rc, &by_id);
    for (_, ir) in done {
        if ir.id == root_rc.id {
            continue;
        }
        if (crate::analyze::modules::is_package_source(&ir.source) || ir.external.is_some())
            && !reachable.contains(&ir.id)
        {
            continue;
        }
        // R34.122: a Provider that only exists as a React island because its state frame needs a native provider is
        // not part of the tree when every call site was specialised (nothing references it).
        if !reachable.contains(&ir.id)
            && (ir.specialised
                || (!ir.provides.is_empty()
                    && ir.diagnostics.iter().any(|d| d.rule == "context-state")))
        {
            continue;
        }
        out.push(Lowered {
            artifacts: locate(
                lower(&ir, &ctx).map_err(|d| in_module(d, &ir, opts, None))?,
                &ir,
                opts,
                None,
            ),
            ir,
        });
    }
    Ok(out)
}

/// The ids of every component the tree under `root` renders: its children, the components lowered into an
/// island's children, and linked children.
fn reachable_from(
    root: &Rc<ComponentIR>,
    by_id: &HashMap<String, Rc<ComponentIR>>,
) -> std::collections::HashSet<String> {
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![root.id.clone()];
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(ir) = by_id.get(&id) else { continue };
        for c in &ir.children {
            stack.extend(c.id.iter().cloned());
            stack.extend(c.nested.iter().flatten().cloned());
        }
        stack.extend(ir.child_links.iter().map(|l| l.child.clone()));
    }
    seen
}

/// Lowering diagnostics carry only a byte offset; resolve line and column from the source the offset points into: the
/// module the diagnostic names (`file`, an inlined component from another file, F395), else the component's own
/// source (`text` when the caller supplied it, else the file under `opts.root`).
fn locate(
    mut a: Artifacts,
    ir: &ComponentIR,
    opts: &AnalyzeOptions,
    text: Option<&[u8]>,
) -> Artifacts {
    let mut read = HashMap::new();
    for d in &mut a.diagnostics {
        locate_one(d, ir, opts, text, &mut read);
    }
    a
}

type Read = HashMap<String, Option<Vec<u8>>>;

fn locate_one(
    d: &mut Diagnostic,
    ir: &ComponentIR,
    opts: &AnalyzeOptions,
    text: Option<&[u8]>,
    read: &mut Read,
) {
    if d.line != 0 || d.loc == 0 {
        return;
    }
    let own = d.file.as_deref().is_none_or(|f| f == ir.source);
    let found: Option<&[u8]> = match (own, text) {
        (true, Some(t)) => Some(t),
        _ => {
            let file = d.file.clone().unwrap_or_else(|| ir.source.clone());
            read.entry(file.clone())
                .or_insert_with(|| std::fs::read(opts.root.join(&file)).ok())
                .as_deref()
        }
    };
    if let Some(t) = found {
        (d.line, d.col) = crate::ir::line_col(t, d.loc);
    }
}

/// F395: a lowering error names the module it was raised in (the tree error has no component to take it from), with
/// its line and column resolved in that module.
fn in_module(
    mut d: Diagnostic,
    ir: &ComponentIR,
    opts: &AnalyzeOptions,
    text: Option<&[u8]>,
) -> Diagnostic {
    d.file.get_or_insert_with(|| ir.source.clone());
    locate_one(&mut d, ir, opts, text, &mut HashMap::new());
    d
}
