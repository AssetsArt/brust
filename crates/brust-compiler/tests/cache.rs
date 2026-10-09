//! M1b-2 Task 6: `cache()` wrapper recognition (spec §3.4).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source("C.tsx", s.into_bytes(), &AnalyzeOptions::default()).unwrap()
    })
}

const CARD: &str =
    "import { cache } from 'brust'\nfunction Card({ item }: any) { return <p>{item.name}</p> }\n";

#[test]
fn cache_wrapper_reads_component_and_options() {
    let ir = analyze(&format!(
        "{CARD}export default cache(Card, {{ key: (p) => p.item.id, tags: (p) => ['product', p.item.id], revalidate: 60 }})"
    ));
    let c = ir.cache.expect("cache");
    assert_eq!(c.revalidate, Some(60.0));
    assert!(matches!(
        c.key,
        Some(RawExpr {
            kind: RawKind::Arrow { .. },
            ..
        })
    ));
    assert_eq!(c.key.unwrap().to_js(), "(p) => p.item.id");
    assert_eq!(c.tags.unwrap().to_js(), "(p) => [\"product\", p.item.id]");
    assert_eq!(ir.props[0].name, "item");
    assert_eq!(ir.tier, Tier::Static);
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
}

#[test]
fn cache_without_options_and_bad_shapes() {
    let ir = analyze(&format!("{CARD}export default cache(Card)"));
    assert_eq!(
        ir.cache,
        Some(CacheDecl {
            key: None,
            tags: None,
            revalidate: None
        })
    );
    let ir = analyze(&format!("{CARD}export default cache(Card, 60)"));
    assert!(
        ir.diagnostics
            .iter()
            .any(|d| d.rule == "cache-shape" && d.class == DiagClass::Error),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn a_cache_not_from_brust_is_not_recognised() {
    let ir = analyze(
        "import { cache } from 'react'\nfunction Card() { return <p/> }\nexport default cache(Card)",
    );
    assert!(ir.cache.is_none());
    assert!(
        ir.diagnostics
            .iter()
            .any(|d| d.rule == "default-export-shape")
    );
}

#[test]
fn plain_function_export_has_no_cache() {
    let ir = analyze("export default function X() { return <p/> }");
    assert!(ir.cache.is_none());
}
