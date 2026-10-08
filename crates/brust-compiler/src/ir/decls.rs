//! Declarations read from the component body (spec §5, §4.3).
use crate::ir::expr::{Expr, RawExpr};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PropDecl {
    pub name: String,
    pub ts_type: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StateDecl {
    /// Empty when the value slot is elided (`const [, setB] = useState(1)`).
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
    pub child: String,
    pub props_member: String,
    pub item_scoped: Vec<String>,
}

/// Filled by M1b-2.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CacheDecl {
    pub key: Option<RawExpr>,
    pub tags: Option<RawExpr>,
    pub revalidate: Option<f64>,
}
