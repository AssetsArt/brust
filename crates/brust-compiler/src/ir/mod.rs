//! The component IR (spec §5). Plain Rust + serde: compiles without `bun_ast`.
pub mod decls;
pub mod expr;
pub mod fold;
pub mod template;
#[cfg(test)]
mod tests;

pub use decls::*;
pub use expr::*;
pub use fold::{FoldEnv, V, is_js_space};
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
    /// Set on a component compiled from a package source and written in app code as a package import (F188): the
    /// published export a React island or a revive hook imports instead of the source (R34.62), so every user of a
    /// package shares the dist's one module instance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dist: Option<ExternalRef>,
    /// The name a React island imports this component by from `source`; absent for the default export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<String>,
    /// `export` names a function nothing exports (a helper component of its module): the build exposes it for the island.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unexported: bool,
    /// R34.122: a clone of a component made for one call site, with the call site's content spliced in. Its chunk
    /// shares one factory module with every clone whose chunk is equal (R34.124).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub specialised: bool,
    pub tier: Tier,
    pub props: Vec<PropDecl>,
    /// The local of a `...rest` in the props pattern (shadcn S1.2, R34.14): the props minus every
    /// key in `props`. Read only as `rest.k` (an ordinary prop read) or spread in JSX, where it is
    /// the identifier `REST_PROPS` of kind `Prop`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props_rest: Option<String>,
    /// The parameter that holds the whole props object (`function C(props)`), when the body destructures it with a
    /// `...rest` (so no prop is named after it): a verbatim body naming it (`props.disabled`) binds that name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props_whole: Option<String>,
    /// The polymorphic tag `const Comp = flag ? Slot.Root : "host"` of this component (R34.28).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poly: Option<PolyTag>,
    /// The component is `forwardRef(…)` (shadcn S3, R34.63): its second parameter is the forwarded ref, which a
    /// static or native render drops; a call site that passes `ref` makes the caller React (`forwardref-ref`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub forwards_ref: bool,
    /// An inlined lucide icon of this component carries a runtime spread of its props (shadcn S1, R34.77): a call
    /// site may not pass a key the icon component reads itself (`size`, `color`, `className`, …).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub icon_spread: bool,
    /// The `tsconfig` `paths` imports this module wrote and the files they name (R34.76): the build checks each against
    /// the bundler's own resolution.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alias_imports: Vec<crate::analyze::aliases::AliasImport>,
    /// Props a call site must not pass (F153c): this component spreads its props into a polymorphic child that
    /// would render another element if the key were there (`asChild` through Radix `<Primitive.label {...props}>`).
    /// A literal `false` is fine; a call site that spreads its own props on passes the requirement up.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub absent_props: Vec<String>,
    /// S2 context lowering: what this component's Provider element hands to its children (see `ProvideDecl`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provides: Vec<ProvideDecl>,
    /// B7: the render-prop arrows this component writes on its children, read as templates (see `RenderProp`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub render_props: Vec<RenderProp>,
    /// F266: the body's `const x = { … }` object literals that are only spread, read by member or handed to a function
    /// the component was given: a derived value of one of these names stands for its literal.
    #[serde(skip)]
    pub safe_objects: Vec<String>,
    /// F279: single-return module functions the call of which is replaced by the expression (`InlineFn`).
    #[serde(skip)]
    pub inline_fns: Vec<InlineFn>,
    /// S2: props of a specialised clone whose value the call site fixes for the life of the instance (a hidden input
    /// that is not client-changing there): reading one is not a client change.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fixed_props: Vec<String>,
    /// The context fields this component reads, each as a hidden prop (see `CtxUse`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ctx_uses: Vec<CtxUse>,
    /// `ctx_uses` reach a context read in a package source (this component's own, or a descendant's it passes on): such a
    /// consumer revived from its source would not share the Provider island's `createContext` (the published dist).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ctx_pkg: bool,
    /// R34.142: the literal default of each scalar context (`createContext(undefined)`, `createContext('ltr')`) this component
    /// reads or passes on: with no Provider above the page, the context's value is that default.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ctx_defaults: Vec<(String, Literal)>,
    /// F174: module functions proven to return a primitive (`analyze::plain_fn`), callable under a lowered Provider.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plain_fns: Vec<String>,
    /// F199: module functions and consts that cannot hand out a React element (`analyze::plain_fn::element_free_fns`),
    /// readable in a prop passed to a component.
    #[serde(skip)]
    pub element_free_fns: Vec<String>,
    /// F147: every name the module spells (its symbols, and the names inlined hook locals print as): a generated
    /// handler name never takes one.
    #[serde(skip)]
    pub bound_names: std::collections::HashSet<String>,
    /// F215: the first module-level statement that runs for its effect (`analyze::module_effects`): its start and what it is.
    #[serde(skip)]
    pub module_effect: Option<(u32, String)>,
    /// This component's rendered tree holds a React island (a React-tier child, or a static child that does): such a
    /// subtree hydrates standalone, so a lowered context Provider above it cannot reach it (S2, F3).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub holds_island: bool,
    /// Keys a call site must not write at all, not even as a literal `false` (F164, R34.83): this component spreads
    /// its props into a fed child whose job reads them, and a spread cannot feed a job input.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unwritten_props: Vec<String>,
    /// Keys a call site must not write (2b-handlers, R34.18 extended): this component binds a live value to the key on a
    /// static child's element, ahead of a spread of its own rest, and a call site that writes the key would override it
    /// in React (last wins) where the one shared chunk cannot tell.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shadowed_props: Vec<String>,
    /// Live props the parent binds itself on a static child's element (2b-handlers): the prop `key` of the component
    /// node at `loc`, printed in this component's scope like an attribute written there (handlers: see
    /// [`HandlerDecl::forwarded`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub live_forwards: Vec<Forwarded>,
    /// The slot content this component is given is printed more than once: its template repeats in a list, or
    /// passes its children on to a component that does (F169, transitive).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repeats_children: bool,
    /// This component hands its own `{children}` to a component that prints them under a native host element (F214,
    /// transitive): directives in the slot content its caller gives would be bound by that host, not by the caller.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hosts_children: bool,
    /// F295: this component prints a value it took once at mount (a snapshot cell) where nothing re-applies it on the
    /// client (through a spread), so an instance of it must mount with its caller and never again (transitive). The
    /// text says what, for the call site that cannot promise it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_once: Option<String>,
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
    /// F197: bare specifiers whose package source the build should write (`.brust/pkg-src`) so a helper imported from
    /// them can be proven plain on the next compile; empty when none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub package_requests: Vec<String>,
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
    /// Fed child instances whose job runs inside `jobs[0]` (R34.96); empty when none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fused: Vec<FusedInstance>,
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
            dist: None,
            export: None,
            unexported: false,
            specialised: false,
            tier: Tier::Pending,
            props: vec![],
            props_rest: None,
            props_whole: None,
            poly: None,
            forwards_ref: false,
            icon_spread: false,
            alias_imports: vec![],
            absent_props: Vec::new(),
            provides: Vec::new(),
            render_props: Vec::new(),
            safe_objects: Vec::new(),
            inline_fns: Vec::new(),
            fixed_props: Vec::new(),
            ctx_uses: Vec::new(),
            ctx_pkg: false,
            ctx_defaults: Vec::new(),
            plain_fns: Vec::new(),
            element_free_fns: Vec::new(),
            bound_names: Default::default(),
            module_effect: None,
            holds_island: false,
            unwritten_props: Vec::new(),
            shadowed_props: Vec::new(),
            live_forwards: Vec::new(),
            repeats_children: false,
            hosts_children: false,
            mount_once: None,
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
            package_requests: vec![],
            build_eval: vec![],
            build_eval_instances: vec![],
            folded_instances: vec![],
            fused: vec![],
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
