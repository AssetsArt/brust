//! The component IR (spec §5). Plain Rust + serde: compiles without `bun_ast`.
pub mod decls;
pub mod expr;
pub mod template;
#[cfg(test)]
mod tests;

pub use decls::*;
pub use expr::*;
pub use template::*;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Tier {
    Pending,
    Static,
    Native,
    React { reason: String, client_only: bool },
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagClass {
    Fallback,
    Error,
    Warning,
}

/// One finding about a component (spec §8.1). `line`/`col` are 1-based and
/// filled from `loc` by the component layer; constructors leave them 0.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub class: DiagClass,
    pub rule: String,
    pub message: String,
    pub loc: u32,
    pub line: u32,
    pub col: u32,
    pub remediation: String,
}

impl Diagnostic {
    pub fn fallback(rule: &str, message: impl Into<String>, loc: u32, remediation: &str) -> Self {
        Self {
            class: DiagClass::Fallback,
            rule: rule.into(),
            message: message.into(),
            loc,
            line: 0,
            col: 0,
            remediation: remediation.into(),
        }
    }

    pub fn error(rule: &str, message: impl Into<String>, loc: u32, remediation: &str) -> Self {
        Self {
            class: DiagClass::Error,
            ..Self::fallback(rule, message, loc, remediation)
        }
    }

    pub fn warning(rule: &str, message: impl Into<String>, loc: u32, remediation: &str) -> Self {
        Self {
            class: DiagClass::Warning,
            ..Self::fallback(rule, message, loc, remediation)
        }
    }
}

/// 1-based line and column (in bytes) of byte offset `loc`.
pub fn line_col(source: &[u8], loc: u32) -> (u32, u32) {
    let (mut line, mut col) = (1u32, 1u32);
    for &b in &source[..(loc as usize).min(source.len())] {
        if b == b'\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

/// Stable component id (spec §5): camelCase of the file stem, `_`, and 8 hex
/// digits of a 64-bit FNV-1a hash of the path. FNV is used because std's
/// hashers are seeded per process and the id must not change between builds.
pub fn component_id(path: &str) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = file.split('.').next().unwrap_or(file);
    let mut name = String::new();
    for (i, word) in stem
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .enumerate()
    {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            if i == 0 {
                name.push(first.to_ascii_lowercase());
            } else {
                name.push(first.to_ascii_uppercase());
            }
            name.extend(chars);
        }
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in path.as_bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{name}_{:08x}", hash >> 32)
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ComponentIR {
    pub id: String,
    pub source: String,
    pub tier: Tier,
    pub props: Vec<PropDecl>,
    pub state: Vec<StateDecl>,
    pub derived: Vec<DerivedDecl>,
    pub effects: Vec<EffectDecl>,
    pub handlers: Vec<HandlerDecl>,
    pub refs: Vec<RefDecl>,
    /// Locals bound to `useId()` (server generates, client reads from the DOM).
    pub id_bindings: Vec<String>,
    pub template: Node,
    pub jobs: Vec<JobDecl>,
    pub child_links: Vec<ChildLink>,
    pub client_props: Vec<String>,
    pub client_imports: Vec<String>,
    pub needs_worker: bool,
    pub cache: Option<CacheDecl>,
    pub diagnostics: Vec<Diagnostic>,
}

impl ComponentIR {
    pub fn new(id: String, source: String) -> Self {
        Self {
            id,
            source,
            tier: Tier::Pending,
            props: vec![],
            state: vec![],
            derived: vec![],
            effects: vec![],
            handlers: vec![],
            refs: vec![],
            id_bindings: vec![],
            template: Node::Fragment(vec![]),
            jobs: vec![],
            child_links: vec![],
            client_props: vec![],
            client_imports: vec![],
            needs_worker: false,
            cache: None,
            diagnostics: vec![],
        }
    }
}

impl Default for ComponentIR {
    fn default() -> Self {
        Self::new(String::new(), String::new())
    }
}
