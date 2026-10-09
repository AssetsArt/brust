//! The template tree (spec §5.2).
use crate::ir::expr::Expr;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Node {
    Element {
        loc: u32,
        tag: String,
        attrs: Vec<Attr>,
        children: Vec<Node>,
        /// The single element that carries `x-data` (the mount host).
        host: bool,
        ref_name: Option<String>,
    },
    Text(String),
    Slot(Expr),
    If {
        cond: Expr,
        then: Vec<Node>,
        else_: Vec<Node>,
    },
    For {
        source: Expr,
        item: String,
        index: Option<String>,
        key: Expr,
        body: Vec<Node>,
    },
    Component {
        loc: u32,
        name: String,
        /// Import path of the component, `None` when it is declared in this file.
        source: Option<String>,
        /// The imported export name (`default` for a default import); `None`
        /// when declared in this file.
        imported: Option<String>,
        props: Vec<(String, Expr)>,
        children: Vec<Node>,
        link: Option<u32>,
        /// The child's tier (M1b-2 children pass); `Pending` until resolved.
        tier: crate::ir::Tier,
    },
    Fragment(Vec<Node>),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Attr {
    Static { name: String, value: String },
    Dynamic { name: String, value: Expr },
    Event { event: String, handler: String },
    Ref { name: String },
    Spread(Expr),
}
