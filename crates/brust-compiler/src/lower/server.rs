//! Server backend (spec §6.4): the precompute job module — a pure function of
//! its declared inputs returning the `_sN` slots. Printed from the original
//! expressions (`to_js` server context), with the user's imports and module
//! helpers kept verbatim; state seeds and the derived values the slots reach
//! are `const`s in source order (M1c inputs 1–2).
use super::common::{
    Facts, ImportUse, import_lines, imports_in, module_code, module_names_in, server_js,
};
use crate::ir::{
    Attr, ComponentIR, Expr, IdentKind, JobDecl, JobKind, Node, RawExpr, Structural,
    expr::js_string,
};
use std::collections::BTreeSet;

/// One precompute slot: its expression and the lists it sits in (outermost first).
struct Slot {
    name: String,
    raw: RawExpr,
    lists: Vec<(RawExpr, String, Option<String>)>,
    /// Enclosing conditions (list depth, condition, negated): React never
    /// evaluates a branch it does not render, so neither does the job.
    guards: Vec<Guard>,
}

type Guard = (usize, RawExpr, bool);

/// Walk state: the enclosing lists and conditions.
#[derive(Default)]
struct Ctx {
    lists: Vec<(RawExpr, String, Option<String>)>,
    guards: Vec<Guard>,
}

/// What the precompute job module is built from, before any printing.
struct Plan<'a> {
    f: Facts<'a>,
    job: &'a JobDecl,
    structural: &'a Structural,
    slots: Vec<Slot>,
    slot_of_const: Vec<(String, String)>,
    inits: Vec<Option<RawExpr>>,
    derived: Vec<(&'a str, &'a RawExpr)>,
    imports: BTreeSet<ImportUse>,
    module: String,
    /// The module-level names the job prints (`module_need`).
    need: BTreeSet<String>,
    props: BTreeSet<String>,
}

/// The imports the precompute job module of `ir` declares (user imports its slots, seeds,
/// derived values and module helpers read); `None` without a precompute job.
pub fn job_imports(ir: &ComponentIR) -> Option<BTreeSet<ImportUse>> {
    plan(ir).map(|p| p.imports)
}

fn plan(ir: &ComponentIR) -> Option<Plan<'_>> {
    let job = ir
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Precompute))?;
    let structural = ir.structural.as_deref()?;
    let f = Facts::new(ir, structural);

    let mut slots: Vec<Slot> = Vec::new();
    collect(
        &ir.template,
        &structural.template,
        &mut Ctx::default(),
        &mut slots,
    );
    // Seeds and derived values that are slots read their own const.
    let mut slot_of_const: Vec<(String, String)> = Vec::new();
    for (s, ss) in ir.state.iter().zip(&structural.state) {
        if let (Expr::Precomputed { slot, .. }, Expr::Raw(_)) = (&s.init, &ss.init) {
            slot_of_const.push((slot.clone(), s.name.clone()));
        }
    }
    for d in &ir.derived {
        if let Expr::Precomputed { slot, .. } = &d.expr {
            slot_of_const.push((slot.clone(), d.name.clone()));
        }
    }

    // What the job runs: slots, every seed, and the derived values they reach.
    let inits: Vec<Option<RawExpr>> = (0..ir.state.len()).map(|i| f.state_init(i)).collect();
    let mut roots: Vec<&RawExpr> = slots.iter().map(|s| &s.raw).collect();
    for s in &slots {
        roots.extend(s.lists.iter().map(|l| &l.0));
        roots.extend(s.guards.iter().map(|g| &g.1));
    }
    roots.extend(inits.iter().flatten());
    roots.extend(fused_defaults(ir, &f));
    let mut reached = f.reach(&roots);
    for (_, name) in &slot_of_const {
        if f.derived.contains_key(name) {
            reached.insert(name.clone());
            reached.extend(f.reach(&[f.derived_raw(name)?]));
        }
    }
    let derived: Vec<(&str, &RawExpr)> = structural
        .derived
        .iter()
        .filter(|d| reached.contains(&d.name))
        .filter_map(|d| f.derived_raw(&d.name).map(|r| (d.name.as_str(), r)))
        .collect();

    let mut imports = BTreeSet::new();
    let mut module_names = BTreeSet::new();
    let mut props = BTreeSet::new();
    for r in roots.iter().copied().chain(derived.iter().map(|d| d.1)) {
        imports_in(r, &mut imports);
        module_names_in(r, &f, &mut module_names);
        super::common::visit_idents(r, &mut |name, kind| {
            if *kind == IdentKind::Prop {
                props.insert(name.to_string());
            }
        });
    }
    let need = super::common::module_need(ir, &module_names, &mut imports);
    let module = module_code(ir, &module_names, &mut imports);
    Some(Plan {
        need,
        f,
        job,
        structural,
        slots,
        slot_of_const,
        inits,
        derived,
        imports,
        module,
        props,
    })
}

/// What the precompute job module of `ir` reads (F149, R34.89): the classifier of build-evaluated
/// instances decides from this whether the job may run at build. `None` without a precompute job.
pub struct JobReads {
    /// The imports the module declares, its module helpers' included.
    pub imports: BTreeSet<ImportUse>,
    /// Globals the slots, derived values and module helpers read.
    pub globals: BTreeSet<String>,
    /// Some slot is computed per list item.
    pub per_item: bool,
    /// Every expression the module evaluates, module helpers' consts included (to look for
    /// `Math.random`, opaque code and block bodies).
    pub exprs: Vec<RawExpr>,
    /// Module declarations the job prints that are not plain `const` bindings read as expressions
    /// (a function, a `let`), by their first name.
    pub opaque_decls: Vec<String>,
}

pub fn job_reads(ir: &ComponentIR) -> Option<JobReads> {
    let p = plan(ir)?;
    let mut globals = BTreeSet::new();
    let mut exprs: Vec<RawExpr> = Vec::new();
    let mut roots: Vec<&RawExpr> = p.slots.iter().map(|s| &s.raw).collect();
    for s in &p.slots {
        roots.extend(s.lists.iter().map(|l| &l.0));
        roots.extend(s.guards.iter().map(|g| &g.1));
    }
    roots.extend(p.inits.iter().flatten());
    roots.extend(p.derived.iter().map(|d| d.1));
    roots.extend(fused_defaults(ir, &p.f));
    for r in &roots {
        super::common::visit_idents(r, &mut |name, kind| {
            if matches!(kind, IdentKind::Global | IdentKind::Unknown) {
                globals.insert(name.to_string());
            }
        });
        exprs.push((*r).clone());
    }
    // The module helpers the job prints (`module_code`), with what they read.
    let mut opaque_decls = Vec::new();
    for d in &ir.module_decls {
        if !d.names.iter().any(|n| p.need.contains(n)) {
            continue;
        }
        if d.consts.len() != d.names.len() || !d.source.starts_with("const ") {
            opaque_decls.extend(d.names.first().cloned());
        }
        for c in &d.consts {
            exprs.push(c.value.clone());
        }
        for n in &d.names {
            if let Some((_, caps)) = ir.module_scope.iter().find(|(m, _)| m == n) {
                for (c, k) in caps {
                    if matches!(k, IdentKind::Global | IdentKind::Unknown) {
                        globals.insert(c.clone());
                    }
                }
            }
        }
    }
    Some(JobReads {
        imports: p.imports,
        globals,
        per_item: p.slots.iter().any(|s| !s.lists.is_empty()),
        exprs,
        opaque_decls,
    })
}

pub fn job(ir: &ComponentIR) -> Option<String> {
    let Plan {
        f,
        job,
        structural,
        slots,
        slot_of_const,
        inits,
        derived,
        imports,
        module,
        props,
        ..
    } = plan(ir)?;
    let mut out = format!(
        "// generated by brust v2 — precompute job for {}; pure function of its inputs\n",
        ir.id
    );
    out.push_str(&import_lines(&imports));
    // R34.96: the job modules of the fused children, one import per child id (the bundler resolves
    // `brust-job:<id>` to that component's own job module).
    let fused_mods: Vec<&str> = ir.fused.iter().fold(Vec::new(), |mut v, f| {
        if !v.contains(&f.child_id.as_str()) {
            v.push(f.child_id.as_str());
        }
        v
    });
    for (i, id) in fused_mods.iter().enumerate() {
        out.push_str(&format!(
            "import {{ precompute as __fj{i} }} from {}\n",
            js_string(&format!("brust-job:{id}"))
        ));
    }
    out.push_str(&module);
    out.push_str(&format!(
        "export const inputs = [{}] as const\n",
        job.inputs
            .iter()
            .map(|i| js_string(i))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    out.push_str("export function precompute(props: any) {\n");
    // Props by local name (a renamed prop: `title: heading`). A prop the call site left out is absent
    // (brust-core leaves a missing input out, F149/F151), so a default is the JS destructuring default:
    // it applies to `undefined` only, and an explicit `null` stays `null`, as in React.
    let mut run: Vec<String> = Vec::new();
    let flush = |out: &mut String, run: &mut Vec<String>| {
        if !run.is_empty() {
            out.push_str(&format!("  const {{ {} }} = props\n", run.join(", ")));
            run.clear();
        }
    };
    if props.contains("*")
        && let Some(local) = f.prop_locals.get("*")
        && local != "props"
    {
        out.push_str(&format!("  const {local} = props\n"));
    }
    for p in &props {
        if p == "*" {
            continue;
        }
        let local = f.prop_locals.get(p).cloned().unwrap_or_else(|| p.clone());
        match f.prop_defaults.get(p) {
            Some(d) => {
                flush(&mut out, &mut run);
                let binding = if local == *p {
                    p.clone()
                } else {
                    format!("{p}: {local}")
                };
                out.push_str(&format!(
                    "  const {{ {binding} = ({}) }} = props\n",
                    server_js(d, &f)
                ));
            }
            None if local != *p => run.push(format!("{p}: {local}")),
            None => run.push(p.clone()),
        }
    }
    flush(&mut out, &mut run);
    let mut decls: Vec<(u32, String)> = Vec::new();
    for (i, s) in ir.state.iter().enumerate() {
        if let Some(r) = &inits[i] {
            let loc = structural.state[i].init.raw_loc().unwrap_or_default();
            decls.push((loc, format!("const {} = {}", s.name, server_js(r, &f))));
        }
    }
    for (name, r) in &derived {
        decls.push((r.loc, format!("const {name} = {}", server_js(r, &f))));
    }
    decls.sort_by_key(|d| d.0);
    for (_, line) in decls {
        out.push_str(&format!("  {line}\n"));
    }
    let mut entries: Vec<(u32, String)> = Vec::new();
    for s in &slots {
        let guard = |js: String, level: usize| -> String {
            let conds: Vec<String> = s
                .guards
                .iter()
                .filter(|g| g.0 == level)
                .map(|(_, c, neg)| {
                    let c = server_js(c, &f);
                    if *neg {
                        format!("!({c})")
                    } else {
                        format!("({c})")
                    }
                })
                .collect();
            if conds.is_empty() {
                js
            } else {
                format!("({} ? {js} : null)", conds.join(" && "))
            }
        };
        let mut js = guard(server_js(&s.raw, &f), s.lists.len());
        for (level, (src, item, index)) in s.lists.iter().enumerate().rev() {
            let params = match index {
                Some(i) => format!("{item}, {i}"),
                None => item.clone(),
            };
            js = guard(
                format!("({}).map(({params}) => {js})", server_js(src, &f)),
                level,
            );
        }
        entries.push((slot_num(&s.name), format!("{}: {js}", s.name)));
    }
    for (slot, name) in &slot_of_const {
        entries.push((slot_num(slot), format!("{slot}: {name}")));
    }
    entries.sort_by_key(|e| e.0);
    let own = entries
        .into_iter()
        .map(|e| e.1)
        .collect::<Vec<_>>()
        .join(", ");
    if ir.fused.is_empty() {
        out.push_str(&format!("  return {{ {own} }}\n}}\n"));
        return Some(out);
    }
    // R34.96: each fused child's job runs after this component's own slots, with the inputs the
    // analysis bound; its slots come back under this job's output names.
    out.push_str(&format!("  const __own = {{ {own} }}\n"));
    // A prop the call site reads through this component's own destructuring default (`orientation =
    // "vertical"`) gets that default when absent, as the local the JSX read does.
    let p_default = |root: &str| f.prop_defaults.get(root).map(|d| server_js(d, &f));
    let mut fused_out: Vec<String> = Vec::new();
    for (n, f) in ir.fused.iter().enumerate() {
        let m = fused_mods.iter().position(|id| *id == f.child_id)?;
        out.push_str(&format!(
            "  const __f{n} = __fj{m}({{ {} }})\n",
            fused_args(&f.inputs, &|root| p_default(root))
        ));
        for (slot, name) in &f.outputs {
            fused_out.push(format!("{}: __f{n}[{}]", js_string(name), js_string(slot)));
        }
    }
    out.push_str(&format!(
        "  return {{ ...__own, {} }}\n}}\n",
        fused_out.join(", ")
    ));
    Some(out)
}

/// The destructuring defaults of this component's props that a fused child's `Prop` input reads
/// (R34.96): the job prints them, so they are roots too (their imports, module names, globals).
fn fused_defaults<'a>(ir: &ComponentIR, f: &'a Facts<'_>) -> Vec<&'a RawExpr> {
    let mut out = Vec::new();
    for fi in &ir.fused {
        for v in fi.inputs.values() {
            if let crate::ir::FusedInput::Prop { path } = v {
                let root = path.split(['.', '[']).next().unwrap_or(path);
                if let Some(d) = f.prop_defaults.get(root) {
                    out.push(d);
                }
            }
        }
    }
    out
}

/// The props object a fused child's job is called with (R34.96): an `Undefined` input is left out, so
/// the child's destructuring default applies (A3); a literal keeps `null`; a prop reads this
/// component's props as the call site's JSX did; a slot is this component's own result.
fn fused_args(
    inputs: &std::collections::BTreeMap<String, crate::ir::FusedInput>,
    default: &dyn Fn(&str) -> Option<String>,
) -> String {
    use crate::ir::FusedInput;
    inputs
        .iter()
        .filter_map(|(k, v)| {
            let js = match v {
                FusedInput::Undefined => return None,
                FusedInput::Literal { value } => {
                    serde_json::to_string(value).unwrap_or_else(|_| "undefined".into())
                }
                FusedInput::Slot { name } => format!("__own[{}]", js_string(name)),
                FusedInput::Prop { path } => props_path_js(path, default),
            };
            Some(format!("{}: {js}", js_string(k)))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `config.size` / `items[0].id` as a read of the job's `props` (`props["config"]["size"]`): every
/// segment is printed as a string or number index, never as code.
fn props_path_js(path: &str, default: &dyn Fn(&str) -> Option<String>) -> String {
    let mut js = String::from("props");
    for (i, part) in path.split('.').enumerate() {
        // The root: `props["p"]`, or with a destructuring default `(props["p"] === undefined ? (d) : props["p"])`.
        if i == 0 {
            let (name, rest) = part.split_once('[').map_or((part, ""), |(n, r)| (n, r));
            let read = format!("props[{}]", js_string(name));
            js = match default(name) {
                Some(d) => format!("({read} === undefined ? ({d}) : {read})"),
                None => read,
            };
            index_js(&mut js, rest);
            continue;
        }
        let (name, rest) = part.split_once('[').map_or((part, ""), |(n, r)| (n, r));
        if !name.is_empty() {
            js.push_str(&format!("[{}]", js_string(name)));
        }
        index_js(&mut js, rest);
    }
    js
}

/// The `[0][1]` tail of a path segment (`rest` is what follows its first `[`).
fn index_js(js: &mut String, rest: &str) {
    for idx in rest.split('[') {
        let idx = idx.trim_end_matches(']');
        if !idx.is_empty() {
            match idx.parse::<u64>() {
                Ok(i) => js.push_str(&format!("[{i}]")),
                Err(_) => js.push_str(&format!("[{}]", js_string(idx))),
            }
        }
    }
}

/// The build-time evaluation module (L2): one thunk per `ir.build_eval` slot, keyed by
/// `BuildEvalSlot.key`, with the imports, module helpers and derived constants the slots read.
/// The build bundles and runs it once; `None` when nothing qualifies.
pub fn eval_module(ir: &ComponentIR) -> Option<String> {
    if ir.build_eval.is_empty() {
        return None;
    }
    let structural = ir.structural.as_deref()?;
    let f = Facts::new(ir, structural);
    let mut slots: Vec<Slot> = Vec::new();
    collect(
        &ir.template,
        &structural.template,
        &mut Ctx::default(),
        &mut slots,
    );
    // A candidate can also be a state seed or a derived value: those are slots of their own.
    let mut extra: Vec<(String, RawExpr)> = Vec::new();
    for (s, ss) in ir.state.iter().zip(&structural.state) {
        if let (Expr::Precomputed { slot, .. }, Expr::Raw(_)) = (&s.init, &ss.init)
            && let Some(r) = f.state_init(ir.state.iter().position(|x| x.name == s.name)?)
        {
            extra.push((slot.clone(), r));
        }
    }
    for d in &ir.derived {
        if let Expr::Precomputed { slot, .. } = &d.expr
            && let Some(r) = f.derived_raw(&d.name)
        {
            extra.push((slot.clone(), r.clone()));
        }
    }
    let mut chosen: Vec<(&crate::ir::BuildEvalSlot, RawExpr)> = Vec::new();
    for c in &ir.build_eval {
        let raw = slots
            .iter()
            .find(|s| s.name == c.slot)
            .map(|s| s.raw.clone())
            .or_else(|| {
                extra
                    .iter()
                    .find(|(n, _)| *n == c.slot)
                    .map(|(_, r)| r.clone())
            });
        if let Some(raw) = raw {
            chosen.push((c, raw));
        }
    }
    if chosen.is_empty() {
        return None;
    }
    let roots: Vec<&RawExpr> = chosen.iter().map(|(_, r)| r).collect();
    let reached = f.reach(&roots);
    let derived: Vec<(&str, &RawExpr)> = structural
        .derived
        .iter()
        .filter(|d| reached.contains(&d.name))
        .filter_map(|d| f.derived_raw(&d.name).map(|r| (d.name.as_str(), r)))
        .collect();
    let mut imports = BTreeSet::new();
    let mut module_names = BTreeSet::new();
    for r in roots.iter().copied().chain(derived.iter().map(|d| d.1)) {
        imports_in(r, &mut imports);
        module_names_in(r, &f, &mut module_names);
    }
    let module = module_code(ir, &module_names, &mut imports);
    let mut out = format!(
        "// generated by brust v2 — build-time evaluation for {}; run once by `brust build`\n",
        ir.id
    );
    out.push_str(&import_lines(&imports));
    out.push_str(&module);
    let mut consts: Vec<(u32, String)> = derived
        .iter()
        .map(|(name, r)| (r.loc, format!("const {name} = {}\n", server_js(r, &f))))
        .collect();
    consts.sort_by_key(|c| c.0);
    for (_, line) in consts {
        out.push_str(&line);
    }
    out.push_str("export const slots: Record<string, () => unknown> = {\n");
    for (c, raw) in &chosen {
        out.push_str(&format!(
            "  {}: () => ({}),\n",
            js_string(&c.key),
            server_js(raw, &f)
        ));
    }
    out.push_str("}\n");
    Some(out)
}

fn slot_num(s: &str) -> u32 {
    s.trim_start_matches("_s").parse().unwrap_or(0)
}

fn collect(n: &Node, s: &Node, cx: &mut Ctx, out: &mut Vec<Slot>) {
    let expr = |e: &Expr, se: &Expr, cx: &Ctx, out: &mut Vec<Slot>| {
        if let (Expr::Precomputed { slot, per_item, .. }, Expr::Raw(r)) = (e, se) {
            let (lists, guards) = if per_item.is_some() {
                (cx.lists.clone(), cx.guards.clone())
            } else {
                // A slot outside its lists is evaluated at the top level.
                (
                    Vec::new(),
                    cx.guards.iter().filter(|g| g.0 == 0).cloned().collect(),
                )
            };
            out.push(Slot {
                name: slot.clone(),
                raw: r.clone(),
                lists,
                guards,
            });
        }
    };
    match (n, s) {
        (
            Node::Element {
                attrs, children, ..
            },
            Node::Element {
                attrs: sa,
                children: sc,
                ..
            },
        ) => {
            for (a, b) in attrs.iter().zip(sa) {
                if let (
                    Attr::Dynamic { value, .. } | Attr::Spread(value) | Attr::InnerHtml { value },
                    Attr::Dynamic { value: sv, .. }
                    | Attr::Spread(sv)
                    | Attr::InnerHtml { value: sv },
                ) = (a, b)
                {
                    expr(value, sv, cx, out);
                }
            }
            for (c, d) in children.iter().zip(sc) {
                collect(c, d, cx, out);
            }
        }
        (Node::Slot(e), Node::Slot(se)) => expr(e, se, cx, out),
        (
            Node::If {
                cond, then, else_, ..
            },
            Node::If {
                cond: sc,
                then: st,
                else_: se,
                ..
            },
        ) => {
            expr(cond, sc, cx, out);
            let level = cx.lists.len();
            let cond_raw = match sc {
                Expr::Raw(r) => Some(r.clone()),
                _ => None,
            };
            for (branch, sbranch, negate) in [(then, st, false), (else_, se, true)] {
                if let Some(c) = &cond_raw {
                    cx.guards.push((level, c.clone(), negate));
                }
                for (c, d) in branch.iter().zip(sbranch) {
                    collect(c, d, cx, out);
                }
                if cond_raw.is_some() {
                    cx.guards.pop();
                }
            }
        }
        (
            Node::For {
                source,
                item,
                index,
                key,
                body,
            },
            Node::For {
                source: ss,
                key: sk,
                body: sb,
                ..
            },
        ) => {
            expr(source, ss, cx, out);
            if let Expr::Raw(sr) = ss {
                cx.lists.push((sr.clone(), item.clone(), index.clone()));
                expr(key, sk, cx, out);
                for (c, d) in body.iter().zip(sb) {
                    collect(c, d, cx, out);
                }
                cx.lists.pop();
            }
        }
        (
            Node::Component {
                props, children, ..
            },
            Node::Component {
                props: sp,
                children: sc,
                ..
            },
        ) => {
            for ((_, v), (_, sv)) in props.iter().zip(sp) {
                expr(v, sv, cx, out);
            }
            for (c, d) in children.iter().zip(sc) {
                collect(c, d, cx, out);
            }
        }
        (Node::Fragment(cs), Node::Fragment(ss)) => {
            for (c, d) in cs.iter().zip(ss) {
                collect(c, d, cx, out);
            }
        }
        _ => {}
    }
}
