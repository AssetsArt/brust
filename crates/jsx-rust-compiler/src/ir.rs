// T3 declares the full IR; T4-T7 fill in the variants. The dead_code allow
// is scoped to this module rather than the whole crate.
#![allow(dead_code)]

use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct Component {
    pub name: String,
    pub props: PropsShape,
    pub root: JsxNode,
}

#[derive(Debug, Default)]
pub struct PropsShape {
    /// Top-level destructured prop names, in declaration order.
    pub bindings: Vec<String>,
    /// Inferred struct types: prop name → PropType (String leaf or nested struct).
    pub types: BTreeMap<String, PropType>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropType {
    /// Leaf String, referenced by direct `{name}` or via member chain bottoming here.
    OwnedString,
    /// Vec<NameItem> generated from `.map` source; element type is `Struct { fields }`.
    VecOf(Box<PropType>),
    /// Generated struct keyed by Pascal-cased name; fields are nested types.
    Struct(BTreeMap<String, PropType>),
}

#[derive(Debug, Default)]
pub enum JsxNode {
    #[default]
    Empty,
    Element {
        tag: String,
        attrs: Vec<JsxAttr>,
        children: Vec<JsxNode>,
    },
    Text(String),
    Expr(Expr),
    Map {
        source: Expr,
        binding: String,
        body: Box<JsxNode>,
    },
}

#[derive(Debug)]
pub struct JsxAttr {
    pub name: String,
    pub value: AttrValue,
}

#[derive(Debug)]
pub enum AttrValue {
    /// Bare boolean attribute (`disabled`).
    Empty,
    /// String literal (`class="foo"`).
    Static(String),
    /// Number literal.
    StaticNum(i64),
    /// Expression (`href={item.href}`).
    Expr(Expr),
}

#[derive(Debug, Clone)]
pub enum Expr {
    /// Field on props, e.g. `props.title`.
    Field(String),
    /// Member chain rooted at a destructured prop, e.g. `user.address.city`.
    MemberAccess { root: String, path: Vec<String> },
    /// Reference to a `.map` iter binding (e.g. inside `.map((item) => …)`, `item`).
    MapBinding(String),
    /// Member chain rooted at a map binding, e.g. `item.href`.
    MapMember { root: String, path: Vec<String> },
    /// String literal in expression position.
    StaticText(String),
    /// Integer literal in expression position.
    StaticNum(i64),
}
