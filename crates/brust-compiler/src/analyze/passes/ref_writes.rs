//! F288 G9 (Mellow A2, binding): a render-time write `r.current = v` (`useStableComposedRefs`'s `refsRef.current = refs`)
//! lowers to the `useRef` initialiser iff ALL of these hold; anything else is `ref-in-render`.
//! 1. `r` is a `useRef` of this component (after custom-hook inlining): the reader records only those.
//! 2. The write is ONE unconditional top-level statement of the render body (the reader records only those), there is
//!    no other write to `r` in render, and no read of `r` in render, including through a function called during render.
//! 3. `r` does not escape: outside render it appears only as `r.current` read inside callbacks, effects or handlers.
//! 4. `v` is built only from stable leaves, through array or object literals: literals and module names, `useRef`
//!    bindings, setters, `useCallback`s whose deps are all stable leaves, and props the clone pins whose call-site value
//!    is itself a stable leaf (`ComponentIR::stable_props`).
//!
//! Native has no re-render that would redo the write: it runs once, at instance setup, so "equal to `useRef(v)`" holds
//! only when `v` cannot change after the instance is created.
use crate::ir::{ComponentIR, Diagnostic, Expr, IdentKind, RawExpr, RawKind};
use serde_json::Value;

pub fn lower(ir: &mut ComponentIR) {
    // Kept on the IR while judging: a write's value is a use too (an object handed to a ref escapes).
    let writes = ir.render_ref_writes.clone();
    for w in &writes {
        let ok = check(ir, w, &writes);
        match ok {
            Ok(()) => {
                if let Some(r) = ir.refs.iter_mut().find(|r| r.name == w.r#ref) {
                    r.init = Expr::Raw(w.value.clone());
                }
            }
            Err(why) => ir.diagnostics.push(Diagnostic::fallback(
                "ref-in-render",
                format!("`{}.current` is written during render, and {why}", w.r#ref),
                w.loc,
                "write the ref in an effect or an event handler",
            )),
        }
    }
    ir.render_ref_writes.clear();
}

fn check(
    ir: &ComponentIR,
    w: &crate::ir::RenderRefWrite,
    all: &[crate::ir::RenderRefWrite],
) -> Result<(), String> {
    let r = w.r#ref.as_str();
    if all.iter().filter(|x| x.r#ref == r).count() != 1 {
        return Err("it is written more than once".into());
    }
    // Everything evaluated during render, besides the write itself.
    let mut render: Vec<Value> = Vec::new();
    let mut push = |v: Result<Value, serde_json::Error>| render.push(v.unwrap_or(Value::Null));
    push(serde_json::to_value(&ir.template));
    push(serde_json::to_value(&ir.derived));
    push(serde_json::to_value(&ir.state));
    push(serde_json::to_value(&ir.props));
    push(serde_json::to_value(&ir.provides));
    push(serde_json::to_value(
        ir.refs.iter().filter(|x| x.name != r).collect::<Vec<_>>(),
    ));
    push(serde_json::to_value(
        ir.effects.iter().map(|e| &e.deps).collect::<Vec<_>>(),
    ));
    push(serde_json::to_value(
        all.iter().map(|x| &x.value).collect::<Vec<_>>(),
    ));
    if render.iter().any(|v| mentions(v, r)) {
        return Err("it is also read or passed on during render".into());
    }
    // A function called during render that reads it is a render read too.
    let readers: Vec<&str> = ir
        .handlers
        .iter()
        .filter(|h| serde_json::to_value(&h.body).is_ok_and(|v| mentions(&v, r)))
        .map(|h| h.name.as_str())
        .collect();
    if render.iter().any(|v| readers.iter().any(|h| calls(v, h))) {
        return Err("a function called during render reads it".into());
    }
    // Outside render: only `r.current` read, in callbacks, effects and handlers.
    let callbacks: Vec<Value> = ir
        .handlers
        .iter()
        .map(|h| serde_json::to_value(&h.body))
        .chain(ir.effects.iter().map(|e| serde_json::to_value(&e.body)))
        .map(|v| v.unwrap_or(Value::Null))
        .collect();
    if !callbacks.iter().all(|v| only_current_reads(v, r)) {
        return Err("it escapes (passed on, stored, or written outside render)".into());
    }
    if !stable(ir, &w.value, 0) {
        return Err("its value may change after the instance is created".into());
    }
    Ok(())
}

/// `v` names `r`: an identifier, or a word in source kept as text.
fn mentions(v: &Value, r: &str) -> bool {
    match v {
        Value::Object(m) => {
            if m.get("Ident")
                .and_then(|i| i.get("name"))
                .and_then(Value::as_str)
                == Some(r)
            {
                return true;
            }
            m.iter().any(|(k, x)| k != "captures" && mentions(x, r))
        }
        Value::Array(xs) => xs.iter().any(|x| mentions(x, r)),
        Value::String(s) => words(s, r).next().is_some(),
        _ => false,
    }
}

/// `v` calls the function `f`.
fn calls(v: &Value, f: &str) -> bool {
    match v {
        Value::Object(m) => {
            if let Some(c) = m.get("Call")
                && c.pointer("/callee/kind/Ident/name").and_then(Value::as_str) == Some(f)
            {
                return true;
            }
            m.iter().any(|(k, x)| k != "captures" && calls(x, f))
        }
        Value::Array(xs) => xs.iter().any(|x| calls(x, f)),
        Value::String(s) => words(s, f).any(|i| s[i + f.len()..].trim_start().starts_with('(')),
        _ => false,
    }
}

/// Every mention of `r` in `v` is the object of a `.current` read.
fn only_current_reads(v: &Value, r: &str) -> bool {
    only_member_reads(v, r, Some("current"))
}

/// Every mention of `r` in `v` is the object of a member read (of `member` only, when given): never written (`=`,
/// `+=`, `++`, `delete`, …), passed on or stored.
fn only_member_reads(v: &Value, r: &str, member: Option<&str>) -> bool {
    fn count(
        v: &Value,
        r: &str,
        member: Option<&str>,
        idents: &mut usize,
        reads: &mut usize,
    ) -> bool {
        match v {
            Value::Object(m) => {
                if let Some(mm) = m.get("Member")
                    && mm
                        .pointer("/target/kind/Ident/name")
                        .and_then(Value::as_str)
                        == Some(r)
                    && member.is_none_or(|k| mm.get("name").and_then(Value::as_str) == Some(k))
                {
                    *reads += 1;
                }
                if let Some(i) = m.get("Ident") {
                    // An identifier node: its name string is not source text.
                    *idents += usize::from(i.get("name").and_then(Value::as_str) == Some(r));
                    return true;
                }
                // The names an arrow captures: its body, walked too, holds the uses.
                m.iter()
                    .all(|(k, x)| k == "captures" || count(x, r, member, idents, reads))
            }
            Value::Array(xs) => xs.iter().all(|x| count(x, r, member, idents, reads)),
            // Source kept as text: each `r` is `r.<member>`, never written (`=`, `+=`, `++`, `delete`, …) or passed on.
            Value::String(s) => words(s, r).all(|i| {
                if s[..i].trim_end().ends_with("delete") {
                    return false;
                }
                let rest = &s[i + r.len()..];
                let Some(after) = rest.strip_prefix('.') else {
                    return false;
                };
                let key_len = after
                    .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
                    .unwrap_or(after.len());
                if key_len == 0 || member.is_some_and(|k| &after[..key_len] != k) {
                    return false;
                }
                let after = &after[key_len..];
                let t = after.trim_start();
                !(t.starts_with("++")
                    || t.starts_with("--")
                    || (t.starts_with('=') && !t.starts_with("=="))
                    || [
                        "+=", "-=", "*=", "/=", "%=", "&&=", "||=", "??=", "|=", "&=", "^=", "<<=",
                        ">>=",
                    ]
                    .iter()
                    .any(|op| t.starts_with(op)))
            }),
            _ => true,
        }
    }
    let (mut idents, mut reads) = (0, 0);
    count(v, r, member, &mut idents, &mut reads) && idents == reads
}

/// Byte offsets of `w` as a whole word in `s`.
fn words<'a>(s: &'a str, w: &'a str) -> impl Iterator<Item = usize> + 'a {
    let word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    s.match_indices(w).map(|(i, _)| i).filter(move |&i| {
        !s[..i].chars().next_back().is_some_and(word)
            && !s[i + w.len()..].chars().next().is_some_and(word)
            && !s[..i].ends_with('.')
    })
}

/// Rule 4: `e` is built only from stable leaves.
pub(crate) fn stable(ir: &ComponentIR, e: &RawExpr, depth: u8) -> bool {
    if depth > 8 {
        return false;
    }
    match &e.kind {
        RawKind::Lit(_) => true,
        RawKind::Array(xs) => xs.iter().all(|x| stable(ir, x, depth + 1)),
        RawKind::Object(ps) => ps.iter().all(|(_, x)| stable(ir, x, depth + 1)),
        // `o.k` (ruling 255806ff a): `o` is a const local of this component whose initialiser is an object literal
        // with static keys only (no spread, computed key, getter or method), never written and never escaping; the
        // field's value is itself stable.
        RawKind::Member { target, name, .. } => match &target.kind {
            RawKind::Ident {
                name: o,
                kind: IdentKind::Local,
            } => literal_field(ir, o, name).is_some_and(|v| stable(ir, v, depth + 1)),
            _ => false,
        },
        // `A || B`, `A ?? B`, `A && B` (ruling 255806ff b): the value is always one of the operands.
        RawKind::Binary {
            op: crate::ir::BinOp::Or | crate::ir::BinOp::Nullish | crate::ir::BinOp::And,
            left,
            right,
        } => stable(ir, left, depth + 1) && stable(ir, right, depth + 1),
        RawKind::Ident { name, kind } => match kind {
            IdentKind::Setter | IdentKind::Import { .. } => true,
            IdentKind::Prop => ir.stable_props.iter().any(|p| p == name),
            IdentKind::Local => {
                // a const array / object literal read only here (the binding a custom hook's rest parameter makes:
                // `useStableComposedRefs(...refs)`) is that literal (ruling 255806ff a, whole object)
                whole_literal(ir, name).is_some_and(|v| stable(ir, v, depth + 1))
                    || ir.refs.iter().any(|r| &r.name == name)
                    // a module `const` or a function declaration: one binding for the life of the module
                    || ir.module_decls.iter().any(|d| {
                        d.consts.iter().any(|c| &c.name == name)
                            || (d.names.iter().any(|n| n == name)
                                && d.source.trim_start().starts_with("function"))
                    })
                    || ir.callback_deps.iter().any(|(n, deps)| {
                        n == name
                            && deps
                                .as_ref()
                                .is_some_and(|ds| ds.iter().all(|d| stable(ir, d, depth + 1)))
                    })
            }
            _ => false,
        },
        _ => false,
    }
}

/// The field `k` of `o`, a const object literal of this component that is never written and never escapes.
fn literal_field<'a>(ir: &'a ComponentIR, o: &str, k: &str) -> Option<&'a RawExpr> {
    let ps = ir
        .derived
        .iter()
        .find(|d| d.name == o)
        .and_then(|d| match &d.expr {
            Expr::Raw(RawExpr {
                kind: RawKind::Object(ps),
                ..
            }) => Some(ps),
            _ => None,
        })?;
    // The reader keeps only static keys in `Object` (a spread, accessor or computed key reads otherwise); a method or a
    // function-valued field is refused too.
    if ps
        .iter()
        .any(|(_, v)| matches!(v.kind, RawKind::Arrow { .. } | RawKind::Opaque { .. }))
    {
        return None;
    }
    let all: Vec<Value> = [
        serde_json::to_value(&ir.template),
        serde_json::to_value(
            ir.derived
                .iter()
                .filter(|d| d.name != o)
                .collect::<Vec<_>>(),
        ),
        serde_json::to_value(&ir.state),
        serde_json::to_value(&ir.props),
        serde_json::to_value(&ir.provides),
        serde_json::to_value(&ir.refs),
        serde_json::to_value(&ir.handlers),
        serde_json::to_value(&ir.effects),
        serde_json::to_value(&ir.render_ref_writes),
    ]
    .into_iter()
    .map(|v| v.unwrap_or(Value::Null))
    .collect();
    if !all.iter().all(|v| only_member_reads(v, o, None)) {
        return None;
    }
    ps.iter().rev().find(|(pk, _)| pk == k).map(|(_, v)| v)
}

/// `o`, a const array or object literal of this component that nothing reads but the one render ref write whose value
/// it is (so its identity is never observed): the literal.
fn whole_literal<'a>(ir: &'a ComponentIR, o: &str) -> Option<&'a RawExpr> {
    let lit = ir
        .derived
        .iter()
        .find(|d| d.name == o)
        .and_then(|d| match &d.expr {
            Expr::Raw(r) if matches!(r.kind, RawKind::Array(_) | RawKind::Object(_)) => Some(r),
            _ => None,
        })?;
    // read once, as a write's whole value
    let as_value = ir
        .render_ref_writes
        .iter()
        .filter(|w| matches!(&w.value.kind, RawKind::Ident { name, .. } if name == o))
        .count();
    let others: Vec<Value> = [
        serde_json::to_value(&ir.template),
        serde_json::to_value(
            ir.derived
                .iter()
                .filter(|d| d.name != o)
                .collect::<Vec<_>>(),
        ),
        serde_json::to_value(&ir.state),
        serde_json::to_value(&ir.props),
        serde_json::to_value(&ir.provides),
        // the written ref's own initialiser is replaced by the write (`useRef(refs); refsRef.current = refs`)
        serde_json::to_value(
            ir.refs
                .iter()
                .filter(|r| {
                    !ir.render_ref_writes.iter().any(|w| {
                        w.r#ref == r.name
                            && matches!(&w.value.kind, RawKind::Ident { name, .. } if name == o)
                    })
                })
                .collect::<Vec<_>>(),
        ),
        serde_json::to_value(&ir.handlers),
        serde_json::to_value(&ir.effects),
        serde_json::to_value(
            ir.render_ref_writes
                .iter()
                .filter(|w| !matches!(&w.value.kind, RawKind::Ident { name, .. } if name == o))
                .collect::<Vec<_>>(),
        ),
    ]
    .into_iter()
    .map(|v| v.unwrap_or(Value::Null))
    .collect();
    (as_value == 1 && !others.iter().any(|v| mentions(v, o))).then_some(lit)
}
