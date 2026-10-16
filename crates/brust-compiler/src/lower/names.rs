//! F233: the names a component's generated code may take. Every identifier the chunk or the job declares on its own
//! (runtime imports, the behaviour context, helpers, members, the job's parameter and locals) comes from a [`Names`]
//! allocator seeded with every name the component's code spells, so a generated binding never captures or shadows one
//! of the user's, and a user's binding never takes a generated name's place. A generated name is renamed (`signal1`),
//! never refused: a component that names its state `signal` stays native.
use crate::ir::ComponentIR;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// The seed sets of one lowering, by component id: computed once per component however many printers read it
/// (F247: an inlined child's printer per instance, the job, the chunk).
#[derive(Clone, Default)]
pub struct Seeds(Rc<RefCell<HashMap<String, Rc<HashSet<String>>>>>);

impl Seeds {
    pub fn of(&self, ir: &ComponentIR) -> Rc<HashSet<String>> {
        if let Some(s) = self.0.borrow().get(&ir.id) {
            return s.clone();
        }
        let s = Rc::new(taken(ir));
        self.0.borrow_mut().insert(ir.id.clone(), s.clone());
        s
    }
}

/// Keys whose values never put a name in the generated code's scope:
/// - `source`: verbatim code (block bodies, opaque expressions, the file path). Generated code is never printed inside
///   it, and the free names it reads are its `captures`, which are seeded.
/// - `local` / `props_whole` / `props_rest`: the prop locals, and with them the prop keys (the declarations, reads and
///   captures of a prop, see [`collect`]). The chunk reads a prop through the context's props (`props().title`) and
///   binds a local only as a wrapper parameter around verbatim code, and the job binds them itself
///   ([`super::server`]), so a component that calls its parameter `props` keeps the context's `props`.
/// - `Str` / `Text`: string literals and static text.
/// - `diagnostics`: messages.
/// - `props_member`: a linked child's props member (`_p1`), a generated name the template printer allocates.
/// - `js` / `client_js`: a precomputed slot's code as the analysis printed it (with the default generated names); the
///   expression it comes from is in the structural snapshot.
const SKIP: &[&str] = &[
    "props_member",
    "js",
    "client_js",
    "source",
    "local",
    "props_whole",
    "props_rest",
    "Str",
    "Text",
    "diagnostics",
];

/// Every name `ir` spells where generated code can meet it: what it declares, reads and captures (the placed IR, the
/// structural snapshot, the module scope and the module declarations).
pub fn taken(ir: &ComponentIR) -> HashSet<String> {
    let mut out = HashSet::new();
    match serde_json::to_value(ir) {
        Ok(Value::Object(mut map)) => {
            // The prop declarations: only their destructuring defaults are code (`name` is a key, `local` a prop
            // local, `ts_type` a type).
            if let Some(Value::Array(props)) = map.remove("props") {
                for p in &props {
                    if let Some(d) = p.get("default") {
                        collect(d, &mut out);
                    }
                }
            }
            collect(&Value::Object(map), &mut out);
        }
        v => debug_assert!(false, "F247: the IR serialises to an object: {v:?}"),
    }
    let mut add = |v: Result<Value, serde_json::Error>| {
        debug_assert!(v.is_ok(), "F247: the IR always serialises");
        if let Ok(v) = v {
            collect(&v, &mut out);
        }
    };
    if let Some(s) = ir.structural.as_deref() {
        add(serde_json::to_value(&s.template));
        add(serde_json::to_value(&s.state));
        add(serde_json::to_value(&s.derived));
        add(serde_json::to_value(&s.refs));
    }
    add(serde_json::to_value(&ir.module_scope));
    for d in &ir.module_decls {
        add(serde_json::to_value(&d.names));
        for c in &d.consts {
            add(serde_json::to_value(&c.value));
        }
    }
    out
}

fn collect(v: &Value, out: &mut HashSet<String>) {
    match v {
        Value::String(s) => tokens(s, out),
        // A capture of a prop (`["title", "Prop"]`): a key of the props, never a binding.
        Value::Array(items) if is_prop_capture(items) => {}
        Value::Array(items) => items.iter().for_each(|i| collect(i, out)),
        // A read of a prop (`{ "name": "title", "kind": "Prop" }`): likewise.
        Value::Object(map) if map.get("kind").and_then(Value::as_str) == Some("Prop") => {}
        Value::Object(map) => {
            for (k, v) in map {
                if !SKIP.contains(&k.as_str()) {
                    collect(v, out);
                }
            }
        }
        _ => {}
    }
}

fn is_prop_capture(items: &[Value]) -> bool {
    matches!(items, [Value::String(_), Value::String(k)] if k == "Prop")
}

/// The identifier-shaped words of `s` (a name such as `signal`, or the words of a path `a.b`).
fn tokens(s: &str, out: &mut HashSet<String>) {
    let ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    for w in s.split(|c: char| !ident(c)) {
        if !w.is_empty() && !out.contains(w) {
            out.insert(w.to_string());
        }
    }
}

/// One output's allocator: the names the component spells plus the ones handed out so far.
pub struct Names {
    taken: HashSet<String>,
}

impl Names {
    pub fn new(seed: &HashSet<String>) -> Self {
        Names {
            taken: seed.clone(),
        }
    }

    /// Marks `name` as in use (a name some other part of the output declares).
    pub fn reserve(&mut self, name: &str) {
        self.taken.insert(name.to_string());
    }

    /// `base` when it is free, else `base1`, `base2`, … (the first free one); the name is then taken.
    pub fn fresh(&mut self, base: &str) -> String {
        let mut name = base.to_string();
        let mut n = 0;
        while self.taken.contains(&name) {
            n += 1;
            name = format!("{base}{n}");
        }
        self.taken.insert(name.clone());
        name
    }

    /// A prefix for numbered names (`__f0`, `__f1`, …): `base`, `base1`, … the first that no taken name continues with
    /// digits only; the prefix is then taken.
    pub fn fresh_family(&mut self, base: &str) -> String {
        let clashes = |p: &str, taken: &HashSet<String>| {
            taken.iter().any(|t| {
                t.strip_prefix(p)
                    .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit()))
            })
        };
        let mut name = base.to_string();
        let mut n = 0;
        while clashes(&name, &self.taken) {
            n += 1;
            name = format!("{base}{n}");
        }
        self.taken.insert(name.clone());
        name
    }
}
