//! F569 (D4): a `Native` component records why it is not static (`ComponentIR::native_because`), one line each in a fixed
//! order; a static or React component records nothing, so its serialized IR is unchanged.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source("C.tsx", s.into_bytes(), &AnalyzeOptions::default()).unwrap()
    })
}

/// Writes `files` into a fresh app root and analyzes `C.tsx` there (a store import resolves).
fn analyze_tree(files: &[(&str, &str)]) -> ComponentIR {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let root =
        std::env::temp_dir().join(format!("brustc-native-because-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, text) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let src = files
        .iter()
        .find(|(p, _)| *p == "C.tsx")
        .unwrap()
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

fn native(ir: &ComponentIR) -> &[String] {
    assert!(
        matches!(ir.tier, Tier::Native),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    &ir.native_because
}

const IMPORTS: &str = "import { useState, useEffect, useRef } from 'react'\n";

#[test]
fn state_that_is_set_names_the_cell_and_its_line() {
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n  const [open, setOpen] = useState(false)\n  return <p data-open={{open}}>x</p>\n}}\n"
    ));
    assert_eq!(native(&ir), ["state `open` is set (line 3)"]);
}

#[test]
fn a_handler_names_its_line() {
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n  return <button onClick={{() => console.log(1)}}>x</button>\n}}\n"
    ));
    assert_eq!(native(&ir), ["an event handler (line 3)"]);
}

#[test]
fn an_effect_names_its_line() {
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n  useEffect(() => {{ document.title = 'x' }}, [])\n  return <p>x</p>\n}}\n"
    ));
    assert_eq!(native(&ir), ["an effect (line 3)"]);
}

#[test]
fn a_ref_names_the_ref() {
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n  const el = useRef(null)\n  return <p ref={{el}}>x</p>\n}}\n"
    ));
    assert_eq!(native(&ir), ["a ref `el` (line 4)"]);
}

#[test]
fn several_causes_keep_the_fixed_order() {
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n  const el = useRef(null)\n  useEffect(() => {{ document.title = 'x' }}, [])\n  const [n, setN] = useState(0)\n  return <button ref={{el}} onClick={{() => setN(n + 1)}}>{{n}}</button>\n}}\n"
    ));
    assert_eq!(
        native(&ir),
        [
            "state `n` is set (line 5)",
            "an event handler (line 6)",
            "an effect (line 4)",
            "a ref `el` (line 6)",
        ]
    );
}

#[test]
fn an_expression_that_depends_on_state() {
    // A value outside the server grammar that reads state: the job computes it with the seeds, the client recomputes it.
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n  const [n, setN] = useState(0)\n  return <button onClick={{() => setN(n + 1)}}>{{[n, n].map((x) => x * 2).join(',')}}</button>\n}}\n"
    ));
    let why = native(&ir);
    // F581: the line of the element that holds the expression.
    assert!(
        why.iter()
            .any(|w| w == "an expression depends on state (line 4)"),
        "{why:?}"
    );
}

#[test]
fn a_prop_linked_to_a_child_names_the_call_site() {
    let ir = analyze_tree(&[
        (
            "C.tsx",
            "import { useState } from 'react'\nimport Child from './Child'\nexport default function C() {\n  const [n, setN] = useState(0)\n  return (\n    <div onClick={() => setN(n + 1)}>\n      <Child n={n} />\n    </div>\n  )\n}\n",
        ),
        (
            "Child.tsx",
            "export default function Child({ n }: { n: number }) {\n  return <b>{n}</b>\n}\n",
        ),
    ]);
    let why = native(&ir);
    assert!(
        why.iter()
            .any(|w| w == "a prop is linked to a child (line 7)"),
        "{why:?}"
    );
}

#[test]
fn a_ref_only_component_has_a_line_for_its_header() {
    // F581: with no state or handler, the first cause with a line is the ref's.
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n\n  const el = useRef(null)\n  return <p ref={{el}}>x</p>\n}}\n"
    ));
    assert_eq!(native(&ir), ["a ref `el` (line 5)"]);
}

#[test]
fn a_store_read_names_the_store_and_its_line() {
    let ir = analyze_tree(&[
        (
            "cart.ts",
            "import { defineStore, signal } from 'brust/store'\nexport const cart = defineStore('cart', () => ({ count: signal(0) }))\n",
        ),
        (
            "C.tsx",
            "import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nexport default function C() {\n  const s = useStore(cart)\n  return <span>{s.count}</span>\n}\n",
        ),
    ]);
    assert_eq!(native(&ir), ["it reads the store `cart` (line 4)"]);
}

#[test]
fn more_than_eight_causes_are_cut_with_a_count() {
    let cells: String = (0..10)
        .map(|i| format!("  const [s{i}, set{i}] = useState({i})\n"))
        .collect();
    let reads: String = (0..10).map(|i| format!("{{s{i}}}")).collect();
    let sets: String = (0..10).map(|i| format!("set{i}(1);")).collect();
    let ir = analyze(&format!(
        "{IMPORTS}export default function C() {{\n{cells}  return <button onClick={{() => {{ {sets} }}}}>{reads}</button>\n}}\n"
    ));
    let why = native(&ir);
    assert_eq!(why.len(), 9, "{why:?}");
    assert_eq!(why[0], "state `s0` is set (line 3)");
    assert_eq!(why[8], "… and 3 more");
}

#[test]
fn static_and_react_components_record_nothing() {
    let st = analyze("export default function C({ a }: any) { return <p>{a}</p> }\n");
    assert!(matches!(st.tier, Tier::Static), "{:?}", st.tier);
    assert!(st.native_because.is_empty());
    assert!(
        !serde_json::to_string(&st)
            .unwrap()
            .contains("native_because")
    );
    // A fixed cell (nothing sets it) keeps a component static.
    let fixed = analyze(&format!(
        "{IMPORTS}export default function C() {{ const [v] = useState(1); return <p>{{v}}</p> }}\n"
    ));
    assert!(matches!(fixed.tier, Tier::Static), "{:?}", fixed.tier);
    assert!(fixed.native_because.is_empty());

    let react = analyze(&format!(
        "{IMPORTS}export default function C() {{\n  const [n, setN] = useState(0)\n  return <button onClick={{() => setN(n + 1)}}>{{window.innerWidth}}</button>\n}}\n"
    ));
    assert!(matches!(react.tier, Tier::React { .. }), "{:?}", react.tier);
    assert!(react.native_because.is_empty());
    assert!(
        !serde_json::to_string(&react)
            .unwrap()
            .contains("native_because")
    );
}

#[test]
fn the_reasons_are_deterministic() {
    let src = format!(
        "{IMPORTS}export default function C() {{\n  const el = useRef(null)\n  const [n, setN] = useState(0)\n  return <button ref={{el}} onClick={{() => setN(n + 1)}}>{{n}}</button>\n}}\n"
    );
    let a = analyze(&src).native_because;
    for _ in 0..3 {
        assert_eq!(analyze(&src).native_because, a);
    }
}
