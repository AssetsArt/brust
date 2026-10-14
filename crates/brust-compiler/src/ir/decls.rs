//! Declarations read from the component body (spec §5, §4.3).
use crate::ir::expr::{Expr, RawExpr};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PropDecl {
    pub name: String,
    /// The local binding (`heading` in `{ title: heading }`); equals `name`
    /// when not renamed. Reads of it are `Ident { name, kind: Prop }`.
    pub local: String,
    pub ts_type: Option<String>,
    /// `size = 3` in the destructuring pattern.
    pub default: Option<RawExpr>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StateDecl {
    /// `_stN` (N = 1-based position among the state decls) when the value slot
    /// is elided (`const [, setB] = useState(1)`).
    pub name: String,
    pub setter: Option<String>,
    pub init: Expr,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct DerivedDecl {
    pub name: String,
    pub expr: Expr,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct EffectDecl {
    /// An `Arrow`.
    pub body: RawExpr,
    /// `None` when the deps argument is absent.
    pub deps: Option<Vec<RawExpr>>,
    pub layout: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct HandlerDecl {
    /// `_hN` for a hoisted inline handler, the binding name for `useCallback`.
    pub name: String,
    /// An `Arrow` or an `Ident`.
    pub body: RawExpr,
    /// Loop bindings in scope where the handler is attached.
    pub item_scoped: Vec<String>,
    /// A handler the parent hoisted from a prop of a static child that the child spreads onto an
    /// element (shadcn S1.3, R34.18): the prop `key` of the component node at `loc`. The inline
    /// print binds it on that element as if written there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forwarded: Option<Forwarded>,
}

/// Where a forwarded handler came from (see [`HandlerDecl::forwarded`]).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Forwarded {
    pub loc: u32,
    pub key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RefDecl {
    pub name: String,
    pub init: Expr,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum JobKind {
    Precompute,
    Ssr { client_only: bool },
}

/// Filled by M1b-2.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct JobDecl {
    pub kind: JobKind,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    /// An `Ssr` job for an island inside a list renders once per item: the
    /// innermost loop binding; the output is an array aligned with the list.
    pub per_item: Option<String>,
    /// `Ssr` job for a react child: child prop name -> parent props path (`[idx]` for the
    /// enclosing row), `None` when the value is not a plain path. Absent on other jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props: Option<std::collections::BTreeMap<String, Option<String>>>,
    /// `Ssr` job for a react child: props passed as JSON literals (`limit={3}`), constant per
    /// job. Disjoint from `props`. Empty (and omitted) on other jobs.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub literals: std::collections::BTreeMap<String, serde_json::Value>,
}

/// Filled by M1b-2.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChildLink {
    pub id: u32,
    /// The child's component id.
    pub child: String,
    /// `_pN`: the parent member holding the props object.
    pub props_member: String,
    pub item_scoped: Vec<String>,
    /// Every prop the parent passes, as `Server` or `ClientOnly`.
    pub props: Vec<(String, Expr)>,
}

/// One inlined child instance that the server must feed (F34, compiler half): it has its
/// own precompute job or `useId` values, stored under `__{child_id}_{k}` (an array indexed
/// like the enclosing loops when `loops` is not empty).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct InstanceRecord {
    pub child_id: String,
    /// 1-based ordinal of this child id in template order (the `{k}` of the slot key).
    pub k: u32,
    /// The enclosing lists, outermost first, as paths relative to this component's props
    /// (`items`); `None` when the list is not a plain props path. Empty = a static instance.
    pub loops: Vec<Option<String>>,
    /// Each child prop → the parent props path it is bound to, `[idx]` standing for the
    /// current row of the innermost list; `None` for anything that is neither a plain path,
    /// a literal nor an expression the server evaluates.
    pub props: std::collections::BTreeMap<String, Option<String>>,
    /// Constant props (`code="a"`): part of the child's job inputs and keys (F105).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub literals: std::collections::BTreeMap<String, serde_json::Value>,
    /// Props the server computes from the parent's props: jinja over `__props`, and in a row
    /// `__row` (the item) and `__idx` (F105, ledger F60).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub exprs: std::collections::BTreeMap<String, String>,
}

/// One child component used by the template (deduplicated by name).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChildRef {
    pub name: String,
    /// Component id, `None` when the child could not be compiled.
    pub id: Option<String>,
    /// Source path of the child module, `None` for a package import.
    pub path: Option<String>,
    pub tier: crate::ir::Tier,
    /// `Some` when this file passes lowered JSX children to this child, a React island (shadcn S1,
    /// R34.21): the ids of the components inside the tree. The island's chunk and its SSR job import
    /// them to revive the tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nested: Option<Vec<String>>,
}

/// A component that lives in a package, rendered as a React island: the island's code is the
/// package export itself (`import { Heart } from 'lucide-react'`), not a compiled module.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ExternalRef {
    /// The import specifier, as written (`lucide-react`).
    pub source: String,
    /// The export: a name, or `default`.
    pub export: String,
}

/// A lucide-react icon the build should render to inline SVG (L23): the first compile leaves it as
/// a component and records this; the build renders it (`react-dom/server`, the installed version)
/// and the next compile inlines the markup (`AnalyzeOptions.icon_svgs`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct IconRequest {
    /// `<source path>@<byte offset of the element>`.
    pub key: String,
    /// The import specifier (`lucide-react`, or `lucide-react/icons/heart`).
    pub source: String,
    /// The export (`Heart`, `Edit`, `default`).
    pub export: String,
    /// Constant props, as JSON.
    pub props: std::collections::BTreeMap<String, serde_json::Value>,
    /// Props that are rendered as sentinels (size / color / strokeWidth / className).
    pub dynamic: Vec<String>,
    /// Constant props of the enclosing `LucideProvider`s.
    pub provider: std::collections::BTreeMap<String, serde_json::Value>,
    pub line: u32,
    pub col: u32,
}

/// A precompute slot the build may evaluate once instead of running it per request (L2): it reads
/// nothing request- or time-dependent. The build evaluates `ComponentArtifacts.eval_ts` for `key`
/// and recompiles with the value (`AnalyzeOptions.slot_values`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct BuildEvalSlot {
    /// `<source>@<byte offset>`: stable across the recompile, unlike the `_sN` name.
    pub key: String,
    /// The slot this is in the first compile.
    pub slot: String,
    /// `buildTime(() => …)`: package imports and `async` allowed, failures are build errors.
    pub build_time: bool,
    pub line: u32,
    pub col: u32,
}

/// One `useStore(handle)` binding of the component (M3-F D7).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StoreUse {
    pub handle: String,
    /// The import that brings the handle in: (local, source, imported); `*` for a namespace.
    pub import: (String, String, String),
    /// `s` of `const s = useStore(h)`; `None` for a destructuring.
    pub view: Option<String>,
    /// `(key, local)` of `const { key: local } = useStore(h)`, source order.
    pub fields: Vec<(String, String)>,
    pub loc: u32,
    /// Filled by the stores pass (Task 2); `None` = unresolved (the component falls back).
    pub resolved: Option<StoreRef>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StoreRef {
    /// The `defineStore` literal.
    pub name: String,
    /// Root-relative path of the module that CALLS defineStore (C3; after re-exports).
    pub module: String,
    /// Top-level keys of the factory's returned object, sorted.
    pub signals: Vec<String>,
    pub computeds: Vec<String>,
    /// The factory's returned object was read (keys above are complete).
    pub factory_read: bool,
}

/// Filled by M1b-2.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CacheDecl {
    pub key: Option<RawExpr>,
    pub tags: Option<RawExpr>,
    pub revalidate: Option<f64>,
}

/// The polymorphic tag of a component (shadcn S1.4, R34.28): `const Comp = asChild ? Slot.Root :
/// "button"` and `<Comp …/>`. The call site decides: no `asChild` prints `<host>`; a literal
/// `asChild` prints the call's single child element with this element's attributes merged in
/// (Radix `Slot`); anything else keeps the caller on React.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PolyTag {
    /// The prop that selects the Slot (`asChild`).
    pub flag: String,
    /// The ternary is `flag ? host : Slot` (the Slot is the else branch).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub negate: bool,
    /// The host tag when the Slot is not selected.
    pub host: String,
}
