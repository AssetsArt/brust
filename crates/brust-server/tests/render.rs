use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use brust_server::manifest::{Loaded, Manifest};
use brust_server::render::{RenderError, Renderer, inject_assets, use_ids};
use serde_json::json;

fn fx() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist")
}

fn load() -> (Loaded, Renderer) {
    let l = Manifest::load(&fx()).unwrap();
    let r = Renderer::from_templates(&l.templates).unwrap();
    (l, r)
}

fn chain(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

fn no_ids(_: &str) -> Vec<(String, String)> {
    Vec::new()
}

#[test]
fn outlet_composes_leaf_first() {
    let (_l, r) = load();
    let html = r
        .render_chain(
            &chain(&["appLayout_a1", "homePage_b2"]),
            &json!({}),
            &no_ids,
        )
        .unwrap();
    assert_eq!(
        html,
        "<!doctype html><html><head><title>fx</title></head><body><nav>fx</nav><main><h1>Home</h1></main></body></html>"
    );
}

#[test]
fn outlet_is_not_escaped() {
    let l = Manifest::load(&fx()).unwrap();
    let mut templates: BTreeMap<String, String> = l.templates.clone();
    templates.insert("leaf".into(), "<p><b>{{ who | e }}</b></p>".into());
    let r = Renderer::from_templates(&templates).unwrap();
    let html = r
        .render_chain(
            &chain(&["appLayout_a1", "leaf"]),
            &json!({"who": "<i>"}),
            &no_ids,
        )
        .unwrap();
    assert!(
        html.contains("<nav>fx</nav><p><b>&lt;i&gt;</b></p></body>"),
        "{html}"
    );
}

#[test]
fn dynamic_text_is_escaped() {
    let (_l, r) = load();
    let html = r
        .render("notFoundPage_f6", &json!({"path": "<x>"}))
        .unwrap();
    assert!(html.contains("&lt;x&gt;"), "{html}");
    assert!(!html.contains("<x>"), "{html}");
}

#[test]
fn inject_assets_static_chain_adds_nothing() {
    let (l, _r) = load();
    let html = "<html><body><p>x</p></body></html>".to_string();
    let out = inject_assets(
        html.clone(),
        &chain(&["appLayout_a1", "homePage_b2"]),
        &l.manifest,
    );
    assert_eq!(out, html);
}

#[test]
fn inject_assets_native_chain_adds_runtime_then_chunk_before_body_close() {
    let (l, _r) = load();
    let out = inject_assets(
        "<html><body><p>x</p></body></html>".into(),
        &chain(&["appLayout_a1", "detailPage_c3"]),
        &l.manifest,
    );
    assert!(
        out.ends_with(
            "<script type=\"module\" src=\"/_brust/client/runtime-8b1c.js\"></script><script type=\"module\" src=\"/_brust/client/detailPage_c3-1a2b3c.js\"></script></body></html>"
        ),
        "{out}"
    );
    assert!(!out.contains("react-19.2.0"), "{out}");
    assert_eq!(out.matches("runtime-8b1c.js").count(), 1, "{out}");
}

#[test]
fn inject_assets_react_child_adds_react_bundle_and_island_chunk() {
    let (l, _r) = load();
    let out = inject_assets(
        "<html><body></body></html>".into(),
        &chain(&["appLayout_a1", "teamPage_g7"]),
        &l.manifest,
    );
    let order = [
        "client/runtime-8b1c.js",
        "client/teamPage_g7-4d5e6f.js",
        "client/react-19.2.0.js",
        "client/react-teamBuilder_h8.js",
    ];
    let pos: Vec<usize> = order
        .iter()
        .map(|p| {
            out.find(p)
                .unwrap_or_else(|| panic!("missing {p} in {out}"))
        })
        .collect();
    assert!(
        pos.windows(2).all(|w| w[0] < w[1]),
        "order {pos:?} in {out}"
    );
    for p in order {
        assert_eq!(out.matches(p).count(), 1, "{p} once in {out}");
    }
    assert!(out.ends_with("</script></body></html>"), "{out}");
}

#[test]
fn inject_assets_without_body_appends() {
    let (l, _r) = load();
    let out = inject_assets(
        "<p>x</p>".into(),
        &chain(&["appLayout_a1", "detailPage_c3"]),
        &l.manifest,
    );
    assert!(out.starts_with("<p>x</p><script"), "{out}");
    assert!(out.ends_with("</script>"), "{out}");
}

#[test]
fn use_ids_are_stable_and_distinct() {
    let want = vec![
        ("_id1".to_string(), "brust-r6-idsPage_i9-1".to_string()),
        ("_id2".to_string(), "brust-r6-idsPage_i9-2".to_string()),
    ];
    assert_eq!(use_ids("r6", "idsPage_i9", 2), want);
    assert_eq!(use_ids("r6", "idsPage_i9", 2), want);
    assert!(use_ids("r6", "idsPage_i9", 0).is_empty());
}

#[test]
fn render_error_names_template_and_line() {
    // minijinja compiles at `add_template_owned`, so a syntax error surfaces from
    // `from_templates` (boot), not from `render`.
    let mut templates = BTreeMap::new();
    templates.insert("bad".to_string(), "<p>\n{{ 1 +* }}</p>".to_string());
    match Renderer::from_templates(&templates) {
        Err(RenderError::Render { name, msg }) => {
            assert_eq!(name, "bad");
            assert!(msg.contains("line 2"), "{msg}");
            assert!(msg.contains("bad"), "{msg}");
        }
        Err(other) => panic!("expected Render error, got {other:?}"),
        Ok(_) => panic!("expected Render error, got Ok"),
    }
}
