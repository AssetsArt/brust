//! napi binding for the JSX→jinja compiler (the `jsx-rust-compiler` crate).
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

#[allow(dead_code)]
#[napi(object)]
pub struct NapiCompiledJsx {
    pub template: String,
    /// Island manifest as JSON (`"[]"` when no `<Island>`). camelCase keys match
    /// `RawIslandEntry` in native-routes-emit.ts.
    pub islands_json: String,
    /// SSR component manifest as JSON (`"[]"` when no SSR components). camelCase
    /// keys: `component`, `instance`, `factoryExpr`, `referencedComponents`,
    /// `usesIsland`.
    pub components_json: String,
    /// Non-fatal diagnostic messages from native-inline lowering. Empty when no
    /// `component_sources` are provided (i.e. the default `None` path).
    pub warnings: Vec<String>,
}

#[allow(dead_code)]
#[napi]
pub fn compile_jsx(
    source: String,
    path: String,
    component_sources: Option<HashMap<String, String>>,
    lucide_icons: Option<HashMap<String, String>>,
) -> Result<NapiCompiledJsx> {
    match jsx_rust_compiler::compile_full(
        &source,
        &path,
        component_sources.unwrap_or_default(),
        lucide_icons.unwrap_or_default(),
    ) {
        Ok(compiled) => Ok(NapiCompiledJsx {
            template: compiled.template,
            islands_json: jsx_rust_compiler::islands_to_json(&compiled.islands),
            components_json: jsx_rust_compiler::components_to_json(&compiled.components),
            warnings: compiled.warnings,
        }),
        Err(e) => Err(Error::from_reason(format!("{e}"))),
    }
}

#[cfg(test)]
mod tests {
    use jsx_rust_compiler::{ComponentMeta, compile_full, components_to_json};
    use std::collections::HashMap;

    #[test]
    fn components_to_json_empty() {
        assert_eq!(components_to_json(&[]), "[]");
    }

    #[test]
    fn components_to_json_golden() {
        let components = vec![ComponentMeta {
            component: "Layout".to_string(),
            instance: 0,
            factory_expr: "(ctx) => h(Layout, {title: ctx.greeting})".to_string(),
            referenced_components: vec!["Layout".to_string()],
            uses_island: false,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        }];
        let json = components_to_json(&components);
        assert_eq!(
            json,
            r#"[{"component":"Layout","instance":0,"factoryExpr":"(ctx) => h(Layout, {title: ctx.greeting})","referencedComponents":["Layout"],"usesIsland":false}]"#
        );
    }

    #[test]
    fn compile_jsx_exposes_components_json_field() {
        let src = r#"export default function Page({ greeting }) {
  return <Layout title={greeting} />;
}"#;
        let compiled = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap();
        let json = components_to_json(&compiled.components);
        assert!(json.contains("\"component\":\"Layout\""));
        assert!(json.contains("\"instance\":0"));
        assert!(json.contains("\"factoryExpr\":"));
        assert!(json.contains("\"referencedComponents\":[\"Layout\"]"));
        assert!(json.contains("\"usesIsland\":false"));
    }

    #[test]
    fn compile_jsx_none_sources_behaves_as_before() {
        // None component_sources → same output as the old 2-arg compile_full,
        // warnings field is empty.
        let src = r#"export default function Page({ greeting }) {
  return <p>{greeting}</p>;
}"#;
        let compiled = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap();
        assert!(compiled.template.contains("<p>"));
        assert!(
            compiled.warnings.is_empty(),
            "expected no warnings for plain route"
        );
    }

    #[test]
    fn compile_jsx_none_lucide_behaves_as_before() {
        let src = r#"export default function Page({ g }) { return <p>{g}</p>; }"#;
        let compiled = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap();
        assert!(compiled.template.contains("<p>"));
        assert!(compiled.warnings.is_empty());
    }

    #[test]
    fn compile_jsx_returns_warnings_field() {
        // A route with a native component whose source uses useState falls back
        // and produces a non-empty warnings vec. This asserts the warnings field
        // is present on Compiled and threaded through compile_full.
        let route = r#"export default function Page({ data }) {
  return <div><Card native title={data.x}/></div>;
}"#;
        let card_src = r#"export default function Card({ title }) {
  const [v, setV] = useState(0);
  return <h1>{title}</h1>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Card".to_string(), card_src.to_string());
        let compiled = compile_full(route, "<test>", sources, HashMap::new()).unwrap();
        assert!(
            !compiled.warnings.is_empty(),
            "expected warnings from hook fallback, got none"
        );
    }
}
