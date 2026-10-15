//! F147: brust's hoisted handler names (`_hN`) never take a name the component's module spells. A page that binds
//! its own `_h1` / `_h2` keeps them, and the inline handler and the one forwarded through a static child's spread are
//! hoisted under other names: each element binds its own handler and the chunk declares each name once.
//! Served in Chromium: `tests/server/handler-names.chromium.test.ts`.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// Compiles `tests/fixtures/shadcn/repro/<file>`: (tier, jinja, chunk).
fn lower(file: &str) -> (Tier, String, String) {
    let path = format!("tests/fixtures/shadcn/repro/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            None,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        (
            tree[0].ir.tier.clone(),
            a.jinja.clone(),
            a.client_js.clone().unwrap_or_default(),
        )
    })
}

/// The handler `x-on-click` binds on the element with `data-testid="<id>"`.
fn bound(jinja: &str, id: &str) -> String {
    let at = jinja.find(&format!("data-testid=\"{id}\"")).unwrap_or_else(|| {
        // A spread child prints its attributes through filters: find the literal value instead.
        jinja.find(&format!("\"{id}\"")).expect(id)
    });
    let rest = &jinja[at..];
    let on = rest.find("x-on-click=\"").expect("x-on-click") + "x-on-click=\"".len();
    rest[on..on + rest[on..].find('"').unwrap()].to_string()
}

/// `const <name> = <rest of line>` for the one declaration of `name` in the chunk.
fn declared<'a>(chunk: &'a str, name: &str) -> &'a str {
    let decl = format!("const {name} = ");
    assert_eq!(chunk.matches(&decl).count(), 1, "{name} declared once:\n{chunk}");
    let at = chunk.find(&decl).unwrap() + decl.len();
    chunk[at..].lines().next().unwrap()
}

#[test]
fn an_inline_handler_is_not_hoisted_under_a_name_the_page_binds() {
    let (tier, jinja, chunk) = lower("handler-names.tsx");
    assert!(matches!(tier, Tier::Native), "{tier:?}");
    assert_eq!(bound(&jinja, "b"), "_h1");
    assert!(declared(&chunk, "_h1").contains("n() + 10"), "{chunk}");
    let s = bound(&jinja, "s");
    assert_ne!(s, "_h1");
    assert_ne!(s, "_h2");
    assert!(declared(&chunk, &s).contains("n() + 1)"), "{chunk}");
    let btn = bound(&jinja, "btn");
    assert!(![s.as_str(), "_h1", "_h2"].contains(&btn.as_str()), "{btn}");
    assert!(declared(&chunk, &btn).contains("n() + 100"), "{chunk}");
}

#[test]
fn a_forwarded_handler_is_not_hoisted_under_a_name_the_page_binds() {
    let (tier, jinja, chunk) = lower("handler-names-forward.tsx");
    assert!(matches!(tier, Tier::Native), "{tier:?}");
    assert_eq!(bound(&jinja, "b"), "_h1");
    assert!(declared(&chunk, "_h1").contains("n() + 10"), "{chunk}");
    assert!(declared(&chunk, "_h2").contains("n() * 2"), "{chunk}");
    let btn = bound(&jinja, "btn");
    assert!(!["_h1", "_h2"].contains(&btn.as_str()), "{btn}");
    assert!(declared(&chunk, &btn).contains("n() + 100"), "{chunk}");
}
