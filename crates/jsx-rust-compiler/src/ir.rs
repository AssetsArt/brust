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

#[derive(Debug, Default, Clone)]
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
    /// Built-in `<BrustPage>` document shell. The compiler owns the ENTIRE
    /// `<html>/<head>/<body>` skeleton, including `<head>` — the user never
    /// writes head markup. Head content is supplied through a curated set of
    /// string-literal PROPS (`title`, `description`, …); a literal `<head>`
    /// child is rejected. Keeping `<head>` framework-owned lets brust inject
    /// additional tags later (importmap, preloads, the css link) without
    /// colliding with user markup. It is NOT a user-definable component — the
    /// lowerer intercepts the `BrustPage` tag name (see
    /// `lower::lower_brust_page`), so a local `components/BrustPage.tsx` can
    /// never shadow it. Only valid as the route's root element.
    Document {
        /// `<html lang="…">` — `lang` prop. Defaults to `"en"` when omitted.
        lang: Option<String>,
        /// `<html class="…">` — `className` prop.
        html_class: Option<String>,
        /// `<body class="…">` — `bodyClassName` prop.
        body_class: Option<String>,
        /// `<title>…</title>` — `title` prop. Omitted entirely when absent.
        title: Option<String>,
        /// `<meta name="description" content="…">` — `description` prop.
        description: Option<String>,
        /// Page body — every `<BrustPage>` child (all become `<body>` content).
        body: Vec<JsxNode>,
    },
    /// Non-Island capitalized component on a native route. Lowered from any
    /// capitalised tag that is not `<Island>` or `<BrustPage>`. The emitter
    /// outputs a `{{ comp_N_html | safe }}` slot; the JS worker fills it via a
    /// generated factory function.
    SsrComponent {
        /// Source identifier from the tag name (e.g. `Layout`).
        component: String,
        /// Source-order index among SSR components (set by `number_ssr_components`).
        instance: usize,
        /// Lowered props (named attrs + `{...spread}`), in SOURCE ORDER — order
        /// is load-bearing for object-spread override semantics in the factory.
        props: Vec<SsrProp>,
        /// Lowered children (may contain Islands, elements, etc.).
        children: Vec<JsxNode>,
        /// Optional ISR cache key path (dotted loader-data path). `None` = no ISR.
        key_path: Option<String>,
        /// ISR key as a string LITERAL (static cache identity). Mutually exclusive with key_path.
        key_literal: Option<String>,
        /// Optional ISR cache tags path (resolves to `string[]`).
        tags_path: Option<String>,
        /// ISR tags as string LITERALS. Mutually exclusive with tags_path.
        tags_literal: Option<Vec<String>>,
        /// Optional ISR revalidation interval in seconds (TTL).
        revalidate: Option<u32>,
    },
    /// Conditional expression: `{test ? consequent : alternate}`.
    /// `alternate` is `None` when there is no false-branch (unary ternary).
    Cond {
        test: Expr,
        consequent: Box<JsxNode>,
        alternate: Option<Box<JsxNode>>,
    },
    /// Slot that expands to the component's children at the call site.
    ChildrenSlot,
    /// JSX fragment (`<>…</>`). Emits its children concatenated with NO wrapping
    /// element — a pure grouping node. Children are lowered through the same
    /// `lower_child` path as host-element children, so islands / SSR components /
    /// Cond / Map / nested fragments are all valid inside one. A fragment as a
    /// DIRECT child of an SSR component is rejected at lower time
    /// (`FragmentInSsrComponentNotSupported`); see `lower_ssr_component`.
    Fragment {
        children: Vec<JsxNode>,
    },
    /// Interactive island embedded in a native (jinja) route. Lowered from a
    /// dedicated `<Island component={C} props={path} hydrate="..." ssr/>`
    /// recognition path (see `lower::lower_island`). The emitter renders a
    /// placeholder + manifest hook; the manifest keys off `component`/`instance`.
    Island {
        /// Source identifier from `component={Ident}` — the chunk key.
        component: String,
        /// Source-order index within this template (set by `number_islands`).
        instance: usize,
        /// Single-segment path into the route's prop context (the leaf segment
        /// of `props={...}`). NOT a full member chain in v1.
        props_path: String,
        /// Hydration strategy — one of `load`/`idle`/`visible`/`interaction`.
        hydrate: String,
        /// Whether to server-render the island's initial markup (`ssr` bare attr).
        ssr: bool,
        /// Optional ISR cache key path (single-segment prop path). `None` until
        /// the isr-attribute parser lands.
        key_path: Option<String>,
        /// ISR key as a string LITERAL (static cache identity). Mutually exclusive with key_path.
        key_literal: Option<String>,
        /// Optional ISR cache tags path (single-segment prop path). `None` until
        /// the isr-attribute parser lands.
        tags_path: Option<String>,
        /// ISR tags as string LITERALS. Mutually exclusive with tags_path.
        tags_literal: Option<Vec<String>>,
        /// Optional ISR revalidation interval in seconds. `None` until the
        /// isr-attribute parser lands.
        revalidate: Option<u32>,
    },
}

#[derive(Debug, Clone)]
pub struct JsxAttr {
    pub name: String,
    pub value: AttrValue,
}

/// One prop on an `SsrComponent`. Unlike host-element attributes (which emit to
/// static Jinja and so cannot accept a runtime spread), SSR-component props are
/// emitted into a JS `createElement` call, where `{...expr}` is a natural object
/// spread. Source order is preserved so spread/named override semantics match
/// React.
#[derive(Debug, Clone)]
pub enum SsrProp {
    /// Named attribute: `title={x}`, `label="foo"`, or bare boolean `disabled`.
    Attr(JsxAttr),
    /// Spread `{...expr}` — becomes a JS object spread `...<expr>` in the factory.
    Spread(Expr),
}

#[derive(Debug, Clone)]
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
    /// Arithmetic binary expression, e.g. `a + b`.
    Arith {
        op: ArithOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// String/value concatenation of multiple expressions.
    Concat(Vec<Expr>),
    /// Jinja-style filter: `value | name(args…)`.
    Filter {
        value: Box<Expr>,
        name: String,
        args: Vec<Expr>,
    },
    /// Comparison expression, e.g. `a == b`.
    Compare {
        op: CmpOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// Logical binary expression, e.g. `a && b`.
    Logical {
        op: LogOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// Logical negation, e.g. `!a`.
    Not(Box<Expr>),
}

/// Arithmetic operator.
#[derive(Debug, Clone, PartialEq)]
pub enum ArithOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

/// Comparison operator.
#[derive(Debug, Clone, PartialEq)]
pub enum CmpOp {
    Eq,
    Ne,
    Gt,
    Lt,
    Ge,
    Le,
}

/// Logical binary operator.
#[derive(Debug, Clone, PartialEq)]
pub enum LogOp {
    And,
    Or,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_node_clones() {
        let original = JsxNode::Fragment {
            children: vec![JsxNode::Text("a".into()), JsxNode::Text("b".into())],
        };
        let cloned = original.clone();
        assert_eq!(format!("{:?}", original), format!("{:?}", cloned));
    }

    #[test]
    fn cond_node_clones() {
        let original = JsxNode::Cond {
            test: Expr::Field("flag".into()),
            consequent: Box::new(JsxNode::Text("yes".into())),
            alternate: Some(Box::new(JsxNode::Text("no".into()))),
        };
        let cloned = original.clone();
        assert_eq!(format!("{:?}", original), format!("{:?}", cloned));
    }

    #[test]
    fn expr_variants_construct() {
        let variants: Vec<Expr> = vec![
            Expr::Arith {
                op: ArithOp::Add,
                lhs: Box::new(Expr::StaticNum(1)),
                rhs: Box::new(Expr::StaticNum(2)),
            },
            Expr::Concat(vec![
                Expr::StaticText("a".into()),
                Expr::StaticText("b".into()),
            ]),
            Expr::Filter {
                value: Box::new(Expr::Field("x".into())),
                name: "upper".into(),
                args: vec![],
            },
            Expr::Compare {
                op: CmpOp::Eq,
                lhs: Box::new(Expr::Field("a".into())),
                rhs: Box::new(Expr::Field("b".into())),
            },
            Expr::Logical {
                op: LogOp::And,
                lhs: Box::new(Expr::Field("p".into())),
                rhs: Box::new(Expr::Field("q".into())),
            },
            Expr::Not(Box::new(Expr::Field("flag".into()))),
        ];
        for e in &variants {
            assert!(!format!("{:?}", e).is_empty());
        }
    }
}
