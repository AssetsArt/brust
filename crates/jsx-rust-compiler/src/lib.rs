pub mod analyze;
mod emit_factory;
mod emit_jinja;
pub mod filters;
mod ir;
mod lower;
pub mod parser;
mod static_eval;
mod xfor;

use ir::JsxNode;
use std::collections::HashMap;

pub fn compile(source: &str) -> Result<String, CompileError> {
    compile_with_path(source, "<stdin>")
}

/// Back-compat wrapper: returns only the emitted jinja template. The golden
/// harness depends on this signature, so it stays a thin delegate to
/// `compile_full` (which also collects the island manifest).
pub fn compile_with_path(source: &str, path: &str) -> Result<String, CompileError> {
    compile_full(source, path, HashMap::new(), HashMap::new(), HashMap::new()).map(|c| c.template)
}

/// Result of a full compile: the jinja template plus the island manifest
/// collected from the lowered IR. The bin (`jsx-rustc`) writes the template to
/// `-o` and, when islands are present, a sibling `.islands.json` manifest.
#[derive(Debug)]
pub struct Compiled {
    pub template: String,
    pub islands: Vec<IslandMeta>,
    pub components: Vec<ComponentMeta>,
    /// Non-fatal diagnostic messages collected during compilation (e.g. from
    /// native-inline lowering). Empty when no `component_sources` are supplied.
    pub warnings: Vec<String>,
}

/// One entry in the SSR-component manifest. Parallel to `IslandMeta`.
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentMeta {
    /// Identifier from the JSX tag name, e.g. `"Layout"`.
    pub component: String,
    /// Source-order index among SSR components on this page.
    pub instance: usize,
    /// The `(ctx) => h(Component, {…}, …)` TypeScript factory expression.
    pub factory_expr: String,
    /// All component-identifier names referenced inside the factory expression
    /// (the SSR component itself + Island component names). The TS build step
    /// imports each from `pageImports`. Includes duplicates if referenced
    /// multiple times — the TS side dedupes.
    pub referenced_components: Vec<String>,
    /// True if any `<Island>` node appears in this component's factory tree.
    /// When true the TS build step adds `import { Island } from 'brustjs'`.
    pub uses_island: bool,
    /// Optional ISR cache key path (dotted loader-data path). `None` = no ISR.
    pub key_path: Option<String>,
    /// ISR key as a string LITERAL (static cache identity). Mutually exclusive with key_path.
    pub key_literal: Option<String>,
    /// Optional ISR cache tags path (resolves to `string[]`).
    pub tags_path: Option<String>,
    /// ISR tags as string LITERALS. Mutually exclusive with tags_path.
    pub tags_literal: Option<Vec<String>>,
    /// Optional ISR revalidation interval in seconds (TTL).
    pub revalidate: Option<u32>,
}

/// One entry in the island manifest. Field order here is intentional and
/// independent of `JsxNode::Island`'s — always construct by field name, never
/// positionally.
#[derive(Debug, Clone, PartialEq)]
pub struct IslandMeta {
    pub component: String,
    pub instance: usize,
    pub props_path: String,
    pub ssr: bool,
    pub hydrate: String,
    pub key_path: Option<String>,
    pub key_literal: Option<String>,
    pub tags_path: Option<String>,
    pub tags_literal: Option<Vec<String>>,
    pub revalidate: Option<u32>,
}

/// Parse → lower → { emit template, collect islands, collect components }. The
/// single source of truth for compilation; `compile`/`compile_with_path` are
/// thin wrappers.
///
/// `component_sources` maps component ident → source text for native-inline
/// lowering (T6). Pass `HashMap::new()` for the legacy no-inline behaviour.
///
/// `lucide_icons` maps a local lucide tag name → its icon JSON (for compile-time
/// static-SVG emission). Pass `HashMap::new()` for the no-op path (byte-identical
/// to before this feature).
///
/// `directive_names` maps a native behavior-component ident → its app-unique
/// directive name (camelCase basename + hash). When a `<Comp native/>` inlined
/// here matches this map, the compiler auto-injects `x-data="<name>"` on its host
/// element. Pass `HashMap::new()` for the no-op path (byte-identical to before).
pub fn compile_full(
    source: &str,
    path: &str,
    component_sources: HashMap<String, String>,
    lucide_icons: HashMap<String, String>,
    directive_names: HashMap<String, String>,
) -> Result<Compiled, CompileError> {
    let parsed = parser::parse(source, path).map_err(|e| CompileError {
        path: path.to_string(),
        line: 0,
        col: 0,
        kind: ErrorKind::Parse(e.to_string()),
    })?;

    let (mut ir, warnings) =
        lower::lower_with_sources(&parsed, component_sources, lucide_icons, directive_names)
            .map_err(|e| CompileError::from_lower(e, path, &parsed))?;
    // Assign each island a source-order `instance` index. Runs after lower
    // (which sets `instance: 0` as a placeholder) and before emit/collect so
    // both read the final indices.
    let mut n = 0;
    number_islands(&mut ir.root, &mut n);
    let mut m = 0;
    number_ssr_components(&mut ir.root, &mut m);

    let template = emit_jinja::emit(&ir);
    let factory_outputs = emit_factory::emit(&ir); // Vec<FactoryOutput>

    let mut islands = Vec::new();
    collect_islands(&ir.root, &mut islands);

    let mut components: Vec<ComponentMeta> = Vec::new();
    collect_components(&ir.root, &mut components);
    // Zip factory outputs into component entries (same source order).
    debug_assert_eq!(
        components.len(),
        factory_outputs.len(),
        "collect_components and emit_factory must walk the IR identically"
    );
    for (comp, fo) in components.iter_mut().zip(factory_outputs) {
        comp.factory_expr = fo.expr;
        comp.referenced_components = fo.referenced;
        comp.uses_island = fo.uses_island;
    }

    Ok(Compiled {
        template,
        islands,
        components,
        warnings,
    })
}

/// Walk the IR in source order, assigning each `JsxNode::Island` a monotonically
/// increasing `instance` index. The chunk key is the `component` ident; the
/// instance index disambiguates multiple occurrences (incl. duplicate
/// components) on the per-occurrence jinja context keys `island_<instance>_*`.
fn number_islands(node: &mut JsxNode, counter: &mut usize) {
    match node {
        JsxNode::Island { instance, .. } => {
            *instance = *counter;
            *counter += 1;
        }
        JsxNode::Element { children, .. } => {
            for c in children {
                number_islands(c, counter);
            }
        }
        // Body-only: head is props (compile-time literals), never islands.
        JsxNode::Document { body, .. } => {
            for c in body {
                number_islands(c, counter);
            }
        }
        JsxNode::Map { body, .. } => number_islands(body, counter),
        JsxNode::SsrComponent { children, .. } => {
            for c in children {
                number_islands(c, counter);
            }
        }
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) | JsxNode::RawHtml(_) => {}
        JsxNode::Cond {
            consequent,
            alternate,
            ..
        } => {
            number_islands(consequent, counter);
            if let Some(alt) = alternate {
                number_islands(alt, counter);
            }
        }
        JsxNode::ChildrenSlot => {}
        JsxNode::Fragment { children } => {
            for c in children {
                number_islands(c, counter);
            }
        }
    }
}

/// Depth-first pre-order walk collecting every `JsxNode::Island` in source
/// order. Recurses into `Element.children` and `Map.body`. Islands inside a
/// `.map()` are rejected at lower time, so none will appear under a `Map` —
/// but we walk `Map.body` anyway for completeness.
fn collect_islands(node: &JsxNode, out: &mut Vec<IslandMeta>) {
    match node {
        JsxNode::Island {
            component,
            instance,
            props_path,
            hydrate,
            ssr,
            key_path,
            key_literal,
            tags_path,
            tags_literal,
            revalidate,
        } => {
            out.push(IslandMeta {
                component: component.clone(),
                instance: *instance,
                props_path: props_path.clone(),
                ssr: *ssr,
                hydrate: hydrate.clone(),
                key_path: key_path.clone(),
                key_literal: key_literal.clone(),
                tags_path: tags_path.clone(),
                tags_literal: tags_literal.clone(),
                revalidate: *revalidate,
            });
        }
        JsxNode::Element { children, .. } => {
            for child in children {
                collect_islands(child, out);
            }
        }
        // Body-only — same as `number_islands`/`emit`.
        JsxNode::Document { body, .. } => {
            for child in body {
                collect_islands(child, out);
            }
        }
        JsxNode::Map { body, .. } => collect_islands(body, out),
        // Islands inside SSR components are NOT in .islands.json — their props
        // are written by Island.tsx React-path render into the DOM directly.
        JsxNode::SsrComponent { .. } => {}
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) | JsxNode::RawHtml(_) => {}
        JsxNode::Cond {
            consequent,
            alternate,
            ..
        } => {
            collect_islands(consequent, out);
            if let Some(alt) = alternate {
                collect_islands(alt, out);
            }
        }
        JsxNode::ChildrenSlot => {}
        JsxNode::Fragment { children } => {
            for c in children {
                collect_islands(c, out);
            }
        }
    }
}

/// Assign source-order `instance` indices to every TOP-LEVEL `SsrComponent`
/// node. Does NOT recurse into `SsrComponent.children` — nested SSR
/// components render inline inside their parent's factory, not as separate
/// `{{ comp_N_html }}` slots.
fn number_ssr_components(node: &mut JsxNode, counter: &mut usize) {
    match node {
        JsxNode::SsrComponent { instance, .. } => {
            *instance = *counter;
            *counter += 1;
            // Do not recurse into children — nested SSR components are not
            // separately numbered/tracked (they render inside parent factory).
        }
        JsxNode::Element { children, .. } => {
            for c in children {
                number_ssr_components(c, counter);
            }
        }
        JsxNode::Document { body, .. } => {
            for c in body {
                number_ssr_components(c, counter);
            }
        }
        JsxNode::Map { body, .. } => number_ssr_components(body, counter),
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::RawHtml(_)
        | JsxNode::Island { .. } => {}
        JsxNode::Cond {
            consequent,
            alternate,
            ..
        } => {
            number_ssr_components(consequent, counter);
            if let Some(alt) = alternate {
                number_ssr_components(alt, counter);
            }
        }
        JsxNode::ChildrenSlot => {}
        JsxNode::Fragment { children } => {
            for c in children {
                number_ssr_components(c, counter);
            }
        }
    }
}

/// Depth-first pre-order walk collecting every TOP-LEVEL `SsrComponent` in
/// source order. Does NOT recurse into `SsrComponent.children`. `factory_expr`
/// is left empty — `compile_full` fills it from `emit_factory::emit`.
fn collect_components(node: &JsxNode, out: &mut Vec<ComponentMeta>) {
    match node {
        JsxNode::SsrComponent {
            component,
            instance,
            key_path,
            key_literal,
            tags_path,
            tags_literal,
            revalidate,
            ..
        } => {
            // Don't recurse — nested SSR components render inside parent factory.
            out.push(ComponentMeta {
                component: component.clone(),
                instance: *instance,
                factory_expr: String::new(),
                referenced_components: Vec::new(),
                uses_island: false,
                key_path: key_path.clone(),
                key_literal: key_literal.clone(),
                tags_path: tags_path.clone(),
                tags_literal: tags_literal.clone(),
                revalidate: *revalidate,
            });
        }
        JsxNode::Element { children, .. } => {
            for child in children {
                collect_components(child, out);
            }
        }
        JsxNode::Document { body, .. } => {
            for child in body {
                collect_components(child, out);
            }
        }
        JsxNode::Map { body, .. } => collect_components(body, out),
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::RawHtml(_)
        | JsxNode::Island { .. } => {}
        JsxNode::Cond {
            consequent,
            alternate,
            ..
        } => {
            collect_components(consequent, out);
            if let Some(alt) = alternate {
                collect_components(alt, out);
            }
        }
        JsxNode::ChildrenSlot => {}
        JsxNode::Fragment { children } => {
            for c in children {
                collect_components(c, out);
            }
        }
    }
}

/// Hand-rolled compact JSON for the island manifest (serde is intentionally
/// absent from this crate's deps). Keys are camelCase: `component`, `instance`,
/// `propsPath`, `ssr`, `hydrate`. `instance` is a bare number, `ssr` a bare
/// bool. Empty slice → `[]`. Matches what the TS build/runtime will `JSON.parse`.
pub fn islands_to_json(islands: &[IslandMeta]) -> String {
    let mut out = String::from("[");
    for (i, isl) in islands.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"component\":\"");
        out.push_str(&json_escape(&isl.component));
        out.push_str("\",\"instance\":");
        out.push_str(&isl.instance.to_string());
        out.push_str(",\"propsPath\":\"");
        out.push_str(&json_escape(&isl.props_path));
        out.push_str("\",\"ssr\":");
        out.push_str(if isl.ssr { "true" } else { "false" });
        out.push_str(",\"hydrate\":\"");
        out.push_str(&json_escape(&isl.hydrate));
        out.push('"');
        if let Some(kp) = &isl.key_path {
            out.push_str(",\"keyPath\":\"");
            out.push_str(&json_escape(kp));
            out.push('"');
        }
        if let Some(tp) = &isl.tags_path {
            out.push_str(",\"tagsPath\":\"");
            out.push_str(&json_escape(tp));
            out.push('"');
        }
        if let Some(kl) = &isl.key_literal {
            out.push_str(",\"keyLiteral\":\"");
            out.push_str(&json_escape(kl));
            out.push('"');
        }
        if let Some(tl) = &isl.tags_literal {
            out.push_str(",\"tagsLiteral\":[");
            for (j, t) in tl.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                out.push('"');
                out.push_str(&json_escape(t));
                out.push('"');
            }
            out.push(']');
        }
        if let Some(r) = isl.revalidate {
            out.push_str(",\"revalidate\":");
            out.push_str(&r.to_string());
        }
        out.push('}');
    }
    out.push(']');
    out
}

/// Hand-rolled JSON for the component manifest. Mirrors `islands_to_json`.
/// Keys: `component`, `instance`, `factoryExpr`, `referencedComponents`,
/// `usesIsland`, and (when set) `keyPath`/`tagsPath`/`revalidate`. Empty slice → `"[]"`.
pub fn components_to_json(components: &[ComponentMeta]) -> String {
    if components.is_empty() {
        return "[]".to_string();
    }
    let mut out = String::from("[");
    for (i, c) in components.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"component\":\"");
        out.push_str(&json_escape(&c.component));
        out.push_str("\",\"instance\":");
        out.push_str(&c.instance.to_string());
        out.push_str(",\"factoryExpr\":\"");
        out.push_str(&json_escape(&c.factory_expr));
        out.push_str("\",\"referencedComponents\":[");
        for (j, r) in c.referenced_components.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push('"');
            out.push_str(&json_escape(r));
            out.push('"');
        }
        out.push_str("],\"usesIsland\":");
        out.push_str(if c.uses_island { "true" } else { "false" });
        if let Some(kp) = &c.key_path {
            out.push_str(",\"keyPath\":\"");
            out.push_str(&json_escape(kp));
            out.push('"');
        }
        if let Some(tp) = &c.tags_path {
            out.push_str(",\"tagsPath\":\"");
            out.push_str(&json_escape(tp));
            out.push('"');
        }
        if let Some(kl) = &c.key_literal {
            out.push_str(",\"keyLiteral\":\"");
            out.push_str(&json_escape(kl));
            out.push('"');
        }
        if let Some(tl) = &c.tags_literal {
            out.push_str(",\"tagsLiteral\":[");
            for (j, t) in tl.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                out.push('"');
                out.push_str(&json_escape(t));
                out.push('"');
            }
            out.push(']');
        }
        if let Some(r) = c.revalidate {
            out.push_str(",\"revalidate\":");
            out.push_str(&r.to_string());
        }
        out.push('}');
    }
    out.push(']');
    out
}

/// Escape a string value for embedding in JSON. Single pass, char-by-char (a
/// chained `.replace` would double-escape). Covers backslash, double-quote, and
/// the common control chars; other controls are passed through verbatim since
/// the manifest's values are constrained, but the helper is correct for the
/// fields it does handle.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out
}

#[derive(Debug, thiserror::Error)]
#[error("{path}:{line}:{col}: {kind}")]
pub struct CompileError {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub kind: ErrorKind,
}

#[derive(Debug, thiserror::Error)]
pub enum ErrorKind {
    #[error("parse error: {0}")]
    Parse(String),
    #[error("expected single `export default function`, found other top-level statement")]
    UnexpectedStatement,
    #[error("function body must be a single `return <jsx>;`")]
    BodyMustBeSingleReturn,
    #[error("unsupported function parameter pattern")]
    UnsupportedParam,
    #[error("custom component `<{0}/>` not supported in Phase A1")]
    CustomComponentNotSupported(String),
    #[error("namespaced JSX element not supported")]
    NamespacedElementNotSupported,
    #[error("member-expression JSX element not supported")]
    MemberComponentNotSupported,
    #[error("fragments not supported in Phase A1")]
    FragmentNotSupported,
    #[error("namespaced attribute not supported")]
    NamespacedAttrNotSupported,
    #[error("event handler `{0}` not supported (handled by islands in Phase A3)")]
    EventHandlerNotSupported(String),
    #[error("`ref` attribute not supported")]
    RefAttributeNotSupported,
    #[error("JSX in attribute position not supported")]
    JsxInAttrNotSupported,
    #[error("spread attribute not supported")]
    SpreadAttributeNotSupported,
    #[error("spread child not supported")]
    SpreadChildNotSupported,
    #[error("fragment `<>…</>` inside an SSR component not supported — wrap it in an element")]
    FragmentInSsrComponentNotSupported,
    #[error("unresolved identifier `{0}`")]
    UnresolvedIdent(String),
    #[error("bare identifier `{0}` in JSX not supported in Phase A1")]
    BareIdentNotSupported(String),
    #[error("computed member access not supported")]
    ComputedAccessNotSupported,
    #[error("template literals not supported in Phase A1")]
    TemplateLiteralNotSupported,
    #[error("function call expression not supported in Phase A1")]
    CallExpressionNotSupported,
    #[error("complex expression (binary/conditional/unary) not supported in Phase A1")]
    ComplexExpressionNotSupported,
    #[error("`style` object: only `key: value` entries are supported (no spread/computed keys)")]
    StyleObjectNotSupported,
    #[error("`style` object value not supported — use a string/number literal or a member-path")]
    StyleObjectValueNotSupported,
    #[error("`.map((item, idx) => …)` two-arg form not supported in Phase A1")]
    MapIndexParamNotSupported,
    #[error("`.map(...)` shape not supported — expect `(ident) => <JSXElement>`")]
    MapShapeNotSupported,
    #[error(
        "`.map()` with a bare `x-for` flag requires `key={{item.path}}` — a single member path on the map item; use the explicit `x-for=\"… by …\"` for other keys"
    )]
    MapXForKeyRequired,
    #[error(
        "`.map()` bare `x-for` flag requires a single JSX element body (no conditional/fragment); use the explicit `x-for` form"
    )]
    MapXForBodyNotElement,
    #[error("`.map()` bare `x-for` flag requires the map source to be a loader array path")]
    MapXForSourceNotArray,
    #[error("non-integer numeric literal not supported in Phase A1")]
    NonIntegerNumericNotSupported,
    #[error("void element `<{0}>` cannot have children")]
    VoidElementHasChildren(String),
    #[error("unknown attribute rename `{0}` — uppercase letters require a rename-table entry")]
    UnknownAttributeRename(String),
    #[error("prop `{0}` used as both value and collection — type conflict")]
    PropTypeConflict(String),
    #[error("`<Island>` requires a `component={{Ident}}` attribute naming the island component")]
    IslandMissingComponent,
    #[error(
        "`<Island props={{…}}>` path unsupported — expect a destructured prop or one-deep member off one (e.g. `counter` or `data.counter`)"
    )]
    IslandPropsPathUnsupported,
    #[error(
        "`isr` attribute must be `{{ key: <path>, tags?: <path>, revalidate?: <number-literal> }}` with `ssr`"
    )]
    IslandIsrUnsupported,
    #[error("`<Island hydrate=\"{0}\">` invalid — expect one of load/idle/visible/interaction")]
    IslandBadHydrate(String),
    #[error(
        "`<Island>` inside `.map(...)` not supported — id would collide across iterations and the props path can't be per-iteration in v1"
    )]
    IslandInMapNotSupported,
    #[error(
        "`<{0}/>` SSR component inside `.map(...)` not supported — instance would collide across iterations"
    )]
    SsrComponentInMapNotSupported(String),
    #[error(
        "`isr` on `<{0}/>` must be `{{ key: <path>, tags?: <path>, revalidate?: <number-literal> }}`"
    )]
    ComponentIsrUnsupported(String),
    #[error(
        "`<Island>` must be self-closing — children are not supported (the component renders client-side)"
    )]
    IslandHasChildren,
    #[error(
        "`<Island id=…>` is no longer supported — islands are addressed by `component={{…}}`; remove the `id` attribute"
    )]
    IslandIdAttrRemoved,
    #[error(
        "`<Island component={{{0}}}>` — component name must match [A-Za-z0-9_]+ (it becomes the chunk filename and DOM marker)"
    )]
    IslandBadComponentName(String),
    #[error(
        "`<BrustPage>` must be the route's root element — it owns the document shell and cannot be nested"
    )]
    BrustPageMustBeRoot,
    #[error(
        "`<Outlet/>` must be empty and self-closing — it marks where child routes render and takes no attributes or children"
    )]
    OutletMustBeEmpty,
    #[error(
        "`<Outlet/>` is only valid inside a layout component that wraps child routes — it cannot appear in a standalone route with no children to inject"
    )]
    OutletOutsideLayout,
    #[error(
        "`<BrustPage {0}=…>` must be a string literal (e.g. `{0}=\"…\"`) or a member-path (e.g. `{0}={{data.{0}}}`) — the document shell is rendered in Rust, so its attributes can't be call/arithmetic/spread expressions"
    )]
    BrustPageAttrMustBeStringLiteral(String),
    #[error(
        "`<BrustPage {0}=…>` is not a valid data-* attribute name (use lowercase letters, digits, hyphens, e.g. `data-mode`)"
    )]
    InvalidDataAttrName(String),
    #[error(
        "`<BrustPage>` owns `<head>` — a literal `<head>` child is not supported; set head tags via props instead (e.g. `title=\"…\"`, `description=\"…\"`)"
    )]
    BrustPageLiteralHeadNotSupported,
    #[error("`<BrustPage head>` must be an array literal of head-entry objects")]
    BrustPageHeadMustBeArray,
    #[error(
        "each `<BrustPage head>` entry must be an object literal with a `tag` of link|meta|base|style|script|noscript"
    )]
    BrustPageHeadEntryInvalid,
    #[error(
        "`text` in a `<BrustPage head>` entry must be a string literal — use a literal; dynamic text is only supported on style entries"
    )]
    BrustPageHeadTextMustBeLiteral,
    #[error("`text` is not allowed on a void head tag (link/meta/base)")]
    BrustPageHeadTextOnVoid,
    #[error("`dangerouslySetInnerHTML` must be `{{ __html: <string literal | member-path> }}`")]
    DangerouslySetInnerHtmlInvalid,
    #[error("an element with `dangerouslySetInnerHTML` cannot also have children")]
    DangerouslySetInnerHtmlWithChildren,
    #[error("inline lowering cannot translate `{0}` — expression is too complex for inline mode")]
    InlineUntranslatable(String),
    #[error("static evaluation: {0}")]
    StaticEvaluation(String),
    #[error("circular native inline: {0}")]
    CircularInline(String),
    #[error(
        "native component `<{0}>` has `export const behavior` but its root is {1}, not a single element to host its mount; tag the host with a bare `x-behavior` or wrap it in one root element."
    )]
    BehaviorHostNotElement(String, &'static str),
    #[error(
        "native component `<{0}>` has more than one `x-behavior` marker or a valued `x-behavior` — exactly one bare `x-behavior` may mark the mount host"
    )]
    XBehaviorMisuse(String),
}

impl CompileError {
    pub(crate) fn from_lower(
        err: lower::LowerError,
        path: &str,
        parsed: &parser::ParsedSource,
    ) -> Self {
        let (line, col) = span_to_line_col(&err.span, parsed);
        Self {
            path: path.to_string(),
            line,
            col,
            kind: err.kind,
        }
    }
}

fn span_to_line_col(span: &swc_core::common::Span, parsed: &parser::ParsedSource) -> (u32, u32) {
    // A default/synthetic span (`Span::default()`, lo == BytePos(0)) has no source
    // location — swc reserves BytePos(0) as the dummy position, and `lookup_char_pos`
    // panics (`NoFileFor`) on it. Surface `(0, 0)` so such diagnostics report cleanly
    // instead of aborting the build with an opaque swc panic.
    if span.lo.0 == 0 {
        return (0, 0);
    }
    let loc = parsed.source_map.lookup_char_pos(span.lo);
    (loc.line as u32, loc.col.0 as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_error_formats_with_path() {
        let err = compile_with_path("export default function;", "fixtures/bad.tsx").unwrap_err();
        let formatted = format!("{err}");
        assert!(
            formatted.starts_with("fixtures/bad.tsx:0:0: parse error:"),
            "got: {formatted}"
        );
    }

    #[test]
    fn compile_full_collects_islands_in_source_order() {
        // Two sibling islands inside a <div>: one ssr, one client-only.
        let src = r#"export default function Page({ data }) {
  return <div>
    <Island component={A} props={data.a} ssr />
    <Island component={B} props={data.b} hydrate="visible" />
  </div>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.islands,
            vec![
                IslandMeta {
                    component: "A".to_string(),
                    instance: 0,
                    props_path: "data.a".to_string(),
                    ssr: true,
                    hydrate: "load".to_string(),
                    key_path: None,
                    key_literal: None,
                    tags_path: None,
                    tags_literal: None,
                    revalidate: None,
                },
                IslandMeta {
                    component: "B".to_string(),
                    instance: 1,
                    props_path: "data.b".to_string(),
                    ssr: false,
                    hydrate: "visible".to_string(),
                    key_path: None,
                    key_literal: None,
                    tags_path: None,
                    tags_literal: None,
                    revalidate: None,
                },
            ]
        );
        // template is the emitted jinja (non-empty, contains the wrapping div).
        assert!(c.template.contains("<div>"), "got: {}", c.template);
    }

    #[test]
    fn compile_full_no_islands_yields_empty_vec() {
        let src = "export default function Page() { return <p>hi</p>; }";
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(c.islands, vec![]);
    }

    #[test]
    fn compile_full_allows_duplicate_components_distinct_instances() {
        // Two `<Island component={C}/>` siblings now share the chunk key `C` but
        // get distinct source-order `instance` indices — NO error.
        let src = r#"export default function Page({ data }) {
  return <div><Island component={C} props={data.a} /><Island component={C} props={data.b} /></div>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.islands,
            vec![
                IslandMeta {
                    component: "C".to_string(),
                    instance: 0,
                    props_path: "data.a".to_string(),
                    ssr: false,
                    hydrate: "load".to_string(),
                    key_path: None,
                    key_literal: None,
                    tags_path: None,
                    tags_literal: None,
                    revalidate: None,
                },
                IslandMeta {
                    component: "C".to_string(),
                    instance: 1,
                    props_path: "data.b".to_string(),
                    ssr: false,
                    hydrate: "load".to_string(),
                    key_path: None,
                    key_literal: None,
                    tags_path: None,
                    tags_literal: None,
                    revalidate: None,
                },
            ]
        );
    }

    #[test]
    fn lower_rejects_id_attr() {
        // `id=` is no longer supported.
        let src = r#"export default function Page({ data }) {
  return <Island component={C} id="X" props={data.a} />;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::IslandIdAttrRemoved),
            "expected IslandIdAttrRemoved, got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_rejects_bad_component_name() {
        // `$` is a valid JS identifier char, so swc parses `Foo$Bar` as an
        // Ident — but it is not in `[A-Za-z0-9_]+`, so the charset validation
        // rejects it.
        let src = r#"export default function Page({ data }) {
  return <Island component={Foo$Bar} props={data.a} />;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        match err.kind {
            ErrorKind::IslandBadComponentName(name) => assert_eq!(name, "Foo$Bar"),
            other => panic!("expected IslandBadComponentName, got {other:?}"),
        }
    }

    #[test]
    fn island_nested_deep_in_elements_is_collected() {
        let src = r#"export default function Page({ data }) {
  return <main><section><Island component={Deep} props={data.x} /></section></main>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.islands,
            vec![IslandMeta {
                component: "Deep".to_string(),
                instance: 0,
                props_path: "data.x".to_string(),
                ssr: false,
                hydrate: "load".to_string(),
                key_path: None,
                key_literal: None,
                tags_path: None,
                tags_literal: None,
                revalidate: None,
            }]
        );
    }

    #[test]
    fn islands_to_json_golden() {
        let islands = vec![
            IslandMeta {
                component: "Counter".to_string(),
                instance: 0,
                props_path: "data.counter".to_string(),
                ssr: true,
                hydrate: "load".to_string(),
                key_path: None,
                key_literal: None,
                tags_path: None,
                tags_literal: None,
                revalidate: None,
            },
            // Exercise escaping: a backslash and a quote in props_path.
            IslandMeta {
                component: "Weird".to_string(),
                instance: 1,
                props_path: r#"a\b"c"#.to_string(),
                ssr: false,
                hydrate: "idle".to_string(),
                key_path: None,
                key_literal: None,
                tags_path: None,
                tags_literal: None,
                revalidate: None,
            },
        ];
        let json = islands_to_json(&islands);
        assert_eq!(
            json,
            r#"[{"component":"Counter","instance":0,"propsPath":"data.counter","ssr":true,"hydrate":"load"},{"component":"Weird","instance":1,"propsPath":"a\\b\"c","ssr":false,"hydrate":"idle"}]"#
        );
    }

    #[test]
    fn islands_to_json_with_isr_fields() {
        // isr fields present → keyPath/tagsPath/revalidate appear AFTER hydrate,
        // in that order. `revalidate` is a bare number (not quoted).
        let islands = vec![IslandMeta {
            component: "Counter".to_string(),
            instance: 0,
            props_path: "data.counter".to_string(),
            ssr: true,
            hydrate: "load".to_string(),
            key_path: Some("data.cacheKey".to_string()),
            key_literal: None,
            tags_path: Some("data.cacheTags".to_string()),
            tags_literal: None,
            revalidate: Some(60),
        }];
        let json = islands_to_json(&islands);
        assert_eq!(
            json,
            r#"[{"component":"Counter","instance":0,"propsPath":"data.counter","ssr":true,"hydrate":"load","keyPath":"data.cacheKey","tagsPath":"data.cacheTags","revalidate":60}]"#
        );
    }

    #[test]
    fn islands_to_json_empty_is_bracket_pair() {
        assert_eq!(islands_to_json(&[]), "[]");
    }

    #[test]
    fn islands_to_json_with_literal_isr() {
        let islands = vec![IslandMeta {
            component: "Counter".to_string(),
            instance: 0,
            props_path: "data.counter".to_string(),
            ssr: true,
            hydrate: "load".to_string(),
            key_path: None,
            tags_path: None,
            revalidate: Some(10),
            key_literal: Some("ssrCounter".to_string()),
            tags_literal: Some(vec!["nav".to_string()]),
        }];
        let json = islands_to_json(&islands);
        assert!(json.contains("\"keyLiteral\":\"ssrCounter\""), "{json}");
        assert!(json.contains("\"tagsLiteral\":[\"nav\"]"), "{json}");
    }

    #[test]
    fn brust_page_emits_shell_with_auto_css_and_head_props() {
        let src = r#"export default function Home({ clientProps, serverProps }) {
  return (
    <BrustPage lang="en" className="dark" bodyClassName="brust-body" title="Built to Brust" description="Bun + Rust SSR">
      <main>
        <Island component={Counter} props={clientProps} hydrate="load" />
        <Island component={Counter} props={serverProps} ssr hydrate="load" />
      </main>
    </BrustPage>
  );
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        let expected = concat!(
            "<html lang=\"en\" class=\"dark\">",
            "<head>",
            "<meta charset=\"utf-8\"/>",
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>",
            "<title>Built to Brust</title>",
            "<meta name=\"description\" content=\"Bun + Rust SSR\"/>",
            "<link rel=\"stylesheet\" href=\"/_brust/css/app.css\"/>",
            "{{ __brust_component_css__ | safe }}",
            "{{ __brust_store__ | safe }}",
            "</head>",
            "<body class=\"brust-body\">",
            "<main>",
            "<div data-brust-island=\"Counter\" data-brust-props=\"{{ island_0_props }}\" data-brust-hydrate=\"load\" data-brust-csr></div>",
            "<div data-brust-island=\"Counter\" data-brust-props=\"{{ island_1_props }}\" data-brust-hydrate=\"load\">{{ island_1_html | safe }}</div>",
            "</main>",
            "</body></html>",
        );
        assert_eq!(c.template, expected);
        // Both islands collected in source order with correct ssr flags.
        assert_eq!(c.islands.len(), 2);
        assert_eq!(c.islands[0].instance, 0);
        assert!(!c.islands[0].ssr);
        assert_eq!(c.islands[0].props_path, "clientProps");
        assert_eq!(c.islands[1].instance, 1);
        assert!(c.islands[1].ssr);
        assert_eq!(c.islands[1].props_path, "serverProps");
    }

    #[test]
    fn brust_page_defaults_lang_to_en_and_omits_optional_props() {
        let src = r#"export default function Home() {
  return <BrustPage><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.template,
            concat!(
                "<html lang=\"en\">",
                "<head>",
                "<meta charset=\"utf-8\"/>",
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>",
                "<link rel=\"stylesheet\" href=\"/_brust/css/app.css\"/>",
                "{{ __brust_component_css__ | safe }}",
                "{{ __brust_store__ | safe }}",
                "</head>",
                "<body><main>hi</main></body></html>",
            )
        );
    }

    #[test]
    fn brust_page_literal_head_is_rejected() {
        let src = r#"export default function Home() {
  return <BrustPage><head><title>x</title></head><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageLiteralHeadNotSupported),
            "expected BrustPageLiteralHeadNotSupported, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_nested_is_rejected() {
        let src = r#"export default function Home() {
  return <div><BrustPage><main>hi</main></BrustPage></div>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageMustBeRoot),
            "expected BrustPageMustBeRoot, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_member_path_attr_is_accepted() {
        // A member-path now threads into the head as `{{ data.lang }}` — no longer
        // rejected (S8). The bare destructured prop `lang` lowers to `Expr::Field`.
        let src = r#"export default function Home({ lang }) {
  return <BrustPage lang={lang}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template.contains("lang=\"{{ (lang) | e }}\""),
            "expected interpolated lang, got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_non_path_attr_is_rejected() {
        // A non-literal, non-path expression (call) is still rejected.
        let src = r#"export default function Home({ getLang }) {
  return <BrustPage lang={getLang()}><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        match err.kind {
            ErrorKind::BrustPageAttrMustBeStringLiteral(name) => assert_eq!(name, "lang"),
            other => panic!("expected BrustPageAttrMustBeStringLiteral, got {other:?}"),
        }
    }

    // ---- Feature A: `<BrustPage head={[…]}>` typed head-entry array ----

    #[test]
    fn brust_page_head_link_entry_emits_void_tag() {
        let src = r#"export default function Home() {
  return <BrustPage head={[{ tag: 'link', rel: 'icon', href: '/favicon.svg' }]}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template
                .contains("<link rel=\"icon\" href=\"/favicon.svg\"/>"),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_head_script_bool_attr_emits_presence() {
        let src = r#"export default function Home() {
  return <BrustPage head={[{ tag: 'script', src: '/x.js', defer: true }]}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template.contains("<script src=\"/x.js\" defer></script>"),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_head_style_text_emits_raw_inner() {
        let src = r#"export default function Home() {
  return <BrustPage head={[{ tag: 'style', text: '.x{}' }]}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template.contains("<style>.x{}</style>"),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_head_meta_member_path_is_escaped_interp() {
        let src = r#"export default function Home({ data }) {
  return <BrustPage head={[{ tag: 'meta', property: 'og:title', content: data.title }]}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template.contains("content=\"{{ (data.title) | e }}\""),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_head_cross_origin_maps_to_html_attr() {
        let src = r#"export default function Home() {
  return <BrustPage head={[{ tag: 'link', rel: 'preconnect', href: '/x', crossOrigin: 'anonymous' }]}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template.contains("crossorigin=\"anonymous\""),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_head_http_equiv_maps_to_html_attr() {
        let src = r#"export default function Home() {
  return <BrustPage head={[{ tag: 'meta', httpEquiv: 'content-security-policy', content: "default-src 'self'" }]}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template
                .contains("http-equiv=\"content-security-policy\""),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_head_non_array_is_rejected() {
        let src = r#"export default function Home() {
  return <BrustPage head={"x"}><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageHeadMustBeArray),
            "expected BrustPageHeadMustBeArray, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_head_entry_without_tag_is_rejected() {
        let src = r#"export default function Home() {
  return <BrustPage head={[{ rel: 'icon' }]}><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageHeadEntryInvalid),
            "expected BrustPageHeadEntryInvalid, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_head_style_dynamic_text_emits_style_safe() {
        // F1 (R2): member-path `text` on a STYLE entry is allowed and emits
        // through the `style_safe` filter (scrubs `</` → `<\/` at render to
        // block a `</style>` breakout; `| e` would corrupt CSS).
        let src = r#"export default function Home({ data }) {
  return <BrustPage head={[{ tag: 'style', text: data.css }]}><main>hi</main></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template
                .contains("<style>{{ (data.css) | style_safe }}</style>"),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn brust_page_head_dynamic_text_is_rejected() {
        // Dynamic `text` stays literal-only on script entries (XSS surface) —
        // only style entries accept member-path text (F1).
        let src = r#"export default function Home({ data }) {
  return <BrustPage head={[{ tag: 'script', text: data.js }]}><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageHeadTextMustBeLiteral),
            "expected BrustPageHeadTextMustBeLiteral, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_head_dynamic_text_on_void_tag_is_rejected() {
        // Dynamic text on a void tag (meta) keeps the literal-only error.
        let src = r#"export default function Home({ data }) {
  return <BrustPage head={[{ tag: 'meta', text: data.x }]}><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageHeadTextMustBeLiteral),
            "expected BrustPageHeadTextMustBeLiteral, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_head_text_on_void_tag_is_rejected() {
        let src = r#"export default function Home() {
  return <BrustPage head={[{ tag: 'link', text: 'x' }]}><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageHeadTextOnVoid),
            "expected BrustPageHeadTextOnVoid, got {:?}",
            err.kind
        );
    }

    // ---- Feature B: `dangerouslySetInnerHTML` on host elements ----

    #[test]
    fn dangerously_set_inner_html_member_path_emits_safe_filter() {
        let src = r#"export default function Home({ data }) {
  return <BrustPage><div dangerouslySetInnerHTML={{ __html: data.h }} /></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template.contains("<div>{{ (data.h) | safe }}</div>"),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn dangerously_set_inner_html_literal_emits_verbatim() {
        let src = r#"export default function Home() {
  return <BrustPage><div dangerouslySetInnerHTML={{ __html: "<b>x</b>" }} /></BrustPage>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.template.contains("<div><b>x</b></div>"),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn dangerously_set_inner_html_call_value_is_rejected() {
        let src = r#"export default function Home({ foo }) {
  return <BrustPage><div dangerouslySetInnerHTML={{ __html: foo() }} /></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::DangerouslySetInnerHtmlInvalid),
            "expected DangerouslySetInnerHtmlInvalid, got {:?}",
            err.kind
        );
    }

    #[test]
    fn dangerously_set_inner_html_with_children_is_rejected() {
        let src = r#"export default function Home({ data }) {
  return <BrustPage><div dangerouslySetInnerHTML={{ __html: data.h }}>child</div></BrustPage>;
}"#;
        let err = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::DangerouslySetInnerHtmlWithChildren),
            "expected DangerouslySetInnerHtmlWithChildren, got {:?}",
            err.kind
        );
    }

    #[test]
    fn ssr_component_emits_comp_slot() {
        let src = r#"export default function Page({ greeting }) {
  return <Layout title={greeting} />;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(c.template, "{{ comp_0_html | safe }}");
    }

    #[test]
    fn ssr_component_with_sibling_element() {
        let src = r#"export default function Page({ greeting }) {
  return <div><Header /><p>{greeting}</p></div>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.template,
            "<div>{{ comp_0_html | safe }}<p>{{ (greeting) | e }}</p></div>"
        );
    }

    #[test]
    fn ssr_component_multiple_in_source_order() {
        let src = r#"export default function Page({ a, b }) {
  return <div><Nav x={a} /><Sidebar y={b} /></div>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.template,
            "<div>{{ comp_0_html | safe }}{{ comp_1_html | safe }}</div>"
        );
        assert_eq!(c.components.len(), 2);
        assert_eq!(c.components[0].component, "Nav");
        assert_eq!(c.components[0].instance, 0);
        assert_eq!(c.components[1].component, "Sidebar");
        assert_eq!(c.components[1].instance, 1);
    }

    #[test]
    fn factory_leaf_component() {
        let src =
            "export default function Page({ greeting }) { return <Header user={greeting} />; }";
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.components[0].factory_expr,
            "(ctx) => h(Header, {user: ctx.greeting})"
        );
        assert_eq!(c.components[0].referenced_components, vec!["Header"]);
        assert!(!c.components[0].uses_island);
    }

    #[test]
    fn factory_component_with_static_prop() {
        let src = r#"export default function Page({ data }) { return <Card label="hello" count={data.n} />; }"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.components[0].factory_expr,
            r#"(ctx) => h(Card, {label: "hello", count: ctx.data.n})"#
        );
    }

    #[test]
    fn factory_component_with_children_and_island() {
        let src = r#"export default function Page({ greeting, data }) {
  return <Layout title={greeting}><h1>{greeting}</h1><Island component={Counter} props={data.counter} hydrate="load" /></Layout>;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.components[0].factory_expr,
            r#"(ctx) => h(Layout, {title: ctx.greeting}, h("h1", null, ctx.greeting), h(Island, {component: Counter, props: ctx.data.counter, hydrate: "load"}))"#
        );
        assert!(c.components[0].uses_island);
        assert!(
            c.components[0]
                .referenced_components
                .contains(&"Layout".to_string())
        );
        assert!(
            c.components[0]
                .referenced_components
                .contains(&"Counter".to_string())
        );
    }

    #[test]
    fn factory_component_with_spread_prop() {
        // `<Counter {...clientProps} />` — spread is valid on an SSR component
        // because the factory is plain JS createElement. It lowers to a JS
        // object spread `{...ctx.clientProps}`.
        let src = "export default function Page({ clientProps }) { return <Counter {...clientProps} />; }";
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.components[0].factory_expr,
            "(ctx) => h(Counter, {...ctx.clientProps})"
        );
    }

    #[test]
    fn factory_component_spread_mixed_with_named_preserves_order() {
        // Source order is load-bearing for object spread override semantics:
        // `{...a, extra: x}` lets `extra` win; the reverse lets `a` win.
        let src = "export default function Page({ clientProps, data }) { return <Counter {...clientProps} extra={data.x} />; }";
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.components[0].factory_expr,
            "(ctx) => h(Counter, {...ctx.clientProps, extra: ctx.data.x})"
        );
    }

    #[test]
    fn factory_component_spread_member_access() {
        let src = "export default function Page({ data }) { return <Card {...data.card} />; }";
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.components[0].factory_expr,
            "(ctx) => h(Card, {...ctx.data.card})"
        );
    }

    #[test]
    fn factory_component_named_then_spread_lets_spread_win() {
        // Reverse order of the mixed test: `<Card b={1} {...a} />` must emit
        // `{b: 1, ...ctx.a}` so the spread overrides the named prop — the
        // opposite override outcome from spread-first. Pins source-order fidelity.
        let src = "export default function Page({ data, rest }) { return <Card extra={data.x} {...rest} />; }";
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            c.components[0].factory_expr,
            "(ctx) => h(Card, {extra: ctx.data.x, ...ctx.rest})"
        );
    }

    #[test]
    fn components_to_json_with_isr_fields() {
        let components = vec![ComponentMeta {
            component: "Layout".to_string(),
            instance: 0,
            factory_expr: "(ctx) => h(Layout, {})".to_string(),
            referenced_components: vec!["Layout".to_string()],
            uses_island: false,
            key_path: Some("data.cacheKey".to_string()),
            key_literal: None,
            tags_path: Some("data.cacheTags".to_string()),
            tags_literal: None,
            revalidate: Some(60),
        }];
        let json = components_to_json(&components);
        assert!(json.contains("\"keyPath\":\"data.cacheKey\""), "{json}");
        assert!(json.contains("\"tagsPath\":\"data.cacheTags\""), "{json}");
        assert!(json.contains("\"revalidate\":60"), "{json}");
    }

    #[test]
    fn components_to_json_with_literal_isr() {
        let components = vec![ComponentMeta {
            component: "Layout".to_string(),
            instance: 0,
            factory_expr: "(ctx) => h(Layout, {})".to_string(),
            referenced_components: vec!["Layout".to_string()],
            uses_island: false,
            key_path: None,
            tags_path: None,
            revalidate: Some(30),
            key_literal: Some("navbar".to_string()),
            tags_literal: Some(vec!["nav".to_string(), "global".to_string()]),
        }];
        let json = components_to_json(&components);
        assert!(json.contains("\"keyLiteral\":\"navbar\""), "{json}");
        assert!(
            json.contains("\"tagsLiteral\":[\"nav\",\"global\"]"),
            "{json}"
        );
        assert!(!json.contains("keyPath"), "{json}");
    }

    #[test]
    fn components_to_json_without_isr_omits_fields() {
        let components = vec![ComponentMeta {
            component: "Layout".to_string(),
            instance: 0,
            factory_expr: "(ctx) => h(Layout, {})".to_string(),
            referenced_components: vec!["Layout".to_string()],
            uses_island: false,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        }];
        let json = components_to_json(&components);
        assert!(!json.contains("keyPath"), "{json}");
        assert!(!json.contains("tagsPath"), "{json}");
        assert!(!json.contains("revalidate"), "{json}");
    }

    #[test]
    fn collect_components_copies_isr_from_ir() {
        let src = r#"export default function Page({ data }) {
  return <Layout title={data.title} isr={{ key: data.cacheKey, revalidate: 30 }} />;
}"#;
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(c.components.len(), 1);
        assert_eq!(c.components[0].key_path.as_deref(), Some("data.cacheKey"));
        assert_eq!(c.components[0].tags_path, None);
        assert_eq!(c.components[0].revalidate, Some(30));
    }

    #[test]
    fn islands_in_fragment_numbered() {
        // A root fragment containing two Islands → both numbered in source order
        // and present in collect_islands output.
        let island_a = JsxNode::Island {
            component: "A".to_string(),
            instance: 0,
            props_path: "data.a".to_string(),
            hydrate: "load".to_string(),
            ssr: false,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        };
        let island_b = JsxNode::Island {
            component: "B".to_string(),
            instance: 0,
            props_path: "data.b".to_string(),
            hydrate: "load".to_string(),
            ssr: false,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        };
        let mut root = JsxNode::Fragment {
            children: vec![island_a, island_b],
        };

        let mut counter = 0;
        number_islands(&mut root, &mut counter);
        assert_eq!(counter, 2, "should have numbered 2 islands");

        let mut islands = Vec::new();
        collect_islands(&root, &mut islands);
        assert_eq!(
            islands.len(),
            2,
            "both islands in fragment should be collected"
        );
        assert_eq!(islands[0].component, "A");
        assert_eq!(islands[0].instance, 0);
        assert_eq!(islands[1].component, "B");
        assert_eq!(islands[1].instance, 1);
    }

    #[test]
    fn collect_islands_recurses_cond() {
        use crate::ir::{Expr, JsxNode};
        // Build a Cond whose consequent is an Island; alternate is None.
        let island = JsxNode::Island {
            component: "CondIsland".to_string(),
            instance: 0,
            props_path: "data.x".to_string(),
            hydrate: "load".to_string(),
            ssr: false,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        };
        let mut root = JsxNode::Cond {
            test: Expr::Field("flag".to_string()),
            consequent: Box::new(island),
            alternate: None,
        };

        // Number islands first (as compile_full does).
        let mut counter = 0;
        number_islands(&mut root, &mut counter);
        assert_eq!(counter, 1, "should have numbered 1 island");

        // Now collect islands.
        let mut islands = Vec::new();
        collect_islands(&root, &mut islands);
        assert_eq!(islands.len(), 1, "island inside Cond should be collected");
        assert_eq!(islands[0].component, "CondIsland");
        assert_eq!(islands[0].instance, 0);
    }

    #[test]
    fn collect_components_recurses_cond() {
        use crate::ir::{Expr, JsxNode};
        // Build a Cond whose consequent is an SsrComponent.
        let comp = JsxNode::SsrComponent {
            component: "CondLayout".to_string(),
            instance: 0,
            props: vec![],
            children: vec![],
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        };
        let mut root = JsxNode::Cond {
            test: Expr::Field("show".to_string()),
            consequent: Box::new(comp),
            alternate: None,
        };

        // Number SSR components first (as compile_full does).
        let mut counter = 0;
        number_ssr_components(&mut root, &mut counter);
        assert_eq!(counter, 1, "should have numbered 1 SSR component");

        // Now collect components.
        let mut components = Vec::new();
        collect_components(&root, &mut components);
        assert_eq!(
            components.len(),
            1,
            "SsrComponent inside Cond should be collected"
        );
        assert_eq!(components[0].component, "CondLayout");
        assert_eq!(components[0].instance, 0);
    }

    #[test]
    fn compile_full_collects_warnings() {
        // Route uses <Card native/> but Card source uses useState → falls back
        // to SsrComponent and pushes a warning about the hook.
        let route = r#"export default function Page({ data }) {
  return <div><Card native title={data.x}/></div>;
}"#;
        let card_src = r#"export default function Card({ title }) {
  const [v, setV] = useState(0);
  return <h1>{title}</h1>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Card".to_string(), card_src.to_string());
        let c = compile_full(route, "<test>", sources, HashMap::new(), HashMap::new()).unwrap();
        assert!(
            !c.warnings.is_empty(),
            "expected at least one warning, got none"
        );
    }

    #[test]
    fn compile_full_empty_sources_yields_empty_warnings() {
        // Existing callers pass HashMap::new() — warnings must be empty.
        let src = "export default function Page() { return <p>hi</p>; }";
        let c = compile_full(
            src,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        assert!(
            c.warnings.is_empty(),
            "expected no warnings, got: {:?}",
            c.warnings
        );
    }

    #[test]
    fn outlet_lowers_to_children_slot() {
        let route = r#"export default function Chain() { return <AppLayout native><Leaf native/></AppLayout>; }"#;
        let layout = r#"import { BrustPage } from 'brustjs'
export default function AppLayout() { return <BrustPage title="x"><main class="c"><Outlet/></main></BrustPage>; }"#;
        let leaf = r#"export default function Leaf() { return <section>leaf</section>; }"#;
        let mut s = std::collections::HashMap::new();
        s.insert("AppLayout".to_string(), layout.to_string());
        s.insert("Leaf".to_string(), leaf.to_string());
        let c = compile_full(route, "<t>", s, HashMap::new(), HashMap::new()).unwrap();
        assert!(
            c.template
                .contains(r#"<main class="c"><section>leaf</section></main>"#),
            "got: {}",
            c.template
        );
        assert!(
            !c.template.contains("comp_0_html"),
            "Outlet must NOT become an SSR component; got: {}",
            c.template
        );
    }

    #[test]
    fn outlet_must_be_empty() {
        let layout = r#"export default function L() { return <div><Outlet>x</Outlet></div>; }"#;
        let route = r#"export default function C() { return <L native/>; }"#;
        let mut s = std::collections::HashMap::new();
        s.insert("L".to_string(), layout.to_string());
        let err = compile_full(route, "<t>", s, HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::OutletMustBeEmpty),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn outlet_whitespace_only_child_tolerated() {
        // a formatter may emit `<Outlet>\n</Outlet>` — whitespace-only text is NOT a
        // meaningful child, so it must compile (mirrors <Island>), not error.
        let route =
            r#"export default function Chain() { return <Lay native><Leaf native/></Lay>; }"#;
        let lay = r#"import { BrustPage } from 'brustjs'
export default function Lay() { return <BrustPage title="x"><main>
  <Outlet>
  </Outlet>
</main></BrustPage>; }"#;
        let leaf = r#"export default function Leaf() { return <p>hi</p>; }"#;
        let mut s = std::collections::HashMap::new();
        s.insert("Lay".to_string(), lay.to_string());
        s.insert("Leaf".to_string(), leaf.to_string());
        let c = compile_full(route, "<t>", s, HashMap::new(), HashMap::new()).unwrap();
        assert!(c.template.contains("<p>hi</p>"), "got: {}", c.template);
    }

    #[test]
    fn outlet_outside_layout_errors() {
        // <Outlet/> in a standalone route (never inlined into a parent) would leave a
        // dangling ChildrenSlot that panics at emit — must be a graceful compile error.
        let route = r#"import { BrustPage } from 'brustjs'
export default function Solo() { return <BrustPage title="x"><main><Outlet/></main></BrustPage>; }"#;
        let err = compile_full(
            route,
            "<t>",
            std::collections::HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::OutletOutsideLayout),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn children_composition_still_works() {
        let route =
            r#"export default function Chain() { return <Lay native><Leaf native/></Lay>; }"#;
        let lay = r#"import { BrustPage } from 'brustjs'
export default function Lay({ children }) { return <BrustPage title="x"><main>{children}</main></BrustPage>; }"#;
        let leaf = r#"export default function Leaf() { return <p>hi</p>; }"#;
        let mut s = std::collections::HashMap::new();
        s.insert("Lay".to_string(), lay.to_string());
        s.insert("Leaf".to_string(), leaf.to_string());
        let c = compile_full(route, "<t>", s, HashMap::new(), HashMap::new()).unwrap();
        assert!(
            c.template.contains("<main><p>hi</p></main>"),
            "got: {}",
            c.template
        );
    }

    #[test]
    fn circular_inline_surfaces_as_compile_error() {
        // A native → B native → A native → CircularInline hard error surfaces
        // as CompileError whose kind is ErrorKind::CircularInline.
        let route = r#"export default function Page() {
  return <A native/>;
}"#;
        let a_src = r#"export default function A() {
  return <B native/>;
}"#;
        let b_src = r#"export default function B() {
  return <A native/>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("A".to_string(), a_src.to_string());
        sources.insert("B".to_string(), b_src.to_string());
        let err =
            compile_full(route, "<test>", sources, HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::CircularInline(_)),
            "expected CircularInline, got {:?}",
            err.kind
        );
    }

    #[test]
    fn native_nested_map_member_source() {
        let src = r#"export default function P({ rows }) {
  return <table>{rows.map((r) => (<tr>{r.cells.map((c) => (<td>{c.label}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for r in rows %}<tr>{% for c in r.cells %}<td>{{ (c.label) | e }}</td>{% endfor %}</tr>{% endfor %}</table>"
        );
    }

    #[test]
    fn native_nested_map_inner_refs_outer_binding() {
        let src = r#"export default function P({ rows }) {
  return <table>{rows.map((r) => (<tr>{r.cells.map((c) => (<td>{r.type}:{c.label}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for r in rows %}<tr>{% for c in r.cells %}<td>{{ (r.type) | e }}:{{ (c.label) | e }}</td>{% endfor %}</tr>{% endfor %}</table>"
        );
    }

    #[test]
    fn native_nested_map_three_levels() {
        let src = r#"export default function P({ groups }) {
  return <div>{groups.map((g) => (<section>{g.rows.map((r) => (<ul>{r.items.map((i) => (<li>{i.name}</li>))}</ul>))}</section>))}</div>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<div>{% for g in groups %}<section>{% for r in g.rows %}<ul>{% for i in r.items %}<li>{{ (i.name) | e }}</li>{% endfor %}</ul>{% endfor %}</section>{% endfor %}</div>"
        );
    }

    #[test]
    fn native_nested_map_binding_is_array() {
        let src = r#"export default function P({ matrix }) {
  return <table>{matrix.map((row) => (<tr>{row.map((cell) => (<td>{cell.v}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for row in matrix %}<tr>{% for cell in row %}<td>{{ (cell.v) | e }}</td>{% endfor %}</tr>{% endfor %}</table>"
        );
    }

    #[test]
    fn native_nested_map_with_per_item_conditional() {
        let src = r#"export default function P({ rows }) {
  return <table>{rows.map((r) => (<tr>{r.cells.map((c) => (c.hot ? <td class="hot">{c.v}</td> : <td>{c.v}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for r in rows %}<tr>{% for c in r.cells %}{% if c.hot %}<td class=\"hot\">{{ (c.v) | e }}</td>{% else %}<td>{{ (c.v) | e }}</td>{% endif %}{% endfor %}</tr>{% endfor %}</table>"
        );
    }

    #[test]
    fn brustpage_html_data_attr_literal() {
        let src = r#"export default function P() {
  return <BrustPage data-mode="dark"><div>x</div></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(
            out.starts_with("<html lang=\"en\" data-mode=\"dark\">"),
            "{out}"
        );
        assert!(out.ends_with("<body><div>x</div></body></html>"), "{out}");
    }

    #[test]
    fn brustpage_html_data_attr_dynamic() {
        let src = r#"export default function P({ mode }) {
  return <BrustPage data-theme={mode}><div>x</div></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(
            out.starts_with("<html lang=\"en\" data-theme=\"{{ (mode) | e }}\">"),
            "{out}"
        );
    }

    #[test]
    fn brustpage_html_data_attrs_multiple_order() {
        let src = r#"export default function P() {
  return <BrustPage data-mode="dark" data-density="cozy"><div/></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(
            out.starts_with("<html lang=\"en\" data-mode=\"dark\" data-density=\"cozy\">"),
            "{out}"
        );
    }

    #[test]
    fn brustpage_html_data_attr_after_class() {
        let src = r#"export default function P() {
  return <BrustPage className="dark" data-mode="dark"><div/></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(
            out.starts_with("<html lang=\"en\" class=\"dark\" data-mode=\"dark\">"),
            "{out}"
        );
    }

    #[test]
    fn brustpage_html_data_attr_call_rejected() {
        let src = r#"export default function P() {
  return <BrustPage data-x={fn()}><div/></BrustPage>;
}"#;
        assert!(matches!(
            compile_with_path(src, "<t>").unwrap_err().kind,
            ErrorKind::BrustPageAttrMustBeStringLiteral(_)
        ));
    }

    #[test]
    fn brustpage_invalid_data_attr_name_rejected() {
        let src = r#"export default function P() {
  return <BrustPage data-Mode="x"><div/></BrustPage>;
}"#;
        assert!(matches!(
            compile_with_path(src, "<t>").unwrap_err().kind,
            ErrorKind::InvalidDataAttrName(_)
        ));
    }

    #[test]
    fn brustpage_bare_data_attr_name_rejected() {
        // `data-` with no suffix is not a valid data attribute name.
        let src = r#"export default function P() {
  return <BrustPage data-="x"><div/></BrustPage>;
}"#;
        assert!(matches!(
            compile_with_path(src, "<t>").unwrap_err().kind,
            ErrorKind::InvalidDataAttrName(_)
        ));
    }

    #[test]
    fn brustpage_html_data_attr_after_lang() {
        // Emit order: lang → data-* (lang is not clobbered by a data attr).
        let src = r#"export default function P() {
  return <BrustPage lang="fr" data-mode="dark"><div/></BrustPage>;
}"#;
        let out = compile(src).unwrap();
        assert!(
            out.starts_with("<html lang=\"fr\" data-mode=\"dark\">"),
            "{out}"
        );
    }

    // ── Lucide native static-SVG (T2) ────────────────────────────────────────

    /// Build a lucide map with one `Search` icon (path + circle children).
    fn lucide_search_map() -> HashMap<String, String> {
        let mut lucide = HashMap::new();
        lucide.insert(
            "Search".to_string(),
            r#"{"cls":"lucide lucide-search","node":[["path",[["d","m21 21-4.34-4.34"]]],["circle",[["cx","11"],["cy","11"],["r","8"]]]]}"#
                .to_string(),
        );
        lucide
    }

    #[test]
    fn lucide_static_svg_default_props() {
        // AC1: <Search/> nested under a host element emits a static <svg>.
        let route = r#"export default function P(){ return <div><Search/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("<svg"), "{t}");
        assert!(t.contains("class=\"lucide lucide-search\""), "{t}");
        assert!(t.contains("width=\"24\""), "{t}");
        assert!(t.contains("height=\"24\""), "{t}");
        assert!(t.contains("stroke=\"currentColor\""), "{t}");
        assert!(t.contains("stroke-width=\"2\""), "{t}");
        assert!(t.contains("aria-hidden=\"true\""), "{t}");
        assert!(t.contains("<path d=\"m21 21-4.34-4.34\">"), "{t}");
        assert!(t.contains("<circle cx=\"11\" cy=\"11\" r=\"8\">"), "{t}");
        // No comp_ SSR slot for Search.
        assert!(!t.contains("comp_"), "{t}");
        let json = components_to_json(&c.components);
        assert!(!json.contains("\"Search\""), "{json}");
    }

    #[test]
    fn lucide_static_svg_size_prop() {
        // AC2: size={16} drives width/height.
        let route = r#"export default function P(){ return <div><Search size={16}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("width=\"16\""), "{t}");
        assert!(t.contains("height=\"16\""), "{t}");
    }

    #[test]
    fn lucide_static_svg_keyed_icon() {
        // AC5: a differently-keyed icon emits its own class.
        let mut lucide = HashMap::new();
        lucide.insert(
            "Icon".to_string(),
            r#"{"cls":"lucide lucide-circle","node":[["circle",[["cx","12"],["cy","12"],["r","10"]]]]}"#
                .to_string(),
        );
        let route = r#"export default function P(){ return <div><Icon/></div>; }"#;
        let c = compile_full(route, "<test>", HashMap::new(), lucide, HashMap::new()).unwrap();
        let t = &c.template;
        assert!(t.contains("class=\"lucide lucide-circle\""), "{t}");
        assert!(t.contains("<circle cx=\"12\" cy=\"12\" r=\"10\">"), "{t}");
    }

    #[test]
    fn lucide_no_map_entry_stays_ssr_component() {
        // AC7: <Layout/> with no map entry → still an SSR component, no panic.
        let route = r#"export default function P(){ return <div><Layout/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("comp_"), "{t}");
        let json = components_to_json(&c.components);
        assert!(json.contains("\"Layout\""), "{json}");
    }

    #[test]
    fn lucide_dynamic_color_and_stroke_width() {
        // AC3: color={data.c} strokeWidth={data.w} → dynamic stroke / stroke-width.
        let route = r#"export default function P({ data }){ return <div><Search color={data.c} strokeWidth={data.w}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("stroke=\"{{ (data.c) | e }}\""), "{t}");
        assert!(t.contains("stroke-width=\"{{ (data.w) | e }}\""), "{t}");
        // Still a static <svg>, not an SSR fallback.
        assert!(t.contains("<svg"), "{t}");
        assert!(!t.contains("comp_"), "{t}");
    }

    #[test]
    fn lucide_static_class_name() {
        // AC4a: className="w-4 h-4" merges into the class literal (T2 behavior).
        let route =
            r#"export default function P(){ return <div><Search className="w-4 h-4"/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("class=\"lucide lucide-search w-4 h-4\""), "{t}");
    }

    #[test]
    fn lucide_dynamic_class_name() {
        // AC4b: className={data.cls} → dynamic class with icon-class prefix.
        let route = r#"export default function P({ data }){ return <div><Search className={data.cls}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("lucide lucide-search"), "{t}");
        assert!(
            t.contains("class=\"{{ (\"lucide lucide-search \" ~ data.cls) | e }}\""),
            "{t}"
        );
        assert!(t.contains("<svg"), "{t}");
        assert!(!t.contains("comp_"), "{t}");
    }

    #[test]
    fn lucide_spread_falls_back_with_warning() {
        // AC6: {...props} → SSR fallback + a warning.
        let route =
            r#"export default function P({ props }){ return <div><Search {...props}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("comp_"), "{t}");
        let json = components_to_json(&c.components);
        assert!(json.contains("\"Search\""), "{json}");
        assert!(!c.warnings.is_empty(), "warnings: {:?}", c.warnings);
    }

    #[test]
    fn lucide_dynamic_size() {
        // AC-dynsize: size={data.s} → dynamic width AND height.
        let route =
            r#"export default function P({ data }){ return <div><Search size={data.s}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("width=\"{{ (data.s) | e }}\""), "{t}");
        assert!(t.contains("height=\"{{ (data.s) | e }}\""), "{t}");
        assert!(t.contains("<svg"), "{t}");
        assert!(!t.contains("comp_"), "{t}");
    }

    #[test]
    fn lucide_empty_map_regression() {
        // AC8: AC1 route with an EMPTY lucide map == compiling pre-feature.
        let route = r#"export default function P(){ return <div><Search/></div>; }"#;
        let with_empty = compile_full(
            route,
            "<test>",
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        let baseline = compile(route).unwrap();
        assert_eq!(with_empty.template, baseline, "{}", with_empty.template);
        // Search stays an SSR component with no map.
        assert!(
            with_empty.template.contains("comp_"),
            "{}",
            with_empty.template
        );
        let json = components_to_json(&with_empty.components);
        assert!(json.contains("\"Search\""), "{json}");
    }

    #[test]
    fn lucide_absolute_stroke_width_integer() {
        // absoluteStrokeWidth + static strokeWidth/size → stroke-width = sw*24/size.
        // 2*24/16 = 3 (integer; rendered without a decimal point).
        let route = r#"export default function P(){ return <div><Search absoluteStrokeWidth strokeWidth={2} size={16}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("stroke-width=\"3\""), "{t}");
        assert!(t.contains("<svg"), "{t}");
        assert!(!t.contains("comp_"), "{t}");
    }

    #[test]
    fn lucide_absolute_stroke_width_non_integer() {
        // 2*24/5 = 9.6 (non-integer; shortest-decimal Display → "9.6").
        let route = r#"export default function P(){ return <div><Search absoluteStrokeWidth strokeWidth={2} size={5}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        let t = &c.template;
        assert!(t.contains("stroke-width=\"9.6\""), "{t}");
        assert!(t.contains("<svg"), "{t}");
        assert!(!t.contains("comp_"), "{t}");
    }

    #[test]
    fn lucide_absolute_stroke_width_dynamic_size_falls_back() {
        // absoluteStrokeWidth with a dynamic size can't be computed statically →
        // soft-fallback to SSR with a warning; Search becomes an SSR component.
        let route = r#"export default function P({ data }){ return <div><Search absoluteStrokeWidth strokeWidth={2} size={data.s}/></div>; }"#;
        let c = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        )
        .unwrap();
        assert!(!c.warnings.is_empty(), "warnings: {:?}", c.warnings);
        let json = components_to_json(&c.components);
        assert!(json.contains("\"Search\""), "{json}");
    }

    #[test]
    fn lucide_in_map_is_intentional_hard_error() {
        // lucide in `.map()` is intentionally unsupported (spec Non-goal): the lucide
        // static-SVG check sits AFTER the `in_map` guard, so it preserves the
        // pre-existing SsrComponentInMapNotSupported hard error rather than inlining.
        let route = r#"export default function P({ items }){ return <ul>{items.map((it) => (<li><Search/></li>))}</ul>; }"#;
        let result = compile_full(
            route,
            "<test>",
            HashMap::new(),
            lucide_search_map(),
            HashMap::new(),
        );
        let err = result.unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::SsrComponentInMapNotSupported(_)),
            "{err:?}"
        );
    }
}
