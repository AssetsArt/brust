//! The template tree (spec §5.2).
use crate::ir::expr::Expr;
use serde::{Deserialize, Serialize};

/// HTML void elements: no content, no end tag.
pub const VOID: &[&str] = &[
    "img", "input", "br", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track",
    "wbr",
];

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
        /// A wrapper the compiler added around a root that is not one element (`host_root`). A static
        /// component prints only its children; an interactive one keeps the `<brust-host>` element.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        synthetic: bool,
        /// The element of the component's polymorphic tag (`<Comp>` of `const Comp = asChild ?
        /// Slot.Root : "button"`, `ComponentIR::poly`): `tag` is the host it prints as without
        /// `asChild`; a call site with a literal `asChild` prints its child element instead.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        poly: bool,
    },
    Text(String),
    Slot(Expr),
    If {
        cond: Expr,
        then: Vec<Node>,
        else_: Vec<Node>,
        /// The `cond && <X/>` form (no else): React renders a falsy number (`0`) as text there, where
        /// `cond ? <X/> : null` renders nothing. Only the island-children lowering reads it (F148a).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        and: bool,
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
        /// A member of the imported binding (`<DialogPrimitive.Root>`: `["Root"]`), shadcn S1.4 (R34.35);
        /// empty for every other component.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        member: Vec<String>,
        props: Vec<(String, Expr)>,
        children: Vec<Node>,
        link: Option<u32>,
        /// The child's tier (M1b-2 children pass); `Pending` until resolved.
        tier: crate::ir::Tier,
        /// `ref={ref}` passes this component's own forwarded ref on (F153c): fine when the child is a `forwardRef`
        /// component that drops it on a host element (R34.64), `forwardref-ref` otherwise.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        forwarded_ref: bool,
    },
    Fragment(Vec<Node>),
    /// `<Outlet />` from `@brust/core/routes` (S8): the server's child slot, printed as `{{ __outlet | safe }}`.
    Outlet,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Attr {
    Static {
        name: String,
        value: String,
    },
    Dynamic {
        name: String,
        value: Expr,
    },
    Event {
        event: String,
        handler: String,
    },
    Ref {
        name: String,
    },
    /// `ref={forwardedRef}` on this element (F267): where the ref a `forwardRef` component's caller passes lands. Prints
    /// nothing of its own; a caller that binds a ref of its own on an inlined instance prints `x-ref` here.
    ForwardRef,
    Spread(Expr),
    /// `dangerouslySetInnerHTML={{ __html: v }}`: `value` is the already-unwrapped `v`
    /// (null-safe `o.__html` for a non-literal object). Printed through the one raw sink.
    InnerHtml {
        value: Expr,
    },
}
