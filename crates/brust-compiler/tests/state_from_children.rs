//! F404: a state whose initial value reads `children` (`const [c] = useState(children); return <div>{c}</div>`)
//! compiled native and printed nothing where React prints the child. It is refused by name, `state-from-children`,
//! so the component falls back to React, whatever way the initial value reaches `children`.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;

/// The full analysis (tier included) of `entry` in a temporary project made of `files`.
fn project(files: &[(&str, &str)], entry: &str) -> ComponentIR {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "brust-state-children-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    for (path, src) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let opts = AnalyzeOptions {
        root: root.clone(),
        ..Default::default()
    };
    let entry = entry.to_string();
    let ir = run_on_compiler_thread(move || analyze_file(&entry, &opts).unwrap());
    std::fs::remove_dir_all(root).ok();
    ir
}

fn one(src: &str) -> ComponentIR {
    project(&[("C.tsx", src)], "C.tsx")
}

fn fallbacks(ir: &ComponentIR) -> Vec<&Diagnostic> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .collect()
}

fn refused(src: &str) {
    let ir = one(src);
    let fb = fallbacks(&ir);
    assert!(
        fb.iter().any(|d| d.rule == "state-from-children"),
        "{src}\n{:?}\n{:?}",
        ir.tier,
        ir.diagnostics
    );
    assert_ne!(ir.tier, Tier::Native, "{src}");
}

fn native(src: &str) {
    let ir = one(src);
    assert!(fallbacks(&ir).is_empty(), "{src}\n{:?}", ir.diagnostics);
    assert_eq!(ir.tier, Tier::Native, "{src}");
}

const HEAD: &str = "import { useState, useReducer } from 'react'\n";

#[test]
fn the_filed_shape_is_refused_by_name_with_its_line() {
    let src = format!(
        "{HEAD}export default function C({{ children }}: any) {{\n  const [c] = useState(children)\n  return <div>{{c}}</div>\n}}\n"
    );
    refused(&src);
    let ir = one(&src);
    let d = fallbacks(&ir)
        .into_iter()
        .find(|d| d.rule == "state-from-children")
        .unwrap();
    assert!(d.message.contains("children"), "{}", d.message);
}

#[test]
fn every_way_the_initial_value_reaches_children_is_refused() {
    let shapes = [
        // through props
        "export default function C(props: any) { const [c] = useState(props.children); return <div>{c}</div> }",
        "export default function C(props: any) { const { children } = props; const [c] = useState(children); return <div>{c}</div> }",
        // a renamed destructured prop
        "export default function C({ children: kids }: any) { const [c] = useState(kids); return <div>{c}</div> }",
        // an expression containing it
        "export default function C({ children }: any) { const [c] = useState(children ?? 'x'); return <div>{c}</div> }",
        "export default function C({ children }: any) { const [c] = useState([children]); return <div>{c}</div> }",
        "export default function C({ children, on }: any) { const [c] = useState(on ? children : null); return <div>{c}</div> }",
        // a lazy initializer
        "export default function C({ children }: any) { const [c] = useState(() => children); return <div>{c}</div> }",
        // through a local
        "export default function C({ children }: any) { const kept = children; const [c] = useState(kept); return <div>{c}</div> }",
        // a state nothing reads back
        "export default function C({ children }: any) { const [c, set] = useState(children); return <button onClick={() => set(null)}>{c}</button> }",
        // the whole props object, or a rest of it that cannot have left `children` out
        "export default function C(props: any) { const [c] = useState(props); return <div>{c.children}</div> }",
        "export default function C({ a, ...rest }: any) { const [c] = useState(rest); return <div>{a}{c.children}</div> }",
        // useReducer's initial state
        "export default function C({ children }: any) { const [c] = useReducer((s: any, a: any) => a, children); return <div>{c}</div> }",
    ];
    for s in shapes {
        refused(&format!("{HEAD}{s}\n"));
    }
}

#[test]
fn a_custom_hook_given_children_as_its_initial_value_is_refused() {
    let hook = "import { useState } from 'react'\nexport function useKept(init: any) { const [v, set] = useState(init); return [v, set] as const }\n";
    let comp = "import { useKept } from './use-kept'\nexport default function C({ children }: any) { const [c] = useKept(children); return <div>{c}</div> }\n";
    let ir = project(&[("use-kept.ts", hook), ("C.tsx", comp)], "C.tsx");
    assert!(
        fallbacks(&ir).iter().any(|d| d.rule == "state-from-children"),
        "{:?}\n{:?}",
        ir.tier,
        ir.diagnostics
    );
    assert_ne!(ir.tier, Tier::Native);
}

#[test]
fn state_that_does_not_read_children_stays_native() {
    for s in [
        // children rendered, state elsewhere
        "export default function C({ children }: any) { const [n, set] = useState(0); return <button onClick={() => set(n + 1)}>{n}{children}</button> }",
        // a prop that is merely named like it
        "export default function C({ childrenCount }: any) { const [n, set] = useState(childrenCount); return <p onClick={() => set(0)}>{n}</p> }",
        // a string with the word in it
        "export default function C() { const [n, set] = useState('children'); return <p onClick={() => set('')}>{n}</p> }",
        // a member called children on something that is not the props
        "export default function C({ node }: any) { const [n, set] = useState(node.children); return <p onClick={() => set(0)}>{n}</p> }",
        // a rest of the props that `children` was taken out of
        "export default function C({ children, ...rest }: any) { const [n, set] = useState(rest.id); return <p id={n} onClick={() => set(0)}>{children}</p> }",
        // the setter's argument is not the initial value
        "export default function C({ children }: any) { const [n, set] = useState(0); return <button onClick={() => set(1)}>{children}{n}</button> }",
    ] {
        native(&format!("{HEAD}{s}\n"));
    }
}
