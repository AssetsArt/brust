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
}

/// Parse → lower → { emit template, collect islands }. The single source of
/// truth for compilation; `compile`/`compile_with_path` are thin wrappers.
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
    let template = emit_jinja::emit(&ir);
    let mut islands = Vec::new();
    collect_islands(&ir.root, &mut islands);
    Ok(Compiled { template, islands })
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
        JsxNode::Map { body, .. } => number_islands(body, counter),
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
        } => {
            out.push(IslandMeta {
                component: component.clone(),
                instance: *instance,
                props_path: props_path.clone(),
                ssr: *ssr,
                hydrate: hydrate.clone(),
            });
        }
        JsxNode::Element { children, .. } => {
            for child in children {
                collect_islands(child, out);
            }
        }
        JsxNode::Map { body, .. } => collect_islands(body, out),
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) => {}
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
        out.push_str("\"}");
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
    #[error("`<Island id=…>` is no longer supported — islands are addressed by `component={{…}}`; remove the `id` attribute")]
    IslandIdAttrRemoved,
    #[error("`<Island component={{{0}}}>` — component name must match [A-Za-z0-9_]+ (it becomes the chunk filename and DOM marker)")]
    IslandBadComponentName(String),
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
                },
                IslandMeta {
                    component: "B".to_string(),
                    instance: 1,
                    props_path: "data.b".to_string(),
                    ssr: false,
                    hydrate: "visible".to_string(),
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
                },
                IslandMeta {
                    component: "C".to_string(),
                    instance: 1,
                    props_path: "data.b".to_string(),
                    ssr: false,
                    hydrate: "load".to_string(),
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
            },
            // Exercise escaping: a backslash and a quote in props_path.
            IslandMeta {
                component: "Weird".to_string(),
                instance: 1,
                props_path: r#"a\b"c"#.to_string(),
                ssr: false,
                hydrate: "idle".to_string(),
            },
        ];
        let json = islands_to_json(&islands);
        assert_eq!(
            json,
            r#"[{"component":"Counter","instance":0,"propsPath":"data.counter","ssr":true,"hydrate":"load"},{"component":"Weird","instance":1,"propsPath":"a\\b\"c","ssr":false,"hydrate":"idle"}]"#
        );
    }

    #[test]
    fn islands_to_json_empty_is_bracket_pair() {
        assert_eq!(islands_to_json(&[]), "[]");
    }
}
