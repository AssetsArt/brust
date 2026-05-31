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
        /// Lowered attrs via dedicated camelCase-safe attr loop.
        props: Vec<JsxAttr>,
        /// Lowered children (may contain Islands, elements, etc.).
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
        /// Optional ISR cache tags path (single-segment prop path). `None` until
        /// the isr-attribute parser lands.
        tags_path: Option<String>,
        /// Optional ISR revalidation interval in seconds. `None` until the
        /// isr-attribute parser lands.
        revalidate: Option<u32>,
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
