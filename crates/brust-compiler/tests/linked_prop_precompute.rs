//! F96d, fail closed: a child that derives values from its props on the server (a callback-bearing
//! expression is a precompute job) cannot be linked to a parent whose state feeds those props.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn analyze_with_child(child: &str) -> (Tier, Vec<(String, DiagClass)>) {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brust-lpp-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Entries.tsx"), child).unwrap();
    let src = "import { useState } from 'react'\nimport Entries from './Entries'\nexport default function T() { const [log, setLog] = useState<any[]>([]); return <div onClick={() => setLog(log.concat([1]))}><Entries log={log} /></div> }";
    let path = dir.join("T.tsx").to_string_lossy().into_owned();
    let ir = run_on_compiler_thread(move || {
        analyze_source(
            &path,
            src.as_bytes().to_vec(),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    });
    let d = ir
        .diagnostics
        .iter()
        .map(|d| (d.rule.clone(), d.class.clone()))
        .collect();
    (ir.tier, d)
}

#[test]
fn callback_derived_values_in_a_linked_child_fall_back() {
    let (tier, d) = analyze_with_child(
        "export default function Entries({ log }: any) { return <ul>{log.filter((l: any) => l.ok).map((l: any) => <li key={l.id}>{l.id}</li>)}</ul> }",
    );
    assert!(matches!(tier, Tier::React { .. }), "{tier:?}");
    assert!(
        d.iter()
            .any(|(r, c)| r == "linked-prop-precompute" && *c == DiagClass::Fallback),
        "{d:?}"
    );
    let (tier, d) = analyze_with_child(
        "export default function Entries({ log }: any) { return <b className={log.some((l: any) => l.ok) ? 'a' : 'b'}>{log.filter((l: any) => l.ok).length}</b> }",
    );
    assert!(matches!(tier, Tier::React { .. }), "{tier:?}");
    assert!(
        d.iter().any(|(r, _)| r == "linked-prop-precompute"),
        "{d:?}"
    );
}

#[test]
fn plain_prop_reads_in_a_linked_child_stay_native() {
    let (tier, d) = analyze_with_child(
        "export default function Entries({ log }: any) { return <ul>{log.map((l: any) => <li key={l}>{l}</li>)}</ul> }",
    );
    assert_eq!(tier, Tier::Native);
    assert!(
        d.iter().all(|(r, _)| r != "linked-prop-precompute"),
        "{d:?}"
    );
}

/// A row-scoped (RowOnly) link in a row the client re-creates: the parent's state feeds the list.
#[test]
fn row_child_with_callback_derived_value_in_a_state_fed_list_falls_back() {
    let dir = std::env::temp_dir().join(format!("brust-lpp-row-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("Item.tsx"),
        "export default function Item({ it }: any) { return <li>{it.tags.filter((t: any) => t.on).length}</li> }",
    )
    .unwrap();
    let src = "import { useState } from 'react'\nimport Item from './Item'\nexport default function T() { const [items, setItems] = useState<any[]>([]); return <ul onClick={() => setItems(items.concat([{ id: 1, tags: [] }]))}>{items.map((it) => <Item key={it.id} it={it} />)}</ul> }";
    let path = dir.join("T.tsx").to_string_lossy().into_owned();
    let ir = run_on_compiler_thread(move || {
        analyze_source(
            &path,
            src.as_bytes().to_vec(),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    });
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
    assert!(
        ir.diagnostics
            .iter()
            .any(|d| d.rule == "linked-prop-precompute")
    );
}

fn analyze_pair(child: &str, parent: &str) -> brust_compiler::ir::ComponentIR {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brust-lpp-pair-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Child.tsx"), child).unwrap();
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

/// F105 step 1: once the parent falls back to React it renders the child itself, so it must not
/// keep the child's instance records (the build would fail `instance-prop-path`) or links.
#[test]
fn a_react_fallback_parent_drops_child_instances_and_links() {
    let child = "export default function Child({ code }: any) { return <pre>{code.split('\\n').filter((l: any) => l.length > 0).length}</pre> }";
    // Shared state: the prop is not a props path.
    let ir = analyze_pair(
        child,
        "import { useState } from 'react'\nimport Child from './Child'\nexport default function T({ src }: any) { const [n, setN] = useState(0); return <div onClick={() => setN(n + 1)}><Child code={src + n} /></div> }",
    );
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
    assert!(
        ir.diagnostics
            .iter()
            .any(|d| d.rule == "linked-prop-precompute"),
        "{:?}",
        ir.diagnostics
    );
    assert!(ir.instances.is_empty(), "{:?}", ir.instances);
    assert!(ir.child_links.is_empty(), "{:?}", ir.child_links);
    // Per row: a state-fed list re-creates the rows.
    let ir = analyze_pair(
        child,
        "import { useState } from 'react'\nimport Child from './Child'\nexport default function T() { const [items, setItems] = useState<any[]>([]); return <ul onClick={() => setItems(items.concat([{ id: 1, code: '' }]))}>{items.map((it) => <Child key={it.id} code={it.code} />)}</ul> }",
    );
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
    assert!(ir.instances.is_empty(), "{:?}", ir.instances);
    assert!(ir.child_links.is_empty(), "{:?}", ir.child_links);
}
