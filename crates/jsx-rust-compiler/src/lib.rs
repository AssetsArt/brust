mod emit_factory;
mod emit_jinja;
mod ir;
mod lower;
pub mod parser;

use ir::JsxNode;

pub fn compile(source: &str) -> Result<String, CompileError> {
    compile_with_path(source, "<stdin>")
}

/// Back-compat wrapper: returns only the emitted jinja template. The golden
/// harness depends on this signature, so it stays a thin delegate to
/// `compile_full` (which also collects the island manifest).
pub fn compile_with_path(source: &str, path: &str) -> Result<String, CompileError> {
    compile_full(source, path).map(|c| c.template)
}

/// Result of a full compile: the jinja template plus the island manifest
/// collected from the lowered IR. The bin (`jsx-rustc`) writes the template to
/// `-o` and, when islands are present, a sibling `.islands.json` manifest.
#[derive(Debug)]
pub struct Compiled {
    pub template: String,
    pub islands: Vec<IslandMeta>,
    pub components: Vec<ComponentMeta>,
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
    pub tags_path: Option<String>,
    pub revalidate: Option<u32>,
}

/// Parse → lower → { emit template, collect islands, collect components }. The
/// single source of truth for compilation; `compile`/`compile_with_path` are
/// thin wrappers.
pub fn compile_full(source: &str, path: &str) -> Result<Compiled, CompileError> {
    let parsed = parser::parse(source, path).map_err(|e| CompileError {
        path: path.to_string(),
        line: 0,
        col: 0,
        kind: ErrorKind::Parse(e.to_string()),
    })?;

    let mut ir = lower::lower(&parsed).map_err(|e| CompileError::from_lower(e, path, &parsed))?;
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
    for (comp, fo) in components.iter_mut().zip(factory_outputs) {
        comp.factory_expr = fo.expr;
        comp.referenced_components = fo.referenced;
        comp.uses_island = fo.uses_island;
    }

    Ok(Compiled {
        template,
        islands,
        components,
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
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) => {}
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
            tags_path,
            revalidate,
        } => {
            out.push(IslandMeta {
                component: component.clone(),
                instance: *instance,
                props_path: props_path.clone(),
                ssr: *ssr,
                hydrate: hydrate.clone(),
                key_path: key_path.clone(),
                tags_path: tags_path.clone(),
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
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) => {}
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
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) | JsxNode::Island { .. } => {}
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
            ..
        } => {
            // Don't recurse — nested SSR components render inside parent factory.
            out.push(ComponentMeta {
                component: component.clone(),
                instance: *instance,
                factory_expr: String::new(),
                referenced_components: Vec::new(),
                uses_island: false,
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
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) | JsxNode::Island { .. } => {}
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
/// `usesIsland`. Empty slice → `"[]"`.
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
    #[error("`.map((item, idx) => …)` two-arg form not supported in Phase A1")]
    MapIndexParamNotSupported,
    #[error("`.map(...)` shape not supported — expect `(ident) => <JSXElement>`")]
    MapShapeNotSupported,
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
        "`<BrustPage {0}=…>` must be a string literal (e.g. `{0}=\"…\"`) — the document shell is rendered in Rust, so its attributes can't be dynamic expressions"
    )]
    BrustPageAttrMustBeStringLiteral(String),
    #[error(
        "`<BrustPage>` owns `<head>` — a literal `<head>` child is not supported; set head tags via props instead (e.g. `title=\"…\"`, `description=\"…\"`)"
    )]
    BrustPageLiteralHeadNotSupported,
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
        let c = compile_full(src, "<test>").unwrap();
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
                    tags_path: None,
                    revalidate: None,
                },
                IslandMeta {
                    component: "B".to_string(),
                    instance: 1,
                    props_path: "data.b".to_string(),
                    ssr: false,
                    hydrate: "visible".to_string(),
                    key_path: None,
                    tags_path: None,
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
        let c = compile_full(src, "<test>").unwrap();
        assert_eq!(c.islands, vec![]);
    }

    #[test]
    fn compile_full_allows_duplicate_components_distinct_instances() {
        // Two `<Island component={C}/>` siblings now share the chunk key `C` but
        // get distinct source-order `instance` indices — NO error.
        let src = r#"export default function Page({ data }) {
  return <div><Island component={C} props={data.a} /><Island component={C} props={data.b} /></div>;
}"#;
        let c = compile_full(src, "<test>").unwrap();
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
                    tags_path: None,
                    revalidate: None,
                },
                IslandMeta {
                    component: "C".to_string(),
                    instance: 1,
                    props_path: "data.b".to_string(),
                    ssr: false,
                    hydrate: "load".to_string(),
                    key_path: None,
                    tags_path: None,
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
        let err = compile_full(src, "<test>").unwrap_err();
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
        let err = compile_full(src, "<test>").unwrap_err();
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
        let c = compile_full(src, "<test>").unwrap();
        assert_eq!(
            c.islands,
            vec![IslandMeta {
                component: "Deep".to_string(),
                instance: 0,
                props_path: "data.x".to_string(),
                ssr: false,
                hydrate: "load".to_string(),
                key_path: None,
                tags_path: None,
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
                tags_path: None,
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
                tags_path: None,
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
            tags_path: Some("data.cacheTags".to_string()),
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
        let c = compile_full(src, "<test>").unwrap();
        let expected = concat!(
            "<html lang=\"en\" class=\"dark\">",
            "<head>",
            "<meta charset=\"utf-8\"/>",
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>",
            "<title>Built to Brust</title>",
            "<meta name=\"description\" content=\"Bun + Rust SSR\"/>",
            "<link rel=\"stylesheet\" href=\"/_brust/css/app.css\"/>",
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
        let c = compile_full(src, "<test>").unwrap();
        assert_eq!(
            c.template,
            concat!(
                "<html lang=\"en\">",
                "<head>",
                "<meta charset=\"utf-8\"/>",
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>",
                "<link rel=\"stylesheet\" href=\"/_brust/css/app.css\"/>",
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
        let err = compile_full(src, "<test>").unwrap_err();
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
        let err = compile_full(src, "<test>").unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageMustBeRoot),
            "expected BrustPageMustBeRoot, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_dynamic_attr_is_rejected() {
        let src = r#"export default function Home({ lang }) {
  return <BrustPage lang={lang}><main>hi</main></BrustPage>;
}"#;
        let err = compile_full(src, "<test>").unwrap_err();
        match err.kind {
            ErrorKind::BrustPageAttrMustBeStringLiteral(name) => assert_eq!(name, "lang"),
            other => panic!("expected BrustPageAttrMustBeStringLiteral, got {other:?}"),
        }
    }
}
