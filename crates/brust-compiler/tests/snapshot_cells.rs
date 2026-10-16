//! F277: a state cell nothing sets (a B4 never-written ref, `const [x] = useState(init)`) is its first-render value for
//! good. Reading it is not reactive; a parent's changing prop that the child reads only for such a cell's first value
//! links nothing; a live style object reaching a child's element binds as an object style (`Object.assign({}, …)` is
//! in the template subset), with no precompute job to go stale.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::{ComponentIR, DiagClass, Tier};
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

/// `parent` (the entry, `T.tsx`) with `child` as `./C.tsx`.
fn tree(parent: &str, child: &str) -> ComponentIR {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brust-f277-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("C.tsx"), child).unwrap();
    let path = dir.join("T.tsx").to_string_lossy().into_owned();
    let src = parent.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            &path,
            src.into_bytes(),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn fallbacks(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| format!("{}: {}", d.rule, d.message))
        .collect()
}

/// A parent whose state `on` (and `w`) feeds `<C {props}/>`.
fn with_state(props: &str) -> String {
    format!(
        "import {{ useState }} from 'react'\nimport C from './C'\nexport default function T() {{ const [on, setOn] = useState(true); const [w, setW] = useState(10); return <div><button onClick={{() => {{ setOn(!on); setW(w + 1) }}}}>t</button><C {props} /></div> }}"
    )
}

const BUBBLE: &str = "import { useRef } from 'react'\nexport default function C({ checked, defaultChecked }: any) { const snap = useRef(checked); return <input type=\"checkbox\" defaultChecked={defaultChecked ?? snap.current} /> }";

#[test]
fn a_cell_nothing_sets_does_not_make_a_component_native() {
    for child in [
        BUBBLE,
        "import { useState } from 'react'\nexport default function C({ checked }: any) { const [first] = useState(checked); return <b>{first ? 'y' : 'n'}</b> }",
    ] {
        // The child compiled as the entry.
        let ir = tree(child, "export default function Unused() { return null }");
        assert!(fallbacks(&ir).is_empty(), "{:?}", fallbacks(&ir));
        assert!(matches!(ir.tier, Tier::Static), "{child}: {:?}", ir.tier);
        assert!(
            ir.state.iter().all(|s| s.setter.is_none()) && !ir.state.is_empty(),
            "{:?}",
            ir.state
        );
    }
}

#[test]
fn a_changing_prop_read_only_for_a_fixed_cell_links_nothing() {
    for child in [
        BUBBLE,
        // A native child (state of its own): `first` keeps the first `checked`.
        "import { useState } from 'react'\nexport default function C({ checked }: any) { const [first] = useState(checked); const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{first ? 'y' : 'n'}{n}</button> }",
    ] {
        let ir = tree(&with_state("checked={on}"), child);
        assert!(fallbacks(&ir).is_empty(), "{:?}", fallbacks(&ir));
        assert!(ir.child_links.is_empty(), "{child}: {:?}", ir.child_links);
    }
}

/// Fail closed: the child reads the prop elsewhere too.
#[test]
fn a_prop_read_anywhere_else_keeps_the_link() {
    for child in [
        // read in the template too
        "import { useState } from 'react'\nexport default function C({ checked }: any) { const [first] = useState(checked); return <span data-a={first ? 'y' : 'n'} data-b={checked ? 'y' : 'n'} /> }",
        // read by a cell something sets
        "import { useState } from 'react'\nexport default function C({ checked }: any) { const [first] = useState(checked); const [v, setV] = useState(checked); return <button onClick={() => setV(!v)} data-a={first ? 'y' : 'n'}>{v ? 'y' : 'n'}</button> }",
        // read in a handler
        "import { useState } from 'react'\nexport default function C({ checked }: any) { const [first] = useState(checked); const [n, setN] = useState(0); return <button onClick={() => setN(checked ? n + 1 : n)}>{first ? 'y' : 'n'}{n}</button> }",
        // the whole props object
        "import { useState } from 'react'\nexport default function C(props: any) { const [first] = useState(props.checked); return <span {...props} data-a={first ? 'y' : 'n'} /> }",
    ] {
        let ir = tree(&with_state("checked={on}"), child);
        // Linked, or React (a spread of the whole props: `spread-props`); never a child left behind.
        assert!(
            !ir.child_links.is_empty() || matches!(ir.tier, Tier::React { .. }),
            "{child}: no link, {:?}",
            fallbacks(&ir)
        );
    }
}

#[test]
fn a_live_style_object_on_a_child_element_binds_as_an_object() {
    for child in [
        "export default function C({ style, ...props }: any) { return <input type=\"checkbox\" {...props} tabIndex={-1} style={{ ...style, position: 'absolute', opacity: 0 }} /> }",
        "export default function C({ size }: any) { return <i style={{ ...size, margin: 0 }} /> }",
    ] {
        let props = if child.contains("size") {
            "size={{ width: w }}"
        } else {
            "name=\"a\" style={{ width: w }}"
        };
        let ir = tree(&with_state(props), child);
        assert!(fallbacks(&ir).is_empty(), "{child}: {:?}", fallbacks(&ir));
        assert!(matches!(ir.tier, Tier::Native), "{:?}", ir.tier);
        assert_eq!(ir.child_links.len(), 1, "{child}");
        assert!(
            ir.jobs.is_empty(),
            "{child}: a job would be computed once: {:?}",
            ir.jobs
        );
    }
}
