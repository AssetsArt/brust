//! F585 (AMENDMENT 1): the `brust dev` warning for an object-like job value that a printing position prints. The dev
//! job wrapper sends such a top-level output as `{"\u0000js": {k: <kind>, v: <its JSON image>}}`; [`crate::ctx`] decodes
//! it to the image itself (so the context, and every byte rendered, is what production has) and registers the image's
//! allocation here with (component, slot, kind). Only the two printing sinks, text (`e`) and attribute (`attr_str`), ask
//! [`printed`]; a member read, a test, a loop or another filter sees a different value or never asks. One warning per
//! (component, slot, kind). A production server never registers anything: [`printed`] is one relaxed atomic load there.
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use minijinja::value::Value;

use crate::ctx::{CtxMap, Node};

struct Entry {
    ptr: usize,
    component: String,
    slot: String,
    kind: String,
    /// Keeps the allocation alive while it is registered, so its address cannot be reused by another value.
    _keep: Node,
}

#[derive(Default)]
struct Reg {
    entries: Vec<Entry>,
    warned: HashSet<(String, String, String)>,
}

static ACTIVE: AtomicBool = AtomicBool::new(false);
static REG: OnceLock<Mutex<Reg>> = OnceLock::new();
static LOGGER: OnceLock<fn(&str)> = OnceLock::new();
/// Bounds the registry in a long `brust dev` session whose object-valued slots are never printed whole.
const CAP: usize = 4096;

fn reg() -> &'static Mutex<Reg> {
    REG.get_or_init(Mutex::default)
}

/// Where the warnings go (brust-core sets its logger at start); without one they go to stderr.
pub fn set_logger(f: fn(&str)) {
    let _ = LOGGER.set(f);
}

fn ptr_of(n: &Node) -> Option<usize> {
    match n {
        Node::Map(m) => Some(Arc::as_ptr(m) as usize),
        Node::Str(s) => Some(s.as_ptr() as usize),
        _ => None,
    }
}

/// Registers the decoded image of a dev-tagged output.
pub(crate) fn register(image: &Node, component: &str, slot: &str, kind: &str) {
    let Some(ptr) = ptr_of(image) else { return };
    let Ok(mut r) = reg().lock() else { return };
    if r.warned
        .contains(&(component.to_string(), slot.to_string(), kind.to_string()))
    {
        return;
    }
    if r.entries.len() >= CAP {
        r.entries.remove(0);
    }
    r.entries.push(Entry {
        ptr,
        component: component.to_string(),
        slot: slot.to_string(),
        kind: kind.to_string(),
        _keep: image.clone(),
    });
    ACTIVE.store(true, Ordering::Relaxed);
}

/// What React does with a value of `kind` there.
fn react_does(kind: &str, sink: &str) -> &'static str {
    match (kind, sink) {
        ("Map" | "Set", "text") => "React renders its entries as children",
        ("Promise", "text") => "React suspends (on the server: an error)",
        (_, "text") => "React throws (\"Objects are not valid as a React child\")",
        ("Date", _) => "React prints String(value), the Date's long text",
        ("Map", _) => "React prints String(value): [object Map]",
        ("Set", _) => "React prints String(value): [object Set]",
        ("Promise", _) => "React prints String(value): [object Promise]",
        _ => "React prints String(value): [object Object] (or the object's own toString)",
    }
}

/// Called by a printing sink (`sink` = "text" or "attribute") with the value it prints: one relaxed load unless a dev
/// value is registered.
#[inline]
pub fn printed(v: &Value, sink: &str, shown: &str) {
    if ACTIVE.load(Ordering::Relaxed) {
        printed_slow(v, sink, shown);
    }
}

#[cold]
#[inline(never)]
fn printed_slow(v: &Value, sink: &str, shown: &str) {
    let ptr = if let Some(m) = v.downcast_object_ref::<CtxMap>() {
        std::ptr::from_ref(m) as usize
    } else if let Some(s) = v.as_str() {
        s.as_ptr() as usize
    } else {
        return;
    };
    let msg = {
        let Ok(mut r) = reg().lock() else { return };
        let Some(i) = r.entries.iter().position(|e| e.ptr == ptr) else {
            return;
        };
        let e = r.entries.remove(i);
        let key = (e.component.clone(), e.slot.clone(), e.kind.clone());
        if !r.warned.insert(key) {
            return;
        }
        r.entries
            .retain(|x| !(x.component == e.component && x.slot == e.slot && x.kind == e.kind));
        if r.entries.is_empty() {
            ACTIVE.store(false, Ordering::Relaxed);
        }
        format!(
            "brust dev: component `{}` prints the job value `{}` ({} {}) as {}: brust printed {:?} (its JSON image); {}. Return a string or a number from the job for that position.",
            e.component,
            e.slot,
            if e.kind == "object" { "an" } else { "a" },
            e.kind,
            if sink == "text" {
                "text"
            } else {
                "an attribute value"
            },
            shown,
            react_does(&e.kind, sink)
        )
    };
    match LOGGER.get() {
        Some(f) => f(&msg),
        None => eprintln!("{msg}"),
    }
}
