//! M3-F: `useStore(handle)` as a native-tier intrinsic (spec §2.3, D7).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn analyze_at(case: &str, src: &str) -> ComponentIR {
    let path = format!("tests/fixtures/{case}/T.tsx");
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            &path,
            s.into_bytes(),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

const PRE: &str = "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\n";

fn component(body: &str) -> String {
    format!("{PRE}export default function T(props: any) {{ {body} }}")
}

/// The structural (pre-placement) template.
fn structural(ir: &ComponentIR) -> &Node {
    &ir.structural.as_ref().expect("structural IR").template
}

/// Every `Ident` read in the structural template's slots.
fn slot_idents(n: &Node, out: &mut Vec<(String, IdentKind)>) {
    match n {
        Node::Element { children, .. } => children.iter().for_each(|c| slot_idents(c, out)),
        Node::Fragment(cs) => cs.iter().for_each(|c| slot_idents(c, out)),
        Node::Slot(Expr::Raw(RawExpr {
            kind: RawKind::Ident { name, kind },
            ..
        })) => out.push((name.clone(), kind.clone())),
        _ => {}
    }
}

fn idents(ir: &ComponentIR) -> Vec<(String, IdentKind)> {
    let mut out = vec![];
    slot_idents(structural(ir), &mut out);
    out
}

fn store(handle: &str, key: Option<&str>) -> IdentKind {
    IdentKind::Store {
        handle: handle.into(),
        key: key.map(Into::into),
    }
}

fn rules(ir: &ComponentIR) -> Vec<&str> {
    ir.diagnostics.iter().map(|d| d.rule.as_str()).collect()
}

fn import(l: &str, s: &str, i: &str) -> (String, String, String) {
    (l.into(), s.into(), i.into())
}

#[test]
fn use_store_view() {
    let ir = analyze_at(
        "use_store_view",
        &component("const s = useStore(cart); return <p>{s.count}</p>"),
    );
    assert_eq!(ir.stores.len(), 1, "{:?}", ir.diagnostics);
    let u = &ir.stores[0];
    assert_eq!(u.view.as_deref(), Some("s"));
    assert_eq!(u.handle, "cart");
    assert_eq!(u.import, import("cart", "./cart", "cart"));
    assert!(u.fields.is_empty());
    assert_eq!(u.resolved, None);
    assert_eq!(
        idents(&ir),
        [("s.count".to_string(), store("cart", Some("count")))]
    );
    assert!(
        !rules(&ir).contains(&"hook-unsupported"),
        "{:?}",
        ir.diagnostics
    );
    assert!(!rules(&ir).contains(&"hook-shape"), "{:?}", ir.diagnostics);

    // `s?.count` and `s["count"]` collapse the same way.
    for read in ["s?.count", "s[\"count\"]"] {
        let ir = analyze_at(
            "use_store_view",
            &component(&format!(
                "const s = useStore(cart); return <p>{{{read}}}</p>"
            )),
        );
        assert_eq!(
            idents(&ir),
            [("s.count".to_string(), store("cart", Some("count")))],
            "{read}"
        );
    }
}

#[test]
fn use_store_destructure() {
    let ir = analyze_at(
        "use_store_destructure",
        &component("const { count, items: list } = useStore(cart); return <p>{list}</p>"),
    );
    assert_eq!(ir.stores.len(), 1, "{:?}", ir.diagnostics);
    let u = &ir.stores[0];
    assert_eq!(u.view, None);
    assert_eq!(
        u.fields,
        [
            ("count".to_string(), "count".to_string()),
            ("items".to_string(), "list".to_string())
        ]
    );
    assert_eq!(
        idents(&ir),
        [("list".to_string(), store("cart", Some("items")))]
    );
    assert!(!rules(&ir).contains(&"body-shape"), "{:?}", ir.diagnostics);
}

#[test]
fn use_store_alias() {
    let ir = analyze_at(
        "use_store_alias",
        "import { useStore as useS } from '@brust/core/store/react'\nimport { cart } from './cart'\nexport default function T() { const s = useS(cart); return <p>{s.count}</p> }",
    );
    assert_eq!(ir.stores.len(), 1, "{:?}", ir.diagnostics);
    assert_eq!(ir.stores[0].view.as_deref(), Some("s"));
    assert_eq!(
        idents(&ir),
        [("s.count".to_string(), store("cart", Some("count")))]
    );

    let z = analyze_at(
        "use_store_alias",
        "import { useStore } from 'zustand'\nimport { cart } from './cart'\nexport default function T() { const s = useStore(cart); return <p>{s.count}</p> }",
    );
    assert!(z.stores.is_empty());
    assert!(
        rules(&z).contains(&"hook-unsupported"),
        "{:?}",
        z.diagnostics
    );
}

#[test]
fn use_store_shapes() {
    let has = |body: &str, rule: &str| {
        let ir = analyze_at("use_store_shapes", &component(body));
        assert!(
            rules(&ir).contains(&rule),
            "{body}: expected {rule}, got {:?}",
            ir.diagnostics
        );
        assert!(ir.stores.is_empty(), "{body}");
        ir
    };
    has(
        "const s = useStore(); return <p>{s.count}</p>",
        "hook-shape",
    );
    has(
        "const s = useStore(cart, 1); return <p>{s.count}</p>",
        "hook-shape",
    );
    has(
        "const [a] = useStore(cart); return <p>{a}</p>",
        "hook-shape",
    );
    has(
        "const { ...rest } = useStore(cart); return <p>{rest.count}</p>",
        "hook-shape",
    );
    has(
        "const { a = 1 } = useStore(cart); return <p>{a}</p>",
        "hook-shape",
    );
    has(
        "const s = useStore(props.h); return <p>{s.count}</p>",
        "store-name-unresolved",
    );
    has(
        "const n = useStore(cart).count; return <p>{n}</p>",
        "hook-unsupported",
    );
    let bare = has("useStore(cart); return <p>x</p>", "hook-shape");
    assert!(
        bare.diagnostics
            .iter()
            .any(|d| d.rule == "hook-shape" && d.message.contains("useStore result must be bound")),
        "{:?}",
        bare.diagnostics
    );
}

#[test]
fn use_store_namespace() {
    let ir = analyze_at(
        "use_store_namespace",
        "import { useStore } from 'brust/store/react'\nimport * as stores from './stores'\nexport default function T() { const s = useStore(stores.cart); return <p>{s.count}</p> }",
    );
    assert_eq!(ir.stores.len(), 1, "{:?}", ir.diagnostics);
    let u = &ir.stores[0];
    assert_eq!(u.handle, "stores.cart");
    assert_eq!(u.import, import("stores", "./stores", "*"));
    assert_eq!(
        idents(&ir),
        [("s.count".to_string(), store("stores.cart", Some("count")))]
    );
}
