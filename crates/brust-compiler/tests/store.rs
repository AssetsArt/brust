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

// --- Task 3: store-view reads paint `__store.<name>.<key>` (server path). ---

/// Lowers `src` as `tests/fixtures/{case}/T.tsx` (so `./cart` resolves in `store-read`).
fn lower_at(case: &str, src: &str) -> (ComponentIR, String, String) {
    lower_in(
        repo(),
        format!("tests/fixtures/{case}/T.tsx"),
        src.to_string(),
    )
}

fn lower_in(root: PathBuf, path: String, src: String) -> (ComponentIR, String, String) {
    let (ir, a) = lower_artifacts(root, path, src);
    (ir, a.jinja, a.client_js.unwrap_or_default())
}

fn lower_artifacts(
    root: PathBuf,
    path: String,
    src: String,
) -> (ComponentIR, brust_compiler::lower::Artifacts) {
    use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
    use brust_compiler::pipeline::compile_tree;
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        ((*tree[0].ir).clone(), tree[0].artifacts.clone())
    })
}

/// `C.tsx` lowered in a fresh temp root holding `files`.
fn lower_tree(files: &[(&str, &str)]) -> (ComponentIR, String, String) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("brustc-store-lower-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, text) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let src = files.iter().find(|(p, _)| *p == "C.tsx").expect("C.tsx").1;
    let out = lower_in(root.clone(), "C.tsx".into(), src.to_string());
    let _ = std::fs::remove_dir_all(&root);
    out
}

fn render(jinja: &str, ctx: serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx)).unwrap()
}

#[test]
fn store_read_paints_server_path() {
    let (ir, j, _) = lower_at(
        "store-read",
        &component("const s = useStore(cart); return <p>{s.count}</p>"),
    );
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    assert!(j.contains("{{ __store.cart.count | e }}"), "{j}");
    let html = render(&j, serde_json::json!({"__store": {"cart": {"count": 3}}}));
    assert!(html.contains(">3</p>"), "{html}");
    // C1: the snapshot never reaches props.
    assert!(!j.contains("x-props"), "{j}");
    assert!(
        !rules(&ir).contains(&"store-name-dotted"),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn store_read_destructured() {
    let (_, j, _) = lower_at(
        "store-read",
        &component("const { count } = useStore(cart); return <p>{count}</p>"),
    );
    assert!(j.contains("{{ __store.cart.count | e }}"), "{j}");
}

#[test]
fn store_reads_never_reach_client_props() {
    // A handler and a painted value both read the store; neither is a prop.
    let (ir, _, _) = lower_at(
        "store-read",
        &component(
            "const s = useStore(cart); return <button onClick={() => console.log(s.count, props.x)}>{s.count}</button>",
        ),
    );
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    assert!(
        ir.client_props.iter().all(|p| !p.starts_with("__store")),
        "{:?}",
        ir.client_props
    );
    assert!(
        ir.client_imports
            .contains(&("./cart".to_string(), "cart".to_string())),
        "{:?}",
        ir.client_imports
    );
}

const TEAM: &str = "import { defineStore, signal } from 'brust/store'\nexport const team = defineStore('pokedex.team', () => ({ members: signal('') }))\n";

#[test]
fn store_name_with_dot() {
    let (ir, j, _) = lower_tree(&[
        ("team.ts", TEAM),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { team } from './team'\nexport default function C() { const s = useStore(team); const t = useStore(team); return <p>{s.members}{t.members}</p> }",
        ),
    ]);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    assert!(
        j.contains("{{ __store[\"pokedex.team\"].members | e }}"),
        "{j}"
    );
    let html = render(
        &j,
        serde_json::json!({"__store": {"pokedex.team": {"members": "ash"}}}),
    );
    assert!(html.contains("ash"), "{html}");
    // R3: the job input falls back to the coarse `__store`; one warning per store name.
    let dotted: Vec<_> = ir
        .diagnostics
        .iter()
        .filter(|d| d.rule == "store-name-dotted")
        .collect();
    assert_eq!(dotted.len(), 1, "{:?}", ir.diagnostics);
    assert_eq!(dotted[0].class, DiagClass::Warning);
    assert!(
        dotted[0].message.contains("pokedex.team"),
        "{:?}",
        dotted[0]
    );
    assert!(
        dotted[0].message.contains("whole snapshot"),
        "{:?}",
        dotted[0]
    );
    assert!(
        dotted[0]
            .remediation
            .contains("prefer dot-free store names"),
        "{:?}",
        dotted[0]
    );

    // A dotted key falls back the same way.
    let (ir, j, _) = lower_tree(&[
        ("cart.ts", CART),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nexport default function C() { const s = useStore(cart); return <p>{s[\"a.b\"]}</p> }",
        ),
    ]);
    assert!(j.contains("__store.cart[\"a.b\"]"), "{j}");
    assert!(
        rules(&ir).contains(&"store-name-dotted"),
        "{:?}",
        ir.diagnostics
    );

    // An unresolved handle already falls back: no dotted warning.
    let ir = analyze_tree(&[("C.tsx", &reader("import { cart } from 'shop.stores'"))]);
    assert!(
        !rules(&ir).contains(&"store-name-dotted"),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn store_input_paths() {
    use brust_compiler::analyze::passes::deps::{split_inputs, store_input};
    assert_eq!(
        store_input(Some("cart"), Some("count")),
        "__store.cart.count"
    );
    assert_eq!(store_input(Some("cart"), None), "__store.cart");
    assert_eq!(
        store_input(Some("pokedex.team"), Some("members")),
        "__store"
    );
    assert_eq!(store_input(Some("cart"), Some("a[0]")), "__store");
    assert_eq!(store_input(Some("cart"), Some("")), "__store");
    assert_eq!(store_input(None, Some("count")), "__store");
    let d = split_inputs(&[
        "item.price".into(),
        "__store".into(),
        "__store.cart.count".into(),
        "__storey".into(),
    ]);
    assert_eq!(
        d.props.into_iter().collect::<Vec<_>>(),
        ["__storey", "item.price"]
    );
    assert_eq!(
        d.stores.into_iter().collect::<Vec<_>>(),
        ["__store", "__store.cart.count"]
    );
}

// --- Task 4: store-view reads are live signal reads in the client chunk. ---

#[test]
fn store_read_chunk() {
    let (ir, j, c) = lower_at(
        "store-read",
        &component("const s = useStore(cart); return <p>{s.count}</p>"),
    );
    assert!(c.contains("import { cart } from \"./cart\""), "{c}");
    assert!(
        c.contains("const _c1 = computed(() => __text(cart.count()))"),
        "{c}"
    );
    assert!(j.contains("x-text=\"_c1\""), "{j}");
    // A store read is the only dynamic value: still not Static.
    assert_eq!(ir.tier, Tier::Native, "{:?}", ir.diagnostics);
    assert!(!c.contains("snapshot"), "{c}");
}

#[test]
fn store_handler_reads() {
    let (_, _, c) = lower_at(
        "store-read",
        &component(
            "const s = useStore(cart); return <button onClick={() => cart.count.set(s.count + 1)}>{s.count}</button>",
        ),
    );
    assert!(c.contains("cart.count.set(cart.count() + 1)"), "{c}");
    assert!(!c.contains("snapshot"), "{c}");
}

#[test]
fn store_block_handler_view() {
    let (_, _, c) = lower_at(
        "store-read",
        &component(
            "const s = useStore(cart); return <button onClick={() => cart.count.set(s.count + 1)} onDoubleClick={() => { const n = s.count * 2; cart.count.set(n) }}>{s.count}</button>",
        ),
    );
    let view = "const s = { get count() { return cart.count() } }";
    assert_eq!(c.matches(view).count(), 1, "{c}");
    // The verbatim body reads the chunk's `s`: never re-bound.
    assert!(!c.contains("((s) =>"), "{c}");
    assert!(!c.contains("(s, "), "{c}");
}

#[test]
fn store_destructured_in_block() {
    let (_, _, c) = lower_at(
        "store-read",
        &component(
            "const { count } = useStore(cart); return <button onClick={() => { const n = count * 2; cart.count.set(n) }}>{count}</button>",
        ),
    );
    assert!(c.contains("((count) => ("), "{c}");
    assert!(c.contains("))(cart.count())"), "{c}");
}

const CART_KEYS: &str = "import { defineStore, signal, computed } from 'brust/store'\nexport const cart = defineStore('cart', () => { const count = signal(0); const dbl = computed(() => count() * 2); return { count, dbl, add: (n: number) => count.set(n) } })\n";

#[test]
fn store_non_signal_key_in_handler() {
    let (ir, _, c) = lower_tree(&[
        ("cart.ts", CART_KEYS),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nexport default function C() { const s = useStore(cart); return <button onClick={() => console.log(s.add, s.dbl)}>{s.count}</button> }",
        ),
    ]);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    // React-equivalent: a snapshot drops functions.
    assert!(c.contains("cart.snapshot()[\"add\"]"), "{c}");
    assert!(c.contains("cart.dbl()"), "{c}");
}

#[test]
fn store_namespace_handle() {
    let (ir, _, c) = lower_tree(&[
        ("stores.ts", CART),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport * as stores from './stores'\nexport default function C() { const s = useStore(stores.cart); return <p>{s.count}</p> }",
        ),
    ]);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    assert!(c.contains("stores.cart.count()"), "{c}");
    assert!(c.contains("import * as stores from \"./stores\""), "{c}");
}

// --- Task 5: derived values over store reads are precompute slots keyed by `__store` paths. ---

/// The precompute job.
fn precompute_job(ir: &ComponentIR) -> &JobDecl {
    ir.jobs
        .iter()
        .find(|j| j.kind == JobKind::Precompute)
        .unwrap_or_else(|| panic!("no precompute job: {:?}", ir.jobs))
}

/// Every `Precomputed` in the template, in document order.
fn template_slots(n: &Node, out: &mut Vec<Expr>) {
    let mut e = |x: &Expr| {
        if matches!(x, Expr::Precomputed { .. }) {
            out.push(x.clone())
        }
    };
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                if let Attr::Dynamic { value, .. } = a {
                    e(value);
                }
            }
            children.iter().for_each(|c| template_slots(c, out));
        }
        Node::Slot(x) => e(x),
        Node::If { cond, then, else_ } => {
            e(cond);
            then.iter()
                .chain(else_)
                .for_each(|c| template_slots(c, out));
        }
        Node::For {
            source, key, body, ..
        } => {
            e(source);
            e(key);
            body.iter().for_each(|c| template_slots(c, out));
        }
        Node::Component {
            props, children, ..
        } => {
            props.iter().for_each(|(_, v)| e(v));
            children.iter().for_each(|c| template_slots(c, out));
        }
        Node::Fragment(cs) => cs.iter().for_each(|c| template_slots(c, out)),
        Node::Text(_) | Node::Outlet => {}
    }
}

fn slot_inputs(ir: &ComponentIR) -> Vec<Vec<String>> {
    let mut out = vec![];
    template_slots(&ir.template, &mut out);
    out.into_iter()
        .map(|e| match e {
            Expr::Precomputed { inputs, .. } => inputs,
            _ => unreachable!(),
        })
        .collect()
}

const DERIVED_PRE: &str = "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nimport { fmt } from './fmt'\n";

#[test]
fn store_derived_slot() {
    let src = format!(
        "{DERIVED_PRE}export default function T({{ unit }}: any) {{ const s = useStore(cart); const total = fmt(s.count, unit); return <p>{{total}}</p> }}"
    );
    let (ir, a) = lower_artifacts(repo(), "tests/fixtures/store-derived/T.tsx".into(), src);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    let total = ir.derived.iter().find(|d| d.name == "total").unwrap();
    let Expr::Precomputed {
        inputs,
        state_dependent,
        client_js,
        ..
    } = &total.expr
    else {
        panic!("{:?}", total.expr)
    };
    let want = ["__store.cart.count".to_string(), "unit".to_string()];
    assert_eq!(inputs, &want);
    assert!(*state_dependent, "R5");
    assert!(client_js.is_some());
    assert_eq!(precompute_job(&ir).inputs, want);

    let job = a.server_ts.as_deref().expect("job text");
    assert!(
        job.contains("const total = fmt((props.__store?.[\"cart\"] ?? {}).count, unit)"),
        "{job}"
    );
    assert!(!job.contains("import { cart }"), "{job}");

    let c = a.client_js.as_deref().unwrap_or_default();
    assert!(
        c.contains("computed(() => fmt(cart.count(), props().unit))"),
        "{c}"
    );
    assert!(a.jinja.contains("x-text"), "{}", a.jinja);
}

#[test]
fn store_guard_in_key() {
    let (ir, _, _) = lower_tree(&[
        (
            "ui.ts",
            "import { defineStore, signal } from 'brust/store'\nexport const ui = defineStore('ui', () => ({ open: signal(false) }))\n",
        ),
        (
            "fmt.ts",
            "export const fmt = (n: number, u: string) => `${n} ${u}`\n",
        ),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { ui } from './ui'\nimport { fmt } from './fmt'\nexport default function C({ price }: any) { const s = useStore(ui); return <div>{s.open ? <b>{fmt(price, 'x')}</b> : null}</div> }",
        ),
    ]);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    let slots = slot_inputs(&ir);
    assert_eq!(slots.len(), 1, "{:?}", ir.template);
    // F33: the guard is in the key.
    assert!(
        slots[0].contains(&"__store.ui.open".to_string()),
        "{slots:?}"
    );
    assert!(slots[0].contains(&"price".to_string()), "{slots:?}");
    assert!(
        precompute_job(&ir)
            .inputs
            .contains(&"__store.ui.open".to_string())
    );
}

#[test]
fn store_list_in_key() {
    let (ir, j, _) = lower_tree(&[
        (
            "cart.ts",
            "import { defineStore, signal } from 'brust/store'\nexport const cart = defineStore('cart', () => ({ items: signal([]) }))\n",
        ),
        (
            "fmt.ts",
            "export const fmt = (n: number, u: string) => `${n} ${u}`\n",
        ),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nimport { fmt } from './fmt'\nexport default function C() { const s = useStore(cart); return <ul>{s.items.map((i) => <li key={i.id}>{fmt(i.p, 'x')}</li>)}</ul> }",
        ),
    ]);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    let mut all = vec![];
    template_slots(&ir.template, &mut all);
    let per_item: Vec<_> = all
        .iter()
        .filter_map(|e| match e {
            Expr::Precomputed {
                inputs,
                per_item: Some(_),
                state_dependent,
                ..
            } => Some((inputs.clone(), *state_dependent)),
            _ => None,
        })
        .collect();
    assert_eq!(per_item.len(), 1, "{all:?}");
    assert!(
        per_item[0].0.contains(&"__store.cart.items".to_string()),
        "{per_item:?}"
    );
    assert!(per_item[0].1, "the list is stateful: {per_item:?}");
    // The client updates the list.
    assert!(j.contains("x-for"), "{j}");
}

#[test]
fn store_dotted_coarse() {
    let (ir, _, _) = lower_tree(&[
        ("team.ts", TEAM),
        (
            "fmt.ts",
            "export const fmt = (n: string, u: string) => `${n} ${u}`\n",
        ),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { team } from './team'\nimport { fmt } from './fmt'\nexport default function C({ unit }: any) { const s = useStore(team); const t = fmt(s.members, unit); return <p>{t}</p> }",
        ),
    ]);
    assert!(
        ir.stores.iter().all(|u| u.resolved.is_some()),
        "{:?}",
        ir.diagnostics
    );
    let t = ir.derived.iter().find(|d| d.name == "t").unwrap();
    let Expr::Precomputed { inputs, .. } = &t.expr else {
        panic!("{:?}", t.expr)
    };
    assert_eq!(inputs, &["__store".to_string(), "unit".to_string()]);
    assert_eq!(
        precompute_job(&ir).inputs,
        ["__store".to_string(), "unit".to_string()]
    );
    assert!(
        rules(&ir).contains(&"store-name-dotted"),
        "{:?}",
        ir.diagnostics
    );
}
