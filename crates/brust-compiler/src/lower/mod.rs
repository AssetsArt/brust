//! Lowering (spec §4.4, §6, §7): a complete `ComponentIR` to the three
//! artifacts — the minijinja template Rust renders, the precompute job module
//! (`.server.ts`) and the react-free directive chunk (`.client.js`). Consumes
//! only the IR: nothing here names a Bun type (`tests/lower_template.rs`
//! checks the sources).
pub mod client;
pub mod common;
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
}

pub const DEFAULT_RUNTIME_IMPORT: &str = "brust/runtime-dom";

#[derive(Debug, Clone, Default)]
pub struct Artifacts {
    pub jinja: String,
    pub server_ts: Option<String>,
    pub client_js: Option<String>,
    /// Every member the chunk exports, in order.
    pub members: Vec<String>,
    /// Warnings found while lowering (refused attributes).
    pub diagnostics: Vec<Diagnostic>,
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
    },
    /// `_lN`: a list source.
    List { raw: RawExpr },
    /// `_kN`: the key function of a list.
    Key { raw: RawExpr, item: String },
    /// `_pN`: the props object of a linked child.
    Link {
        props: Vec<(String, RawExpr)>,
        bindings: Vec<String>,
    },
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
            format!(
                "<brust-island data-brust-island=\"{}\" data-props='{{{{ _props | json_attr }}}}'></brust-island>",
                ir.id
            )
        } else {
            format!("{{{{ _ssr_{} | safe }}}}", ir.id)
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
    let printer = template::Printer::new(ir, ctx, None, &loop_var)
        .ok_or_else(|| Diagnostic::error("lower-input", "structural snapshot missing", 0, ""))?;
    let out = printer.print();
    if let Some(d) = out
        .diagnostics
        .iter()
        .find(|d| d.class == crate::ir::DiagClass::Error)
    {
        return Err(d.clone());
    }
    let server_ts = server::job(ir);
    let (client_js, members) = if matches!(ir.tier, Tier::Static) {
        (None, Vec::new())
    } else {
        let (js, members) = client::chunk(ir, &out.members, ctx.runtime_import);
        (Some(js), members)
    };
    Ok(Artifacts {
        jinja: out.jinja,
        server_ts,
        client_js,
        members,
        diagnostics: out.diagnostics,
    })
}
