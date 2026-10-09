//! Expressions as the analyzer reads them (`RawExpr`) and as later stages place
//! them (`Expr`). Plain Rust: this module never names Bun types (spec §9).
use serde::{Deserialize, Serialize};

/// What an identifier refers to, decided from its symbol and import record,
/// never from its spelling.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum IdentKind {
    Prop,
    Local,
    State,
    Setter,
    Import { source: String, imported: String },
    Global,
    LoopBinding,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Literal {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
    Undefined,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    Ne,
    StrictEq,
    StrictNe,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    Nullish,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Not,
    Neg,
    Pos,
    Typeof,
}

/// One expression with the byte offset of its start in the source.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RawExpr {
    pub loc: u32,
    pub kind: RawKind,
}

/// Carries every production of the §6.2 grammar losslessly; anything else is
/// `Opaque` with the printed JS and the reason it was not read structurally.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum RawKind {
    Lit(Literal),
    Ident {
        name: String,
        kind: IdentKind,
    },
    Member {
        target: Box<RawExpr>,
        name: String,
        optional: bool,
    },
    Index {
        target: Box<RawExpr>,
        index: Box<RawExpr>,
    },
    /// `callee` is an `Ident` or a `Member`.
    Call {
        callee: Box<RawExpr>,
        args: Vec<RawExpr>,
    },
    Binary {
        op: BinOp,
        left: Box<RawExpr>,
        right: Box<RawExpr>,
    },
    Unary {
        op: UnOp,
        value: Box<RawExpr>,
    },
    Cond {
        test: Box<RawExpr>,
        yes: Box<RawExpr>,
        no: Box<RawExpr>,
    },
    Template {
        head: String,
        parts: Vec<(RawExpr, String)>,
    },
    Array(Vec<RawExpr>),
    Object(Vec<(String, RawExpr)>),
    Arrow {
        params: Vec<String>,
        body: ArrowBody,
        captures: Vec<(String, IdentKind)>,
    },
    /// JSX in expression position (map bodies, ternary arms).
    Jsx(Box<crate::ir::template::Node>),
    /// Anything else; `source` is the printed JS. `captures` are the
    /// identifiers it reads that it does not declare (like `Arrow`), so deps and
    /// job inputs stay exact. `why == "contains-jsx"` marks JSX built outside the
    /// template (a handler or effect body).
    Opaque {
        source: String,
        why: String,
        captures: Vec<(String, IdentKind)>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum ArrowBody {
    Expr(Box<RawExpr>),
    Block { source: String, captures_only: bool },
}

/// Placement of a value (spec §5.1). M1b-1 produces only `Raw`; M1b-2 places.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Expr {
    Raw(RawExpr),
    Server(ServerExpr),
    /// A first-paint value the precompute job computes in Bun. `inputs` are
    /// sorted dotted prop paths. `state_dependent`: the job evaluates it with the
    /// state seeds and the client recomputes `js`. `per_item`: the loop binding
    /// when it sits in a `For` body (the job returns an array aligned with the list).
    Precomputed {
        slot: String,
        js: String,
        inputs: Vec<String>,
        state_dependent: bool,
        per_item: Option<String>,
    },
    ClientOnly {
        js: String,
    },
}

/// A `RawExpr` proven inside the §6.2 grammar (M1b-2 narrows).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ServerExpr(pub RawExpr);
