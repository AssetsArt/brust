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
fn a_cell_nothing_sets_with_the_same_value_at_every_mount_is_not_reactive() {
    for child in [
        "import { useRef, useState } from 'react'\nconst HUGE = 1 / 0\nexport default function C() { const [h] = useState(HUGE); const r = useRef(3); return <b data-r={r.current}>{h}</b> }",
        "import { useState } from 'react'\nexport default function C() { const [first] = useState(() => 'x'.toUpperCase()); return <b>{first}</b> }",
    ] {
        // The child compiled as the entry.
        let ir = tree(child, "export default function Unused() { return null }");
        assert!(fallbacks(&ir).is_empty(), "{child}: {:?}", fallbacks(&ir));
        assert!(matches!(ir.tier, Tier::Static), "{child}: {:?}", ir.tier);
    }
}

/// Mellow F1: a cell seeded from a prop is re-read when the instance mounts again (an `x-if`, a row), so it stays state.
#[test]
fn a_cell_seeded_from_a_prop_stays_state() {
    for child in [
        BUBBLE,
        "import { useState } from 'react'\nexport default function C({ label }: any) { const [initial] = useState(label); return <p>{initial}</p> }",
    ] {
        let ir = tree(child, "export default function Unused() { return null }");
        assert!(fallbacks(&ir).is_empty(), "{:?}", fallbacks(&ir));
        assert!(matches!(ir.tier, Tier::Native), "{child}: {:?}", ir.tier);
    }
}

#[test]
fn a_changing_prop_read_only_for_a_fixed_cell_links_nothing_where_the_child_mounts_once() {
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

/// Mellow F1: an instance that may mount after first paint reads the CURRENT prop: it stays linked.
#[test]
fn a_child_that_may_mount_later_stays_linked() {
    for (parent, label) in [
        (
            "import { useState } from 'react'\nimport C from './C'\nexport default function T() { const [on, setOn] = useState(true); const [open, setOpen] = useState(false); return <div><button onClick={() => { setOn(!on); setOpen(!open) }}>t</button>{open && <C checked={on} />}</div> }",
            "under a condition",
        ),
        (
            "import { useState } from 'react'\nimport C from './C'\nexport default function T() { const [on, setOn] = useState(true); const [xs, setXs] = useState([1]); return <div><button onClick={() => { setOn(!on); setXs(xs.concat([1])) }}>t</button>{xs.map((x) => <C key={x} checked={on} />)}</div> }",
            "in a row",
        ),
        (
            "import { useState } from 'react'\nimport C from './C'\nfunction Box({ children }: any) { return <section>{children}</section> }\nexport default function T() { const [on, setOn] = useState(true); return <div><button onClick={() => setOn(!on)}>t</button><Box><C checked={on} /></Box></div> }",
            "in slot content",
        ),
    ] {
        let ir = tree(parent, BUBBLE);
        assert!(
            !ir.child_links.is_empty(),
            "{label}: no link, {:?}",
            fallbacks(&ir)
        );
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

#[test]
fn a_cell_seeded_from_a_fixed_cell_is_fixed_but_one_seeded_from_live_state_is_not() {
    // F293: `first` reads `n`, which nothing sets either: both are their first value for good.
    let ir = tree(
        "import { useState } from 'react'\nexport default function C() { const [n] = useState(2); const [first] = useState(n * 3); const [again] = useState(first); return <b data-x={again}>{first}</b> }",
        "export default function Unused() { return null }",
    );
    assert!(fallbacks(&ir).is_empty(), "{:?}", fallbacks(&ir));
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.tier);
    // A seed a setter writes is state: the cell seeded from it stays state too (it is that state's value at a mount).
    let ir = tree(
        "import { useState } from 'react'\nexport default function C() { const [n, setN] = useState(2); const [first] = useState(n); return <b onClick={() => setN(n + 1)}>{first}</b> }",
        "export default function Unused() { return null }",
    );
    assert!(matches!(ir.tier, Tier::Native), "{:?}", ir.tier);
}

/// A child that takes `checked` once (a never-written ref) and hands it to a forwarding primitive, which spreads it.
const FWD_BUBBLE: &str = "import { useRef } from 'react'\nfunction Fwd(props: any) { return <input type=\"checkbox\" {...props} /> }\nexport default function C({ checked }: any) { const snap = useRef(checked); return <Fwd aria-hidden defaultChecked={snap.current} /> }";

fn rules(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| d.rule.clone())
        .collect()
}

#[test]
fn a_snapshot_through_a_forwarding_spread_is_bound_at_mount_wherever_the_instance_sits() {
    // F300: the child binds the snapshot on the forwarded element at mount (`x-bind-checked`, a computed over a cell
    // nothing sets, evaluated once) instead of promising its callers a single mount.
    let child = tree(
        FWD_BUBBLE,
        "export default function Unused() { return null }",
    );
    assert!(fallbacks(&child).is_empty(), "{:?}", fallbacks(&child));
    assert!(
        child.mount_once.is_none(),
        "no promise is asked of the callers"
    );
    assert!(
        child
            .live_forwards
            .iter()
            .any(|f| f.key == "defaultChecked"),
        "{:?}",
        child.live_forwards
    );
    // Mounted with a stateful parent, under a condition or in a row: the same, native, no refusal.
    for site in [
        "<C checked={on} />",
        // A guarded instance can mount again later: it takes the value current then.
        "{w > 10 && <C checked={on} />}",
        // A row.
        "{[1, 2].map((i) => <C key={i} checked={on} />)}",
    ] {
        let parent = format!(
            "import {{ useState }} from 'react'\nimport C from './C'\nexport default function T() {{ const [on, setOn] = useState(true); const [w, setW] = useState(10); return <div><button onClick={{() => {{ setOn(!on); setW(w + 1) }}}}>t</button>{site}</div> }}"
        );
        let ir = tree(&parent, FWD_BUBBLE);
        assert!(fallbacks(&ir).is_empty(), "{site}: {:?}", fallbacks(&ir));
        assert!(matches!(ir.tier, Tier::Native), "{site}: {:?}", ir.tier);
        assert!(ir.mount_once.is_none(), "{site}");
    }
}

#[test]
fn a_seed_a_setter_writes_still_refuses_the_spread() {
    // Not a snapshot: the cell changes after mount, so the spread cannot carry it.
    let child = "import { useState } from 'react'\nfunction Fwd(props: any) { return <input type=\"checkbox\" {...props} /> }\nexport default function C({ checked }: any) { const [c, setC] = useState(checked); return <span onClick={() => setC(!c)}><Fwd defaultChecked={c} /></span> }";
    let ir = tree(child, "export default function Unused() { return null }");
    assert!(
        rules(&ir).contains(&"spread-props".to_string()),
        "{:?}",
        fallbacks(&ir)
    );
    assert!(ir.mount_once.is_none());
}

#[test]
fn a_snapshot_does_not_link_the_forwarder_so_a_handler_can_be_bound_through_its_spread() {
    // Radix's BubbleInput: a composed onClick next to the snapshot. A linked forwarder could not take the handler.
    let child = "import { useRef } from 'react'\nfunction Fwd(props: any) { return <input type=\"checkbox\" {...props} /> }\nexport default function C({ checked }: any) { const snap = useRef(checked); return <Fwd aria-hidden defaultChecked={snap.current} onClick={(e: any) => e.stopPropagation()} /> }";
    let ir = tree(&with_state("checked={on}"), child);
    assert!(fallbacks(&ir).is_empty(), "{:?}", fallbacks(&ir));
    assert!(matches!(ir.tier, Tier::Native), "{:?}", ir.tier);
}
