//! Sub-project J — minijinja Environment loader + render entry point.
//!
//! Spec §6 (jinja.rs) + §13.7 (OnceLock) + §13.6 (Chainable undefined behavior).
//!
//! Boot path (Task 4 wires it):
//! 1. `load_from(.brust/jinja/)` reads every `<Name>.jinja` file and registers
//!    it under its file stem.
//! 2. `render(name, &data_json)` looks up the template, deserializes the JSON,
//!    and renders.
//!
//! `OnceLock` is intentional per §13.7 — hot reload via `RwLock` is deferred
//! to v2.x. `Box::leak` is the price of `OnceLock<Environment<'static>>`.

use std::path::Path;
use std::sync::OnceLock;

use minijinja::{Environment, UndefinedBehavior};

static ENV: OnceLock<Environment<'static>> = OnceLock::new();

/// Read every `<Name>.jinja` file in `dir` and register it under its file
/// stem. Returns the registered template names.
///
/// Lenient on missing/non-directory `dir` — sets an empty Environment and
/// returns `vec![]`. Parse errors on individual `.jinja` files panic — that's
/// real build-pipeline drift (spec §6).
pub fn load_from(dir: &Path) -> Vec<String> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    let mut names = Vec::new();

    if dir.exists() && dir.is_dir() {
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
        for entry in entries {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jinja") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .expect("UTF-8 file stem")
                .to_string();
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            // SAFETY: OnceLock<Environment<'static>> requires 'static template
            // sources + names. Hot reload deferred per spec §13.7.
            let source_static: &'static str = Box::leak(source.into_boxed_str());
            let name_static: &'static str = Box::leak(name.clone().into_boxed_str());
            env.add_template(name_static, source_static)
                .unwrap_or_else(|e| panic!("add_template {}: {e}", path.display()));
            names.push(name);
        }
    }

    ENV.set(env).expect("jinja env initialized once");
    names
}

/// Render the named template against the supplied JSON bytes.
pub fn render(name: &str, data_json: &[u8]) -> Result<String, RenderError> {
    let env = ENV.get().ok_or(RenderError::NotLoaded)?;
    let tmpl = env
        .get_template(name)
        .map_err(|_| RenderError::UnknownTemplate(name.to_string()))?;
    let value: serde_json::Value =
        serde_json::from_slice(data_json).map_err(|e| RenderError::BadJson(e.to_string()))?;
    tmpl.render(value)
        .map_err(|e| RenderError::Render(e.to_string()))
}

/// Names of every template currently registered. Empty when `load_from`
/// hasn't been called.
pub fn registered_templates() -> Vec<String> {
    ENV.get()
        .map(|env| env.templates().map(|(name, _)| name.to_string()).collect())
        .unwrap_or_default()
}

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("jinja Environment not loaded (call load_from first)")]
    NotLoaded,
    #[error("unknown template: {0:?}")]
    UnknownTemplate(String),
    #[error("bad JSON: {0}")]
    BadJson(String),
    #[error("render: {0}")]
    Render(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("HelloPage.jinja"),
            "<div><h1>Hello, {{ name }}</h1></div>",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("ListNav.jinja"),
            "<ul>{% for item in items %}<li>{{ item.label }}</li>{% endfor %}</ul>",
        )
        .unwrap();
        dir
    }

    #[test]
    fn jinja_round_trip() {
        // Single test serializing all sub-checks: OnceLock means ENV is
        // process-global, so a second `load_from` would panic. The
        // lenient-missing-dir branch is covered structurally + by Task 6 E2E.
        let dir = write_fixture_dir();
        let names = load_from(dir.path());
        assert!(names.contains(&"HelloPage".to_string()));
        assert!(names.contains(&"ListNav".to_string()));

        let out = render("HelloPage", br#"{"name":"World"}"#).expect("render");
        assert_eq!(out, "<div><h1>Hello, World</h1></div>");

        let out = render("ListNav", br#"{"items":[{"label":"A"},{"label":"B"}]}"#).expect("render");
        assert_eq!(out, "<ul><li>A</li><li>B</li></ul>");

        match render("NotThere", b"{}") {
            Err(RenderError::UnknownTemplate(name)) => assert_eq!(name, "NotThere"),
            other => panic!("expected UnknownTemplate, got {other:?}"),
        }

        match render("HelloPage", b"not json") {
            Err(RenderError::BadJson(_)) => (),
            other => panic!("expected BadJson, got {other:?}"),
        }

        let templates = registered_templates();
        assert!(templates.contains(&"HelloPage".to_string()));
        assert!(templates.contains(&"ListNav".to_string()));
    }
}
