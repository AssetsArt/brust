//! F71: which row fields the client can read of a list prop (`client_prop_projections`).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::parse::run_on_compiler_thread;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn projections(src: &str) -> BTreeMap<String, Vec<String>> {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "tests/fixtures/reactive-list-rows/T.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
        .client_prop_projections
    })
}

const S: &str = "import { useState } from 'react'\n";

#[test]
fn key_field_is_always_kept() {
    let p = projections(&format!(
        "{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(r.name)}}>{{r.name}}</li>)}}</ul> }}"
    ));
    assert_eq!(p["rows"], ["id", "name"]);
}

#[test]
fn fields_through_handler_template_and_nested_paths() {
    let p = projections(&format!(
        "{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} className={{r.meta.tone}} title={{`${{r.a.b}}-${{r.a.c}}`}} onClick={{() => setK(r.meta.id)}}>{{r.name.trim()}}</li>)}}</ul> }}"
    ));
    assert_eq!(
        p["rows"],
        ["a.b", "a.c", "id", "meta.id", "meta.tone", "name"]
    );
}

#[test]
fn nested_list_keeps_the_inner_field_whole() {
    let p = projections(&format!(
        "{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(''); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(r.id)}}>{{r.tags.map((t: any) => <b key={{t.id}}>{{t.name}}</b>)}}</li>)}}</ul> }}"
    ));
    assert_eq!(p["rows"], ["id", "tags"]);
}

#[test]
fn row_passed_whole_to_a_child_is_whole() {
    // Counter is native, so the link is Always: `_p1 = (r) => ({ n: r })` reads the row whole.
    let p = projections(
        "import { useState } from 'react'\nimport Counter from '../parent-counter/Counter'\nexport default function P({ rows }: any) { const [k, setK] = useState(0); return <ul onClick={() => setK(1)}>{rows.map((r: any) => <Counter key={r.id} n={r} onReset={() => setK(0)} />)}</ul> }",
    );
    assert!(!p.contains_key("rows"), "{p:?}");
}

#[test]
fn helper_call_dynamic_index_and_bare_item_are_whole() {
    for src in [
        "import { useState } from 'react'\nimport { fmt } from '../keyed-list-child-job/money'\nexport default function P({ rows }: any) { const [k, setK] = useState(''); return <ul>{rows.map((r: any) => <li key={r.id} onClick={() => setK(fmt(r, 'x'))}>{r.name}</li>)}</ul> }",
        "import { useState } from 'react'\nexport default function P({ rows, f }: any) { const [k, setK] = useState(''); return <ul>{rows.map((r: any) => <li key={r.id} onClick={() => setK(r[f])}>{r.name}</li>)}</ul> }",
        "import { useState } from 'react'\nexport default function P({ rows }: any) { const [k, setK] = useState(null); return <ul>{rows.map((r: any) => <li key={r.id} onClick={() => setK(r)}>{r.name}</li>)}</ul> }",
    ] {
        let p = projections(src);
        assert!(!p.contains_key("rows"), "{src}\n{p:?}");
    }
}

#[test]
fn a_non_list_client_read_of_the_root_disables_projection() {
    let p = projections(&format!(
        "{S}export default function P({{ rows }}: any) {{ const [k, setK] = useState(0); return <ul>{{rows.map((r: any) => <li key={{r.id}} onClick={{() => setK(rows.length)}}>{{r.name}}</li>)}}</ul> }}"
    ));
    assert!(!p.contains_key("rows"), "{p:?}");
}

#[test]
fn a_static_list_has_no_projection() {
    let p = projections(
        "export default function P({ rows }: any) { return <ul>{rows.map((r: any) => <li key={r.id}>{r.name}</li>)}</ul> }",
    );
    assert!(p.is_empty(), "{p:?}");
}
