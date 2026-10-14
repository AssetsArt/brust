//! The component IR (spec §5). Plain Rust + serde: compiles without `bun_ast`.
pub mod decls;
pub mod expr;
pub mod fold;
pub mod template;
#[cfg(test)]
mod tests;

pub use decls::*;
pub use expr::*;
pub use fold::{FoldEnv, V};
pub use template::*;

use serde::{Deserialize, Serialize};

/// The prop name a JSX spread of the props `...rest` object reads (`ComponentIR::props_rest`,
/// shadcn S1.2): `Ident { REST_PROPS, Prop }`. A spread of the whole props object is `Ident { "*", Prop }`.
pub const REST_PROPS: &str = "...";

/// The prop key of a spread passed to a component (`<Child {...x} />`): `props` keeps it in
/// source order among the named props (`("...", x)`).
pub const SPREAD_KEY: &str = "...";

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
    Info,
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

    pub fn info(rule: &str, message: impl Into<String>, loc: u32, remediation: &str) -> Self {
        Self {
            class: DiagClass::Info,
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

impl DiagClass {
    pub fn as_str(self) -> &'static str {
        match self {
            DiagClass::Fallback => "fallback",
            DiagClass::Error => "error",
            DiagClass::Warning => "warning",
            DiagClass::Info => "info",
        }
    }

    /// Sort rank: errors first, then fallbacks, warnings, info.
    pub fn severity_rank(self) -> u8 {
        match self {
            DiagClass::Error => 0,
            DiagClass::Fallback => 1,
            DiagClass::Warning => 2,
            DiagClass::Info => 3,
        }
    }
}

impl Diagnostic {
    /// One line: `<class> <rule> <file>:<line>:<col> <message> — <remediation>`.
    pub fn render(&self, file: &str) -> String {
        format!(
            "{} {} {file}:{}:{} {} — {}",
            self.class.as_str(),
            self.rule,
            self.line,
            self.col,
            self.message,
            self.remediation
        )
    }
}

/// `diagnostics` rendered one per line, each line newline-terminated.
pub fn render_diagnostics(diagnostics: &[Diagnostic], file: &str) -> String {
    diagnostics.iter().map(|d| d.render(file) + "\n").collect()
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
    format!("{name}_{:08x}", fnv32(path))
}

/// Id of the function `name` of module `path` that is not its default export:
/// lower-camel `name`, `_`, and the hash of `path#name`.
pub fn named_component_id(path: &str, name: &str) -> String {
    let mut chars = name.chars();
    let lead: String = chars
        .next()
        .map(|c| c.to_ascii_lowercase())
        .into_iter()
        .chain(chars)
        .collect();
    format!("{lead}_{:08x}", fnv32(&format!("{path}#{name}")))
}

/// High 32 bits of the 64-bit FNV-1a hash.
fn fnv32(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in s.as_bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash >> 32
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ComponentIR {
    pub id: String,
    pub source: String,
    /// Set on the synthetic React-tier component of a package export (`source` is then
    /// `package_<specifier>_<export>` made filename-safe, not a file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<ExternalRef>,
    /// The name a React island imports this component by from `source`; absent for the default export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<String>,
    /// `export` names a function nothing exports (a helper component of its module): the build exposes it for the island.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unexported: bool,
    pub tier: Tier,
    pub props: Vec<PropDecl>,
    /// The local of a `...rest` in the props pattern (shadcn S1.2, R34.14): the props minus every
    /// key in `props`. Read only as `rest.k` (an ordinary prop read) or spread in JSX, where it is
    /// the identifier `REST_PROPS` of kind `Prop`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props_rest: Option<String>,
    /// The polymorphic tag `const Comp = flag ? Slot.Root : "host"` of this component (R34.28).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poly: Option<PolyTag>,
    /// The component is `forwardRef(…)` (shadcn S3, R34.63): its second parameter is the forwarded ref, which a
    /// static or native render drops; a call site that passes `ref` makes the caller React (`forwardref-ref`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub forwards_ref: bool,
    /// Props a call site must not pass (F153c): this component spreads its props into a polymorphic child that
    /// would render another element if the key were there (`asChild` through Radix `<Primitive.label {...props}>`).
    /// A literal `false` is fine; a call site that spreads its own props on passes the requirement up.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub absent_props: Vec<String>,
    pub state: Vec<StateDecl>,
    pub derived: Vec<DerivedDecl>,
    pub effects: Vec<EffectDecl>,
    pub handlers: Vec<HandlerDecl>,
    pub refs: Vec<RefDecl>,
    /// Locals bound to `useId()` (server generates, client reads from the DOM).
    pub id_bindings: Vec<String>,
    /// Number of `useId()` calls: the server seeds `_id0.._idN-1` per instance (S7 step 6).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub use_id_slots: usize,
    pub template: Node,
    /// The template contains an `<Outlet />` (S8); the build lane checks the route tree.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub uses_outlet: bool,
    pub jobs: Vec<JobDecl>,
    /// lucide icons the build should render to inline SVG (L23); empty when none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub icon_requests: Vec<IconRequest>,
    /// Slots the build may evaluate once (L2); empty when none qualifies.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub build_eval: Vec<BuildEvalSlot>,
    /// Inlined instances whose child job the build may run once (F149, R34.88-R34.90); empty when none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub build_eval_instances: Vec<BuildEvalInstance>,
    /// Inlined instances whose child job the build ran: their slots print as these literals and they
    /// have no `instances` record (F149, R34.90).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folded_instances: Vec<FoldedInstance>,
    pub child_links: Vec<ChildLink>,
    /// Inlined child instances with a precompute job or `useId` values (S6 `children[].instances`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instances: Vec<InstanceRecord>,
    pub client_props: Vec<String>,
    /// F71: for a prop the client reads only as the source of keyed lists, the row fields it
    /// can read (`"id"`, `"badges.color"`); the host's `x-props` seeds `root | project(…)`.
    /// Absent (full value) whenever a read cannot be proved to be a plain field path.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub client_prop_projections: std::collections::BTreeMap<String, Vec<String>>,
    /// `(source, imported)` pairs the client chunk bundles, sorted.
    pub client_imports: Vec<(String, String)>,
    /// Module-level declarations (helpers, constants) the client chunk needs,
    /// transitively, sorted.
    pub client_module_locals: Vec<String>,
    pub needs_worker: bool,
    pub cache: Option<CacheDecl>,
    /// Child components used by the template, in document order.
    pub children: Vec<ChildRef>,
    /// `useStore(handle)` bindings in source order (M3-F D7).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stores: Vec<StoreUse>,
    pub diagnostics: Vec<Diagnostic>,
    /// Module-level declarations and what each reads (its captures), for the
    /// passes to follow helpers; not part of the serialized IR.
    #[serde(skip)]
    pub module_scope: Vec<(String, Vec<(String, IdentKind)>)>,
    /// Module-level declarations as printed source, in source order (the
    /// chunk and the job re-emit the ones they reach); not serialized.
    #[serde(skip)]
    pub module_decls: Vec<ModuleDecl>,
    /// The structural IR (every value still `Raw`) as the passes received it.
    /// Placement only rewrites expressions, so lowering walks this in lockstep
    /// with the placed template to print client code from the original
    /// expressions; not serialized.
    #[serde(skip)]
    pub structural: Option<Box<Structural>>,
}

/// One module-level declaration statement.
#[derive(Debug, Clone, PartialEq)]
pub struct ModuleDecl {
    /// The names it declares.
    pub names: Vec<String>,
    /// The printed statement without a leading `export`.
    pub source: String,
    /// The `const name = value` bindings it declares, read as expressions (G5/G9/G10):
    /// the placer folds a value it can prove constant into the template.
    pub consts: Vec<ConstVal>,
}

/// A module-level `const` with its initializer read as an expression.
#[derive(Debug, Clone, PartialEq)]
pub struct ConstVal {
    pub name: String,
    pub value: RawExpr,
    /// The binding has a use that is not a proven read (R1.1a): an array or object must not fold.
    pub mutated: bool,
}

/// The structural parts of a `ComponentIR` before placement.
#[derive(Debug, Clone, PartialEq)]
pub struct Structural {
    pub template: Node,
    pub state: Vec<StateDecl>,
    pub derived: Vec<DerivedDecl>,
    pub refs: Vec<RefDecl>,
}

impl ComponentIR {
    pub fn new(id: String, source: String) -> Self {
        Self {
            id,
            source,
            external: None,
            export: None,
            unexported: false,
            tier: Tier::Pending,
            props: vec![],
            props_rest: None,
            poly: None,
            forwards_ref: false,
            absent_props: Vec::new(),
            state: vec![],
            derived: vec![],
            effects: vec![],
            handlers: vec![],
            refs: vec![],
            id_bindings: vec![],
            use_id_slots: 0,
            template: Node::Fragment(vec![]),
            uses_outlet: false,
            jobs: vec![],
            icon_requests: vec![],
            build_eval: vec![],
            build_eval_instances: vec![],
            folded_instances: vec![],
            child_links: vec![],
            instances: vec![],
            client_props: vec![],
            client_prop_projections: Default::default(),
            client_imports: vec![],
            client_module_locals: vec![],
            needs_worker: false,
            cache: None,
            children: vec![],
            stores: vec![],
            diagnostics: vec![],
            module_scope: vec![],
            module_decls: vec![],
            structural: None,
        }
    }
}

impl Default for ComponentIR {
    fn default() -> Self {
        Self::new(String::new(), String::new())
    }
}

/// A job the server runs per inlined instance of its component: a precompute job, or the ssr
/// render of a React island the component holds (L4; a client-only island has no render).
pub fn feeds_instances(j: &JobDecl) -> bool {
    matches!(
        j.kind,
        JobKind::Precompute | JobKind::Ssr { client_only: false }
    )
}

/// A native/static component whose inlined instances the server must feed: a job of its own
/// (`feeds_instances`) or `useId` values. A React component renders as its own island instead.
pub fn is_fed(ir: &ComponentIR) -> bool {
    !matches!(ir.tier, Tier::React { .. })
        && (ir.use_id_slots > 0 || ir.jobs.iter().any(feeds_instances))
}
