//! Client backend (spec §7.1): the react-free directive chunk, printed from
//! the IR — `defineBehavior(id, factory)` returning the members the template's
//! directives name.
use super::common::{
    DerivedShape, Facts, client_fn, client_js, import_lines, imports_in, module_code,
    module_names_in,
};
use super::{Member, MemberDef};
use crate::ir::{Attr, ComponentIR, Expr, Node, RawExpr};
use std::collections::BTreeSet;

/// The chunk source and its members in export order.
pub fn chunk(ir: &ComponentIR, members: &[Member], runtime_import: &str) -> (String, Vec<String>) {
    let Some(structural) = ir.structural.as_deref() else {
        return (String::new(), Vec::new());
    };
    let f = Facts::new(ir, structural);

    // Code roots: everything the chunk runs.
    let mut roots: Vec<&RawExpr> = Vec::new();
    let inits: Vec<Option<RawExpr>> = (0..ir.state.len()).map(|i| f.state_init(i)).collect();
    roots.extend(inits.iter().flatten());
    roots.extend(ir.handlers.iter().map(|h| &h.body));
    roots.extend(ir.effects.iter().map(|e| &e.body));
    for m in members {
        match &m.def {
            MemberDef::Value { raw, .. }
            | MemberDef::List { raw, .. }
            | MemberDef::Key { raw, .. } => roots.push(raw),
            MemberDef::Link { props, .. } => roots.extend(props.iter().map(|(_, r)| r)),
        }
    }
    let event_locals = event_handlers(&ir.template)
        .into_iter()
        .filter(|h| !ir.handlers.iter().any(|d| &d.name == h))
        .collect::<Vec<_>>();
    let mut reached = f.reach(&roots);
    reached.extend(
        event_locals
            .iter()
            .filter(|n| f.derived.contains_key(*n))
            .cloned(),
    );
    let reached_raws: Vec<&RawExpr> = reached.iter().filter_map(|n| f.derived_raw(n)).collect();

    let mut imports = BTreeSet::new();
    let mut module_names = BTreeSet::new();
    for r in roots.iter().chain(&reached_raws) {
        imports_in(r, &mut imports);
        module_names_in(r, &f, &mut module_names);
    }
    module_names.extend(ir.client_module_locals.iter().cloned());
    let module = module_code(ir, &module_names, &mut imports);

    // Body declarations in source order: seeds, refs, reached derived values.
    let mut decls: Vec<(u32, String)> = Vec::new();
    let mut uses_signal = false;
    let mut uses_computed = false;
    for (i, s) in ir.state.iter().enumerate() {
        let init = inits[i]
            .as_ref()
            .map_or("undefined".to_string(), |r| client_js(r, &f));
        let loc = structural.state[i].init.raw_loc().unwrap_or_default();
        decls.push((loc, format!("const {} = signal({init})", s.name)));
        uses_signal = true;
    }
    for (i, r) in ir.refs.iter().enumerate() {
        let loc = structural.refs[i].init.raw_loc().unwrap_or_default();
        decls.push((
            loc,
            format!(
                "const {} = ref({})",
                r.name,
                crate::ir::expr::js_string(&r.name)
            ),
        ));
    }
    for d in &structural.derived {
        if !reached.contains(&d.name) {
            continue;
        }
        let (Some(raw), Some((_, shape))) = (f.derived_raw(&d.name), f.derived.get(&d.name)) else {
            continue;
        };
        let line = match shape {
            DerivedShape::Value => {
                uses_computed = true;
                format!("const {} = computed(() => {})", d.name, client_js(raw, &f))
            }
            DerivedShape::Function => format!("const {} = {}", d.name, client_fn(raw, &f)),
        };
        decls.push((raw.loc, line));
    }
    decls.sort_by_key(|d| d.0);

    let mut body: Vec<String> = decls.into_iter().map(|d| d.1).collect();
    let mut exported: Vec<String> = Vec::new();
    // x-model writes the signal: every state is a member.
    exported.extend(ir.state.iter().map(|s| s.name.clone()));
    for h in &ir.handlers {
        let mut params: Vec<String> = h.item_scoped.clone();
        params.push("...a".into());
        body.push(format!(
            "const {} = ({}) => ({})(...a)",
            h.name,
            params.join(", "),
            client_fn(&h.body, &f)
        ));
        exported.push(h.name.clone());
    }
    exported.extend(
        event_locals
            .iter()
            .filter(|n| reached.contains(*n))
            .cloned(),
    );
    for m in members {
        let line = match &m.def {
            MemberDef::Value {
                raw,
                bindings,
                negate,
            } => {
                let js = client_js(raw, &f);
                let js = if *negate { format!("!({js})") } else { js };
                if bindings.is_empty() {
                    uses_computed = true;
                    format!("const {} = computed(() => {js})", m.name)
                } else {
                    format!("const {} = ({}) => {js}", m.name, bindings.join(", "))
                }
            }
            MemberDef::List { raw, bindings } if bindings.is_empty() => {
                uses_computed = true;
                format!("const {} = computed(() => {})", m.name, client_js(raw, &f))
            }
            MemberDef::List { raw, bindings } => format!(
                "const {} = ({}) => {}",
                m.name,
                bindings.join(", "),
                client_js(raw, &f)
            ),
            MemberDef::Key { raw, item } => {
                format!("const {} = ({item}) => {}", m.name, client_js(raw, &f))
            }
            MemberDef::Link { props, bindings } => {
                let fields: Vec<String> = props
                    .iter()
                    .filter(|(k, _)| k != "...")
                    .map(|(k, r)| {
                        let v = if super::common::is_function_raw(r)
                            || matches!(
                                &r.kind,
                                crate::ir::RawKind::Ident {
                                    kind: crate::ir::IdentKind::Setter,
                                    ..
                                }
                            ) {
                            client_fn(r, &f)
                        } else {
                            client_js(r, &f)
                        };
                        format!("{}: {v}", object_key(k))
                    })
                    .collect();
                let obj = format!("({{ {} }})", fields.join(", "));
                if bindings.is_empty() {
                    uses_computed = true;
                    format!("const {} = computed(() => {obj})", m.name)
                } else {
                    format!("const {} = ({}) => {obj}", m.name, bindings.join(", "))
                }
            }
        };
        body.push(line);
        exported.push(m.name.clone());
    }
    for e in &ir.effects {
        // The effect body is bound per run (a cleanup it returns passes through).
        body.push(format!("effect(() => ({})())", client_js(&e.body, &f)));
    }
    let mut seen = BTreeSet::new();
    exported.retain(|m| seen.insert(m.clone()));

    let mut rt = Vec::new();
    if uses_signal {
        rt.push("signal");
    }
    if uses_computed {
        rt.push("computed");
    }
    rt.push("defineBehavior");
    let mut out = format!("// generated by brust v2 — client chunk for {}\n", ir.id);
    out.push_str(&format!(
        "import {{ {} }} from {}\n",
        rt.join(", "),
        crate::ir::expr::js_string(runtime_import)
    ));
    out.push_str(&import_lines(&imports));
    out.push_str(&module);
    out.push_str(&format!(
        "export default defineBehavior({}, ({{ el, props, effect, onCleanup, ref }}) => {{\n",
        crate::ir::expr::js_string(&ir.id)
    ));
    for line in &body {
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(&format!("  return {{ {} }}\n}})\n", exported.join(", ")));
    (out, exported)
}

fn object_key(k: &str) -> String {
    let ident = k
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if ident {
        k.to_string()
    } else {
        crate::ir::expr::js_string(k)
    }
}

/// Handler names the template's `x-on-*` directives use.
fn event_handlers(n: &Node) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(n: &Node, out: &mut Vec<String>) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs {
                    if let Attr::Event { handler, .. } = a
                        && !out.contains(handler)
                    {
                        out.push(handler.clone());
                    }
                }
                children.iter().for_each(|c| walk(c, out));
            }
            Node::If { then, else_, .. } => then.iter().chain(else_).for_each(|c| walk(c, out)),
            Node::For { body, .. } => body.iter().for_each(|c| walk(c, out)),
            Node::Component { children, .. } | Node::Fragment(children) => {
                children.iter().for_each(|c| walk(c, out))
            }
            Node::Text(_) | Node::Slot(_) => {}
        }
    }
    walk(n, &mut out);
    out
}

#[allow(dead_code)]
fn _expr(_: &Expr) {}
