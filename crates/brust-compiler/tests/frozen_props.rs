//! F319 (fail closed): a native component's prop read where a change would not be followed (the rows of a list printed
//! once, a prop of a child it does not link, a key printed once through a spread) is a `frozen` prop. A call site that
//! passes a value that changes on the client for it falls back (`frozen-prop`); a constant passes; one of the caller's
//! own props passes the requirement up. Wrong output on main before (the prop stayed at its first value).
//! F320: a component with an instance (state, effects, handlers, refs) follows a changing named prop instead, so only a
//! stateless component and a rest / whole-props read stay frozen (F323).
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

/// The same child without an instance (F323: a stateless component's props change only where a caller links it, which
/// its compile cannot know, so F319's freeze still answers for it).
fn static_child(body: &str) -> String {
    format!(
        "function Thumb({{ on }}: any) {{ return <i data-state={{on ? 'checked' : 'unchecked'}} /> }}\nfunction Fwd(props: any) {{ return <i {{...props}} /> }}\nexport default function C({{ on }}: any) {{ return <div>{body}</div> }}"
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

/// F320: a child with an instance follows a changing named prop in every shape: rows get x-for, the static child is
/// linked, the forwarder's key is bound. Nothing is frozen, the page stays native (served == React:
/// tests/server/frozen-prop.chromium.test.ts chain, more, prov).
#[test]
fn a_child_with_an_instance_follows_a_changing_prop() {
    for body in SHAPES {
        let ir = tree(PARENT, &child(body), NONE);
        assert!(rules(&ir).is_empty(), "{body}: {:?}", rules(&ir));
        assert!(matches!(ir.tier, Tier::Native), "{body}: {:?}", ir.tier);
    }
}

#[test]
fn a_live_value_for_a_frozen_prop_falls_back() {
    for body in SHAPES {
        let ir = tree(PARENT, &static_child(body), NONE);
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
        let ir = tree(CONST_PARENT, &static_child(body), NONE);
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
    // M is native and LINKS C (it also passes its own state `k`), so C follows `on` as a prop; C (stateless) freezes it in
    // its rows, so the requirement must pass up through M's own prop to M's caller.
    let mid = "import { useState } from 'react'\nimport C from './C'\nexport default function M({ on }: any) { const [k, setK] = useState(0); return <section onClick={() => setK(k + 1)}><C on={on} k={k} /></section> }";
    let parent = "import { useState } from 'react'\nimport M from './M'\nexport default function T() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><M on={on} /></main> }";
    let ir = tree(parent, &static_child(SHAPES[0]), mid);
    assert!(
        rules(&ir).contains(&"frozen-prop".to_string()),
        "{:?}",
        rules(&ir)
    );
}

/// Mellow F1: a native child that hands its rest (or its whole props object) to a static child it does not link prints
/// every key that lands there once. A live value for such a key refuses; a constant passes; a key the child names (not
/// in its rest) is not frozen by the rest.
#[test]
fn a_live_value_landing_in_a_frozen_rest_falls_back() {
    let thumb =
        "function Thumb({ on }: any) { return <i data-state={on ? 'checked' : 'unchecked'} /> }";
    let rest = format!(
        "import {{ useState }} from 'react'\n{thumb}\nexport default function C({{ x, ...rest }}: any) {{ const [n, setN] = useState(0); return <div data-n={{n}} data-x={{x}} onClick={{() => setN(n + 1)}}><Thumb {{...rest}} /></div> }}"
    );
    let whole = format!(
        "import {{ useState }} from 'react'\n{thumb}\nexport default function C(props: any) {{ const [n, setN] = useState(0); return <div data-n={{n}} onClick={{() => setN(n + 1)}}><Thumb {{...props}} /></div> }}"
    );
    for c in [&rest, &whole] {
        let ir = tree(PARENT, c, NONE);
        assert!(
            rules(&ir).contains(&"frozen-prop".to_string()),
            "{c}: {:?}",
            rules(&ir)
        );
        assert!(matches!(ir.tier, Tier::React { .. }), "{c}: {:?}", ir.tier);
        let ir = tree(CONST_PARENT, c, NONE);
        assert!(
            !rules(&ir).contains(&"frozen-prop".to_string()),
            "{c}: {:?}",
            rules(&ir)
        );
    }
    // `x` is named, so it does not land in the rest: a live `x` binds (data-x) and does not refuse.
    let parent_x = "import { useState } from 'react'\nimport C from './C'\nexport default function T() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><C x={on} /></main> }";
    let ir = tree(parent_x, &rest, NONE);
    assert!(
        !rules(&ir).contains(&"frozen-prop".to_string()),
        "{:?}",
        rules(&ir)
    );
}

/// Mellow F1 / Afrojack, pass-up and call-site spreads: a wrapper passing its own prop into a child's frozen rest passes
/// the requirement up; a live object spread at the call site refuses whether the child names the frozen key or takes it
/// in its rest.
#[test]
fn a_rest_key_passes_up_and_a_live_spread_falls_back() {
    let rest_child = "import { useState } from 'react'\nfunction Thumb({ on }: any) { return <i data-state={on ? 'checked' : 'unchecked'} /> }\nexport default function C({ x, ...rest }: any) { const [n, setN] = useState(0); return <div data-n={n} onClick={() => setN(n + 1)}><Thumb {...rest} /></div> }";
    let parent = "import { useState } from 'react'\nimport M from './M'\nexport default function T() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><M on={on} /></main> }";
    let mid = "import { useState } from 'react'\nimport C from './C'\nexport default function M({ on }: any) { const [j, setJ] = useState(0); return <section onClick={() => setJ(j + 1)}><C on={on} x={j} /></section> }";
    let ir = tree(parent, rest_child, mid);
    assert!(
        rules(&ir).contains(&"frozen-prop".to_string()),
        "{:?}",
        rules(&ir)
    );
    let spread = "import { useState } from 'react'\nimport C from './C'\nexport default function T() { const [o, setO] = useState({ on: false }); return <main><button onClick={() => setO({ on: !o.on })}>f</button><C {...o} /></main> }";
    for c in [rest_child, &static_child(SHAPES[0])] {
        let ir = tree(spread, c, NONE);
        assert!(
            rules(&ir).contains(&"frozen-prop".to_string()),
            "{c}: {:?}",
            rules(&ir)
        );
    }
}

/// Afrojack, call-site spreads: a wrapper forwarding its props or its rest by a spread into a child that freezes a key
/// leaves no stale native page: a stateful wrapper linking the child that way is an island (`island-prop`), a static one
/// refuses (`spread-props`, and `frozen-prop` through the spread).
#[test]
fn a_key_forwarded_by_a_wrapper_spread_never_stays_native() {
    let parent = "import { useState } from 'react'\nimport M from './M'\nexport default function T() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><M on={on} /></main> }";
    for mid in [
        "import { useState } from 'react'\nimport C from './C'\nexport default function M(props: any) { const [j, setJ] = useState(0); return <section onClick={() => setJ(j + 1)}><C {...props} k={j} /></section> }",
        "import { useState } from 'react'\nimport C from './C'\nexport default function M({ q, ...rest }: any) { const [j, setJ] = useState(0); return <section onClick={() => setJ(j + 1)}><C {...rest} k={j} /></section> }",
        "import C from './C'\nexport default function M(props: any) { return <section><C {...props} /></section> }",
    ] {
        let ir = tree(parent, &child(SHAPES[0]), mid);
        assert!(
            matches!(ir.tier, Tier::React { .. }),
            "{mid}: {:?}",
            ir.tier
        );
    }
}

/// F320 x shadcn S1.3: a child with an instance hands a named prop and a handler to a forwarder's spread (Radix's
/// BubbleInput into Primitive.input). Linking the forwarder for the prop alone would unbind the handler
/// (spread-handler), so that link gives way: the forwarder stays unlinked and F319's freeze answers per call site.
#[test]
fn a_handler_in_a_forwarders_spread_keeps_the_freeze_instead_of_a_link() {
    let c = "import { useRef } from 'react'\nfunction Fwd(props: any) { return <input type=\"checkbox\" {...props} /> }\nexport default function C({ on }: any) { const snap = useRef(on); return <Fwd data-testid={on ? 'a' : 'b'} tabIndex={-1} defaultChecked={snap.current} onClick={(e: any) => e.stopPropagation()} /> }";
    let ir = tree(CONST_PARENT, c, NONE);
    assert!(rules(&ir).is_empty(), "{:?}", rules(&ir));
    // F300 forwards that snapshot (`defaultChecked`, unchanged after mount) and binds the live `data-testid` on the
    // parent's element: nothing is left for a link, so the live caller follows natively.
    let ir = tree(PARENT, c, NONE);
    assert!(rules(&ir).is_empty(), "{:?}", rules(&ir));
    // A live key no forward takes (`value`): the hold keeps the forwarder unlinked and the freeze answers.
    let c = c.replace("defaultChecked={snap.current}", "value={on ? 'x' : 'y'}");
    let ir = tree(CONST_PARENT, &c, NONE);
    assert!(rules(&ir).is_empty(), "{:?}", rules(&ir));
    // Without the hold the forwarder would be linked while its handler is bound on its element, which needs an
    // unlinked instance (forward_handlers): refused here instead.
    let ir = tree(PARENT, &c, NONE);
    assert_eq!(rules(&ir), vec!["frozen-prop".to_string()]);
}
