//! napi binding for the JSX→jinja compiler (the `jsx-rust-compiler` crate).
use napi::bindgen_prelude::*;
use napi_derive::napi;

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
}

#[allow(dead_code)]
#[napi]
pub fn compile_jsx(source: String, path: String) -> Result<NapiCompiledJsx> {
    match jsx_rust_compiler::compile_full(&source, &path) {
        Ok(compiled) => Ok(NapiCompiledJsx {
            template: compiled.template,
            islands_json: jsx_rust_compiler::islands_to_json(&compiled.islands),
            components_json: jsx_rust_compiler::components_to_json(&compiled.components),
        }),
        Err(e) => Err(Error::from_reason(format!("{e}"))),
    }
}

#[cfg(test)]
mod tests {
    use jsx_rust_compiler::{ComponentMeta, compile_full, components_to_json};

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
            tags_path: None,
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
        let compiled = compile_full(src, "<test>").unwrap();
        let json = components_to_json(&compiled.components);
        assert!(json.contains("\"component\":\"Layout\""));
        assert!(json.contains("\"instance\":0"));
        assert!(json.contains("\"factoryExpr\":"));
        assert!(json.contains("\"referencedComponents\":[\"Layout\"]"));
        assert!(json.contains("\"usesIsland\":false"));
    }
}
