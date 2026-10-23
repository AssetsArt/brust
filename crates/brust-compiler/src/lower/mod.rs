//! Lowering (spec §4.4, §6, §7): a complete `ComponentIR` to the three
//! artifacts — the minijinja template Rust renders, the precompute job module
//! (`.server.ts`) and the react-free directive chunk (`.client.js`). Consumes
//! only the IR: nothing here names a Bun type (`tests/lower_template.rs`
//! checks the sources).
pub mod client;
pub mod common;
pub mod module_projection;
pub mod names;
pub mod render_debug;
pub mod server;
pub mod server_expr;
pub mod template;

use crate::ir::{ComponentIR, Diagnostic, RawExpr, Tier};
use std::cell::Cell;

pub struct LowerCtx<'a> {
    /// Child component id → its IR (from the analysis `ModuleCache`).
    pub resolve: &'a dyn Fn(&str) -> Option<&'a ComponentIR>,
    /// Module specifier the chunk imports the runtime from.
    pub runtime_import: &'a str,
    /// Whether some parent links the component with this id (`x-props-bind`):
    /// a static component then still gets directives and a chunk.
    pub linked: &'a dyn Fn(&str) -> bool,
    /// L23 / F407: the compile is provisional: some lucide icon is not rendered yet and is still an island job, and the
    /// build compiles again with the icons rendered (`AnalyzeOptions.icons_final`). A component that holds only icons
    /// looks fed here, so a `nested-instance` refusal is a warning; the final compile judges.
    pub icons_pending: bool,
}

pub const DEFAULT_RUNTIME_IMPORT: &str = "brust/runtime-dom";

#[derive(Debug, Clone, Default)]
pub struct Artifacts {
    pub jinja: String,
    pub server_ts: Option<String>,
    /// Build-time evaluation module for `ir.build_eval` slots (L2).
    pub eval_ts: Option<String>,
    pub client_js: Option<String>,
    /// F362 PR2: `client_js` importing every imported list as written, when `client_js` declares one projected instead.
    pub client_js_whole: Option<String>,
    /// F362 PR2: the data modules (paths from the root) whose imported list `client_js` declares projected.
    pub projected_modules: Vec<String>,
    /// Every member the chunk exports, in order.
    pub members: Vec<String>,
    /// R34.124: modules the chunk imports that are shared by name with other components' chunks (`<name>.js` beside
    /// it): (name, code). Equal code under one name is one file.
    pub client_modules: Vec<(String, String)>,
    /// Warnings found while lowering (refused attributes).
    pub diagnostics: Vec<Diagnostic>,
}

/// How a member's value is written, so the chunk normalises it the way the
/// server painted it (the runtime writes `String(v)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paint {
    /// `x-text`: booleans paint as empty, arrays concatenate (React).
    Text,
    /// `x-bind-<attr>`: a boolean removes the attribute, like `null` (React omits it on an attribute that is not a boolean one).
    Attr,
    /// `x-bind-<attr>` of `aria-*`, `data-*` and the other "booleanish string" attributes: `true`/`false` are the strings.
    AttrStr,
    /// `x-bind-download` / `capture`: `true` is `""`, `false` removes it.
    AttrOver,
    /// `x-bind-style` of a style object: the CSS text (`__css`).
    Style,
    /// A boolean attribute (`disabled`, `loop`, ...): the runtime sets it when truthy, so the chunk hands it `!!v`.
    Bool,
    /// Conditions: the value as is.
    Raw,
}

/// A client member a directive names, defined by the template walk.
#[derive(Debug, Clone)]
pub struct Member {
    pub name: String,
    pub def: MemberDef,
}

#[derive(Debug, Clone)]
pub enum MemberDef {
    /// `_cN`: a painted value; with `bindings` a function of the loop bindings.
    Value {
        raw: RawExpr,
        bindings: Vec<String>,
        negate: bool,
        paint: Paint,
    },
    /// `_lN`: a list source; with `bindings` a function of the outer loop
    /// bindings it reads (a nested list).
    List { raw: RawExpr, bindings: Vec<String> },
    /// `_kN`: the key function of a list.
    Key { raw: RawExpr, item: String },
    /// `_pN`: the props object of a linked child.
    Link {
        props: Vec<(String, RawExpr)>,
        bindings: Vec<String>,
    },
}

/// The react island host (S12): the runtime hydrates it from `x-props`; the SSR HTML sits inside. It takes no box
/// (`display:contents`, like brust-host/brust-row/brust-if), so a flex/grid `gap` never counts the wrapper (F413).
pub(crate) fn island_host(id: &str, props: &str, inner: &str) -> String {
    format!(
        "<brust-island style=\"display:contents\" data-id=\"{id}\" x-props='{{{{ {props} | json_attr }}}}'>{inner}</brust-island>"
    )
}

pub fn lower(ir: &ComponentIR, ctx: &LowerCtx<'_>) -> Result<Artifacts, Diagnostic> {
    // An IR with an Error (server-only code reached from the chunk, request
    // state in render, …) never becomes artifacts.
    if let Some(d) = ir
        .diagnostics
        .iter()
        .find(|d| d.class == crate::ir::DiagClass::Error)
    {
        return Err(d.clone());
    }
    if let Tier::React { client_only, .. } = &ir.tier {
        // The react backend (later spec) renders it; the template holds its slot.
        let jinja = if *client_only {
            island_host(&ir.id, "_props", "")
        } else {
            island_host(
                &ir.id,
                "_props",
                &format!("{{{{ _ssr_{} | safe }}}}", ir.id),
            )
        };
        return Ok(Artifacts {
            jinja,
            ..Default::default()
        });
    }
    if ir.structural.is_none() {
        return Err(Diagnostic::error(
            "lower-input",
            "lowering needs the IR straight from the analysis (structural snapshot missing)",
            0,
            "lower the IR returned by analyze_file / analyze_with",
        ));
    }
    let loop_var = Cell::new(0);
    // F233: one seed set per component for every output of this lowering (F247: computed once).
    let seeds = names::Seeds::default();
    let printer = template::Printer::new(ir, ctx, None, &loop_var, seeds.clone())
        .ok_or_else(|| Diagnostic::error("lower-input", "structural snapshot missing", 0, ""))?;
    let mut out = printer.print();
    if ctx.icons_pending {
        for d in &mut out.diagnostics {
            if d.class == crate::ir::DiagClass::Error && d.rule == "nested-instance" {
                d.class = crate::ir::DiagClass::Warning;
            }
        }
    }
    if let Some(d) = out
        .diagnostics
        .iter()
        .find(|d| d.class == crate::ir::DiagClass::Error)
    {
        return Err(d.clone());
    }
    let server_ts = server::job(ir);
    let eval_ts = server::eval_module(ir);
    let mut client_modules: Vec<(String, String)> = Vec::new();
    let mut client_js_whole = None;
    let mut projected_modules = Vec::new();
    let (client_js, members) = if matches!(ir.tier, Tier::Static) && !(ctx.linked)(&ir.id) {
        (None, Vec::new())
    } else {
        if ir.specialised {
            // R34.124: the factory is shared by every clone whose factory is equal; the chunk is a stub naming this one.
            let (code, members) =
                client::factory_module(ir, &out.members, ctx.runtime_import, &seeds.of(ir));
            let name = format!("spec-{:016x}", fnv64(code.as_bytes()));
            client_modules.push((name.clone(), code));
            (
                Some(client::stub(&ir.id, &name, ctx.runtime_import)),
                members,
            )
        } else {
            let (js, members, modules) =
                client::chunk(ir, &out.members, ctx.runtime_import, &seeds.of(ir));
            if !modules.is_empty() {
                client_js_whole = Some(client::chunk_whole(
                    ir,
                    &out.members,
                    ctx.runtime_import,
                    &seeds.of(ir),
                ));
                projected_modules = modules;
            }
            (Some(js), members)
        }
    };
    Ok(Artifacts {
        jinja: out.jinja,
        server_ts,
        eval_ts,
        client_js,
        client_js_whole,
        projected_modules,
        members,
        client_modules,
        diagnostics: out.diagnostics,
    })
}

/// 64-bit FNV-1a: stable across processes (std hashers are seeded per process). It names a shared factory module; the
/// build stops when two different codes meet under one name.
pub fn fnv64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}
