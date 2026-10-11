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

// --- Task 2: `<name>` from `defineStore('<lit>', …)` through the handle's import. ---

/// A fresh temp root holding `files`, with `C.tsx` analysed there.
fn analyze_tree(files: &[(&str, &str)]) -> ComponentIR {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("brustc-store-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, text) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let src = files
        .iter()
        .find(|(p, _)| *p == "C.tsx")
        .expect("C.tsx")
        .1
        .to_string();
    let r = root.clone();
    let ir = run_on_compiler_thread(move || {
        analyze_source(
            "C.tsx",
            src.into_bytes(),
            &AnalyzeOptions {
                root: r,
                ..Default::default()
            },
        )
        .unwrap()
    });
    let _ = std::fs::remove_dir_all(&root);
    ir
}

/// `C.tsx` reading `cart` imported as `import_line`.
fn reader(import_line: &str) -> String {
    format!(
        "import {{ useStore }} from 'brust/store/react'\n{import_line}\nexport default function C() {{ const s = useStore(cart); return <p>{{s.count}}</p> }}"
    )
}

const CART: &str = "import { defineStore, signal } from 'brust/store'\nexport const cart = defineStore('cart', () => ({ count: signal(0) }))\n";

fn resolved(ir: &ComponentIR) -> &StoreRef {
    assert_eq!(ir.stores.len(), 1, "{:?}", ir.diagnostics);
    ir.stores[0]
        .resolved
        .as_ref()
        .unwrap_or_else(|| panic!("unresolved: {:?}", ir.diagnostics))
}

fn store_ref(module: &str, signals: &[&str], computeds: &[&str]) -> StoreRef {
    StoreRef {
        name: "cart".into(),
        module: module.into(),
        signals: signals.iter().map(|s| s.to_string()).collect(),
        computeds: computeds.iter().map(|s| s.to_string()).collect(),
        factory_read: true,
    }
}

#[test]
fn store_name_resolves() {
    let named = reader("import { cart } from './cart'");
    let cases: Vec<(&str, Vec<(&str, String)>, StoreRef)> = vec![
        (
            "export const",
            vec![("cart.ts", CART.into())],
            store_ref("cart.ts", &["count"], &[]),
        ),
        (
            "block factory",
            vec![(
                "cart.ts",
                "import { defineStore, signal, computed } from 'brust/store'\nexport const cart = defineStore('cart', () => { const count = signal(0); const dbl = computed(() => count() * 2); return { count, dbl } })\n".into(),
            )],
            store_ref("cart.ts", &["count"], &["dbl"]),
        ),
        (
            "export clause alias",
            vec![(
                "cart.ts",
                "import { defineStore, signal } from 'brust/store'\nconst c = defineStore('cart', () => ({ count: signal(0) }))\nexport { c as cart }\n".into(),
            )],
            store_ref("cart.ts", &["count"], &[]),
        ),
        (
            "export from",
            vec![
                ("stores/index.ts", "export { cart } from './inner'\n".into()),
                ("stores/inner.ts", CART.into()),
            ],
            store_ref("stores/inner.ts", &["count"], &[]),
        ),
        (
            "export star",
            vec![
                ("cart.ts", "export * from './inner'\n".into()),
                ("inner.ts", CART.into()),
            ],
            store_ref("inner.ts", &["count"], &[]),
        ),
        (
            "import then export",
            vec![
                (
                    "cart.ts",
                    "import { cart } from './inner'\nexport { cart }\n".into(),
                ),
                ("inner.ts", CART.into()),
            ],
            store_ref("inner.ts", &["count"], &[]),
        ),
        (
            "aliased defineStore",
            vec![(
                "cart.ts",
                "import { defineStore as ds, signal as sig } from '@brust/core/store'\nexport const cart = ds('cart', () => ({ count: sig(0) }))\n".into(),
            )],
            store_ref("cart.ts", &["count"], &[]),
        ),
        (
            "runtime-dom defineStore",
            vec![(
                "cart.ts",
                "import { defineStore, signal } from '@brust/runtime-dom'\nexport const cart = defineStore('cart', () => ({ count: signal(0) }))\n".into(),
            )],
            store_ref("cart.ts", &["count"], &[]),
        ),
        (
            "template literal name",
            vec![(
                "cart.ts",
                "import { defineStore, signal } from 'brust/store'\nexport const cart = defineStore(`cart`, () => ({ count: signal(0) }))\n".into(),
            )],
            store_ref("cart.ts", &["count"], &[]),
        ),
    ];
    for (what, files, want) in cases {
        let c = if what == "export from" {
            reader("import { cart } from './stores'")
        } else {
            named.clone()
        };
        let mut all: Vec<(&str, &str)> = files.iter().map(|(p, t)| (*p, t.as_str())).collect();
        all.push(("C.tsx", &c));
        let ir = analyze_tree(&all);
        assert_eq!(resolved(&ir), &want, "{what}");
        assert!(
            !rules(&ir).contains(&"store-name-unresolved"),
            "{what}: {:?}",
            ir.diagnostics
        );
    }

    // `export default defineStore(…)` imported as the default.
    let ir = analyze_tree(&[
        (
            "cart.ts",
            "import { defineStore, signal } from 'brust/store'\nexport default defineStore('cart', () => ({ count: signal(0) }))\n",
        ),
        ("C.tsx", &reader("import cart from './cart'")),
    ]);
    assert_eq!(resolved(&ir), &store_ref("cart.ts", &["count"], &[]));
}

#[test]
fn store_name_unresolved() {
    let named = reader("import { cart } from './cart'");
    let def = |body: &str| format!("import {{ defineStore, signal }} from 'brust/store'\n{body}\n");
    let cases: Vec<(&str, Vec<(&str, String)>, &str)> = vec![
        (
            "concatenated name",
            vec![(
                "cart.ts",
                def("const prefix = 'x'\nexport const cart = defineStore(prefix + 'cart', () => ({ count: signal(0) }))"),
            )],
            "is not a string literal",
        ),
        (
            "bad charset (D6)",
            vec![(
                "cart.ts",
                def("export const cart = defineStore('a b', () => ({ count: signal(0) }))"),
            )],
            "is not [A-Za-z0-9_.:-]+",
        ),
        ("missing module", vec![], "cannot resolve"),
        (
            "no such export",
            vec![("cart.ts", def("export const other = defineStore('cart', () => ({ count: signal(0) }))"))],
            "no export",
        ),
        (
            "zustand defineStore",
            vec![(
                "cart.ts",
                "import { defineStore } from 'zustand'\nexport const cart = defineStore('cart', () => ({}))\n".into(),
            )],
            "is not a defineStore",
        ),
        (
            "re-export cycle",
            vec![
                ("cart.ts", "export { cart } from './b'\n".into()),
                ("b.ts", "export { cart } from './cart'\n".into()),
            ],
            "cycle",
        ),
        (
            "star re-export cycle",
            vec![
                ("cart.ts", "export * from './b'\n".into()),
                ("b.ts", "export * from './cart'\n".into()),
            ],
            "cycle",
        ),
    ];
    let check = |what: &str, ir: &ComponentIR, reason: &str| {
        assert!(
            ir.stores.iter().all(|u| u.resolved.is_none()),
            "{what}: {:?}",
            ir.stores
        );
        let un: Vec<_> = ir
            .diagnostics
            .iter()
            .filter(|d| d.rule == "store-name-unresolved")
            .collect();
        assert_eq!(un.len(), 1, "{what}: {:?}", ir.diagnostics);
        assert_eq!(un[0].class, DiagClass::Fallback, "{what}");
        assert!(
            un[0].message.contains(reason),
            "{what}: expected {reason:?} in {:?}",
            un[0].message
        );
        assert!(
            matches!(ir.tier, Tier::React { .. }),
            "{what}: {:?}",
            ir.tier
        );
        un[0].clone()
    };
    for (what, files, reason) in cases {
        let mut all: Vec<(&str, &str)> = files.iter().map(|(p, t)| (*p, t.as_str())).collect();
        all.push(("C.tsx", &named));
        check(what, &analyze_tree(&all), reason);
    }

    // A package handle.
    let ir = analyze_tree(&[("C.tsx", &reader("import { cart } from 'shop-stores'"))]);
    check("package", &ir, "is imported from the package shop-stores");

    // R4: a store defined in the component's own module.
    let own = format!(
        "import {{ useStore }} from 'brust/store/react'\nimport {{ defineStore, signal }} from 'brust/store'\nconst cart = defineStore('cart', () => ({{ count: signal(0) }}))\nexport default function C() {{ const s = useStore(cart); return <p>{{s.count}}</p> }}"
    );
    let d = check(
        "same module",
        &analyze_tree(&[("C.tsx", &own)]),
        "own module",
    );
    assert!(
        d.remediation.contains("define the store in its own module"),
        "{d:?}"
    );
    // … also when the component imports it back from itself.
    let own = format!(
        "import {{ useStore }} from 'brust/store/react'\nimport {{ defineStore, signal }} from 'brust/store'\nimport {{ cart }} from './C'\nexport const cart2 = defineStore('cart', () => ({{ count: signal(0) }}))\nexport default function C() {{ const s = useStore(cart); return <p>{{s.count}}</p> }}"
    );
    let d = check(
        "self import",
        &analyze_tree(&[("C.tsx", &own)]),
        "own module",
    );
    assert!(
        d.remediation.contains("define the store in its own module"),
        "{d:?}"
    );
}

#[test]
fn store_factory_keys() {
    // An unreadable factory: the name resolves, the keys are unknown.
    let ir = analyze_tree(&[
        (
            "cart.ts",
            "import { defineStore, signal } from 'brust/store'\nfunction makeStore() { return { count: signal(0) } }\nexport const cart = defineStore('cart', () => makeStore())\n",
        ),
        ("C.tsx", &reader("import { cart } from './cart'")),
    ]);
    let r = resolved(&ir);
    assert_eq!(r.name, "cart");
    assert!(!r.factory_read);
    assert!(r.signals.is_empty() && r.computeds.is_empty(), "{r:?}");

    // An action is neither a signal nor a computed; keys come out sorted.
    let ir = analyze_tree(&[
        (
            "cart.ts",
            "import { defineStore, signal, computed } from 'brust/store'\nexport const cart = defineStore('cart', function () { const count = signal(0); return { zeta: signal(1), count, add: (n: number) => count.set(n), dbl: computed(() => count() * 2) } })\n",
        ),
        ("C.tsx", &reader("import { cart } from './cart'")),
    ]);
    assert_eq!(
        resolved(&ir),
        &store_ref("cart.ts", &["count", "zeta"], &["dbl"])
    );
}

#[test]
fn store_name_duplicate() {
    let ir = analyze_tree(&[
        ("cart.ts", CART),
        (
            "cart2.ts",
            "import { defineStore, signal } from 'brust/store'\nexport const cart2 = defineStore('cart', () => ({ count: signal(0) }))\n",
        ),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nimport { cart2 } from './cart2'\nexport default function C() { const a = useStore(cart); const b = useStore(cart2); return <p>{a.count}{b.count}</p> }",
        ),
    ]);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    let dup: Vec<_> = ir
        .diagnostics
        .iter()
        .filter(|d| d.rule == "store-name-duplicate")
        .collect();
    assert_eq!(dup.len(), 1, "{:?}", ir.diagnostics);
    assert_eq!(dup[0].class, DiagClass::Warning);

    // The same store read twice is not a duplicate.
    let ir = analyze_tree(&[
        ("cart.ts", CART),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nexport default function C() { const a = useStore(cart); const b = useStore(cart); return <p>{a.count}{b.count}</p> }",
        ),
    ]);
    assert!(
        !rules(&ir).contains(&"store-name-duplicate"),
        "{:?}",
        ir.diagnostics
    );
}
