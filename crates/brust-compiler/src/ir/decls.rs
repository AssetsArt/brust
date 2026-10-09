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

/// One child component used by the template (deduplicated by name).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChildRef {
    pub name: String,
    /// Component id, `None` when the child could not be compiled.
    pub id: Option<String>,
    /// Source path of the child module, `None` for a package import.
    pub path: Option<String>,
    pub tier: crate::ir::Tier,
}

/// Filled by M1b-2.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CacheDecl {
    pub key: Option<RawExpr>,
    pub tags: Option<RawExpr>,
    pub revalidate: Option<f64>,
}
