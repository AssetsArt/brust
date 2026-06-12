//! Sub-project J — minijinja Environment loader + render entry point.
//!
//! Spec S6 (jinja.rs) + S13.7 (OnceLock) + S13.6 (Chainable undefined behavior).
//!
//! Boot path (Task 4 wires it):
//! 1. `load_from(.brust/jinja/)` reads every `<Name>.jinja` file and registers
//!    it under its file stem.
//! 2. `render(name, &data_json)` looks up the template, deserializes the JSON,
//!    and renders.
//!
//! `OnceLock` is intentional per S13.7 — hot reload via `RwLock` is deferred
//! to v2.x. `Box::leak` is the price of `OnceLock<Environment<'static>>`.

use std::path::Path;

use minijinja::{Environment, UndefinedBehavior};
use parking_lot::RwLock;

// RwLock (not OnceLock) so `load_from` can REPLACE the environment on a dev hot
// reload: native-route `.jinja` templates are recompiled from source on every
// `.tsx` edit and reloaded here. Renders take a shared read lock (cheap, and in
// production always uncontended — loaded once, never rewritten); a reload takes
// the brief write lock. Templates are added owned, so replacing the env drops
// the previous generation instead of leaking it.
static ENV: RwLock<Option<Environment<'static>>> = RwLock::new(None);

// Dynamic tier — templates registered at runtime (per-tenant sections etc.).
// Source of truth is DYN_SOURCES; DYN_ENV mirrors it. Lazily initialized with
// base_env() — deliberately NOT copied from ENV (register may legally run
// before load_from; no boot-ordering dependency). Dev hot reload replaces ENV
// only; dynamic registrations survive.
static DYN_ENV: RwLock<Option<Environment<'static>>> = RwLock::new(None);
static DYN_SOURCES: RwLock<Option<std::collections::HashMap<String, String>>> = RwLock::new(None);

/// Shared construction for both the boot env (`load_from`) and the dynamic
/// tier — single source of truth for filters + undefined behavior.
fn base_env() -> Environment<'static> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    env.add_filter("json_attr", json_attr);
    env
}

/// Read every `<Name>.jinja` file in `dir` and register it under its file
/// stem. Returns the registered template names.
///
/// Lenient on missing/non-directory `dir` — sets an empty Environment and
/// returns `vec![]`. Parse errors on individual `.jinja` files panic — that's
/// real build-pipeline drift (spec S6).
pub fn load_from(dir: &Path) -> Vec<String> {
    let mut env = base_env();
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
            // Owned templates: the Environment owns its name + source (Cow::Owned
            // -> 'static), so a dev hot reload can drop and replace the whole env
            // without leaking. (The old OnceLock path Box::leak'd every source.)
            env.add_template_owned(name.clone(), source)
                .unwrap_or_else(|e| panic!("add_template {}: {e}", path.display()));
            names.push(name);
        }
    }

    // Replace, don't init-once: a dev hot reload calls this again with the
    // freshly recompiled templates.
    *ENV.write() = Some(env);
    names
}

/// Serialize a value to JSON, then HTML-entity-encode it for safe placement in a
/// double-quoted attribute (e.g. `x-props`). Mirrors the islands
/// `entityEncode(JSON.stringify(...))` path. minijinja's built-in `tojson` is
/// `<script>`-oriented (safe-marked, does NOT escape `"`) so it is WRONG for an
/// HTML attribute — hence this filter.
fn json_attr(value: minijinja::Value) -> Result<String, minijinja::Error> {
    let json = serde_json::to_string(&value).map_err(|e| {
        minijinja::Error::new(
            minijinja::ErrorKind::InvalidOperation,
            "x-props JSON serialization failed",
        )
        .with_source(e)
    })?;
    Ok(json
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;"))
}

#[derive(Debug, thiserror::Error)]
pub enum RegisterError {
    #[error("template name must be non-empty")]
    EmptyName,
    #[error("template name too long (max 512 bytes)")]
    NameTooLong,
    #[error("template name contains control characters")]
    NameControlChar,
    #[error("template syntax: {0}")]
    Syntax(String),
}

// Lock order is GLOBAL: DYN_ENV before DYN_SOURCES, always; render takes DYN
// locks and drops them before touching ENV.

/// Register (or replace) a runtime template. minijinja parses eagerly inside
/// add_template_owned for owned inputs — on a syntax error nothing is mutated
/// and any prior registration under `name` survives.
pub fn register_template(name: &str, source: &str) -> Result<(), RegisterError> {
    if name.is_empty() {
        return Err(RegisterError::EmptyName);
    }
    if name.len() > 512 {
        return Err(RegisterError::NameTooLong);
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(RegisterError::NameControlChar);
    }

    let mut env_guard = DYN_ENV.write();
    let env = env_guard.get_or_insert_with(base_env);
    env.add_template_owned(name.to_string(), source.to_string())
        .map_err(|e| RegisterError::Syntax(e.to_string()))?;
    DYN_SOURCES
        .write()
        .get_or_insert_with(Default::default)
        .insert(name.to_string(), source.to_string());
    Ok(())
}

/// Remove a runtime-registered template. Returns whether it existed.
/// minijinja's remove_template returns (), so existence comes from DYN_SOURCES.
pub fn remove_dynamic_template(name: &str) -> bool {
    let mut env_guard = DYN_ENV.write();
    // Hold the sources guard across the env mutation so the two tiers never
    // disagree mid-removal (a concurrent has_template between the map remove
    // and the env remove would otherwise see a split-brain).
    let mut src_guard = DYN_SOURCES.write();
    let existed = src_guard.as_mut().is_some_and(|m| m.remove(name).is_some());
    if existed && let Some(env) = env_guard.as_mut() {
        env.remove_template(name);
    }
    existed
}

/// Names of runtime-registered templates (dynamic tier only).
pub fn dynamic_template_names() -> Vec<String> {
    DYN_SOURCES
        .read()
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// True when `name` resolves in either tier (dynamic first, then boot).
pub fn has_template(name: &str) -> bool {
    if DYN_SOURCES
        .read()
        .as_ref()
        .is_some_and(|m| m.contains_key(name))
    {
        return true;
    }
    ENV.read()
        .as_ref()
        .is_some_and(|env| env.get_template(name).is_ok())
}

/// Render the named template against the supplied JSON bytes. Lookup order:
/// dynamic tier first (runtime registrations win on collision — documented
/// override semantics), then the boot env.
pub fn render(name: &str, data_json: &[u8]) -> Result<String, RenderError> {
    let value: serde_json::Value =
        serde_json::from_slice(data_json).map_err(|e| RenderError::BadJson(e.to_string()))?;

    {
        let dyn_guard = DYN_ENV.read();
        if let Some(env) = dyn_guard.as_ref()
            && let Ok(tmpl) = env.get_template(name)
        {
            return tmpl
                .render(&value)
                .map_err(|e| RenderError::Render(e.to_string()));
        }
    } // dyn lock dropped before boot lookup

    let guard = ENV.read();
    let env = guard.as_ref().ok_or(RenderError::NotLoaded)?;
    let tmpl = env
        .get_template(name)
        .map_err(|_| RenderError::UnknownTemplate(name.to_string()))?;
    tmpl.render(&value)
        .map_err(|e| RenderError::Render(e.to_string()))
}

/// Names of every template currently registered. Empty when `load_from`
/// hasn't been called.
pub fn registered_templates() -> Vec<String> {
    ENV.read()
        .as_ref()
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

    // ENV/DYN_* are process-global and cargo runs tests concurrently in one
    // process; every test that touches the globals serializes on this lock.
    static TEST_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

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
        // Single test serializing all sub-checks: ENV is process-global, so the
        // sub-checks (including the reload at the end) must run in sequence. The
        // lenient-missing-dir branch is covered structurally + by Task 6 E2E.
        let _guard = TEST_LOCK.lock();
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

        // Hot reload: a second load_from REPLACES the env (the whole point of
        // moving OnceLock -> RwLock — native-route templates recompile and
        // reload on a .tsx edit instead of serving stale content until restart).
        let dir2 = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir2.path().join("HelloPage.jinja"),
            "<div><h1>RELOADED, {{ name }}</h1></div>",
        )
        .unwrap();
        let names2 = load_from(dir2.path());
        assert_eq!(names2, vec!["HelloPage".to_string()]);
        let out = render("HelloPage", br#"{"name":"World"}"#).expect("render after reload");
        assert_eq!(out, "<div><h1>RELOADED, World</h1></div>");
        // The previous generation's templates are gone after the replace.
        assert!(matches!(
            render("ListNav", b"{}"),
            Err(RenderError::UnknownTemplate(_)),
        ));
    }

    #[test]
    fn dynamic_registry_round_trip() {
        let _guard = TEST_LOCK.lock();

        let name = "dynreg/shop/1/section/2@v1";

        // Register + render.
        register_template(name, r#"<div class="s">{{ title }}</div>"#).expect("register");
        let out = render(name, br#"{"title":"X"}"#).expect("render dynamic");
        assert_eq!(out, r#"<div class="s">X</div>"#);

        // Re-register same name replaces.
        register_template(name, "<p>{{ title }}</p>").expect("re-register");
        let out = render(name, br#"{"title":"X"}"#).expect("render after replace");
        assert_eq!(out, "<p>X</p>");

        // Syntax error: nothing mutated, prior registration survives.
        let err = register_template(name, "{% for x in %}");
        assert!(matches!(err, Err(RegisterError::Syntax(_))));
        let out = render(name, br#"{"title":"X"}"#).expect("render after bad re-register");
        assert_eq!(out, "<p>X</p>");

        // Names + has_template.
        assert!(dynamic_template_names().contains(&name.to_string()));
        assert!(has_template(name));
        assert!(!has_template("dynreg/missing"));

        // Remove semantics.
        assert!(remove_dynamic_template(name));
        assert!(!remove_dynamic_template(name));
        assert!(!has_template(name));

        // Precedence: dynamic tier wins over boot env on collision.
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("DynPrec.jinja"), "<b>boot</b>").unwrap();
        load_from(dir.path());
        register_template("DynPrec", "<b>dyn</b>").expect("register DynPrec");
        let out = render("DynPrec", b"{}").expect("render DynPrec dynamic");
        assert_eq!(out, "<b>dyn</b>");
        assert!(remove_dynamic_template("DynPrec"));
        let out = render("DynPrec", b"{}").expect("render DynPrec boot");
        assert_eq!(out, "<b>boot</b>");

        // Hot-reload survival: replacing ENV via load_from leaves the dynamic
        // tier untouched.
        register_template("dynreg/survivor", "<i>{{ v }}</i>").expect("register survivor");
        let dir2 = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir2.path().join("DynPrec.jinja"), "<b>boot</b>").unwrap();
        load_from(dir2.path());
        let out = render("dynreg/survivor", br#"{"v":"ok"}"#).expect("render survivor");
        assert_eq!(out, "<i>ok</i>");

        // Cleanup so other tests see a pristine dynamic tier.
        assert!(remove_dynamic_template("dynreg/survivor"));
    }

    #[test]
    fn register_validation_errors() {
        let _guard = TEST_LOCK.lock();

        assert!(matches!(
            register_template("", "<p>x</p>"),
            Err(RegisterError::EmptyName)
        ));
        assert!(matches!(
            register_template("bad\u{0}name", "<p>x</p>"),
            Err(RegisterError::NameControlChar)
        ));
        assert!(matches!(
            register_template(&"a".repeat(513), "<p>x</p>"),
            Err(RegisterError::NameTooLong)
        ));
    }
}
