//! F319 (fail closed): a native component's prop read where a change would not be followed (the rows of a list printed
//! once, a prop of a child it does not link, a key printed once through a spread) is a `frozen` prop. A call site that
//! passes a value that changes on the client for it falls back (`frozen-prop`); a constant passes; one of the caller's
//! own props passes the requirement up. Wrong output on main before (the prop stayed at its first value).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::{ComponentIR, DiagClass, Tier};
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

/// `parent` (the entry, `T.tsx`) with `child` as `./C.tsx` and `mid` as `./M.tsx`.
fn tree(parent: &str, child: &str, mid: &str) -> ComponentIR {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brust-f319-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("C.tsx"), child).unwrap();
    std::fs::write(dir.join("M.tsx"), mid).unwrap();
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

fn rules(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| d.rule.clone())
        .collect()
}

const PARENT: &str = "import { useState } from 'react'\nimport C from './C'\nexport default function T() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><C on={on} /></main> }";
const CONST_PARENT: &str =
    "import C from './C'\nexport default function T() { return <main><C on={true} /></main> }";
const NONE: &str = "export default function Unused() { return null }";

/// A native child (its own state) reading `on` in the given markup.
fn child(body: &str) -> String {
    format!(
        "import {{ useState }} from 'react'\nfunction Thumb({{ on }}: any) {{ return <i data-state={{on ? 'checked' : 'unchecked'}} /> }}\nfunction Fwd(props: any) {{ return <i {{...props}} /> }}\nexport default function C({{ on }}: any) {{ const [n, setN] = useState(0); return <div data-n={{n}} onClick={{() => setN(n + 1)}}>{body}</div> }}"
    )
}

const SHAPES: [&str; 3] = [
    // the rows of a constant list
    "{[1, 2].map((i) => <b key={i}>{on ? i : -i}</b>)}",
    // a prop of a static child it does not link
    "<Thumb on={on} />",
    // a key printed once through a forwarder's spread
    "<Fwd data-state={on ? 'checked' : 'unchecked'} />",
];

#[test]
fn a_live_value_for_a_frozen_prop_falls_back() {
    for body in SHAPES {
        let ir = tree(PARENT, &child(body), NONE);
        assert!(
            rules(&ir).contains(&"frozen-prop".to_string()),
            "{body}: {:?}",
            rules(&ir)
        );
        assert!(
            matches!(ir.tier, Tier::React { .. }),
            "{body}: {:?}",
            ir.tier
        );
    }
}

#[test]
fn a_constant_for_a_frozen_prop_and_a_followed_read_stay_native() {
    for body in SHAPES {
        let ir = tree(CONST_PARENT, &child(body), NONE);
        assert!(
            !rules(&ir).contains(&"frozen-prop".to_string()),
            "{body}: {:?}",
            rules(&ir)
        );
    }
    // A direct read binds (x-text), so the live caller is fine.
    let ir = tree(PARENT, &child("<b>{on ? 'a' : 'b'}</b>"), NONE);
    assert!(rules(&ir).is_empty(), "{:?}", rules(&ir));
    assert!(matches!(ir.tier, Tier::Native), "{:?}", ir.tier);
}

#[test]
fn a_wrapper_passing_its_own_prop_passes_the_requirement_up() {
    // M is native and LINKS C (it also passes its own state `k`), so C follows `on` as a prop; C itself freezes it in
    // its rows, so the requirement must pass up through M's own prop to M's caller.
    let mid = "import { useState } from 'react'\nimport C from './C'\nexport default function M({ on }: any) { const [k, setK] = useState(0); return <section onClick={() => setK(k + 1)}><C on={on} k={k} /></section> }";
    let parent = "import { useState } from 'react'\nimport M from './M'\nexport default function T() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><M on={on} /></main> }";
    let ir = tree(parent, &child(SHAPES[0]), mid);
    assert!(
        rules(&ir).contains(&"frozen-prop".to_string()),
        "{:?}",
        rules(&ir)
    );
}
