//! M1c Task 6: the directive chunk.
mod lower_common;
use lower_common::{bun, fixture_artifacts, lower};

const STATE: &str = "import { useState, useEffect, useCallback, useRef } from 'react'\n";

/// F23 and spec §7.1: a block handler sees current state, the setter as
/// `.set`, and a renamed prop under its local name.
#[test]
fn block_sources_bind_their_captures() {
    let c = lower(&format!(
        "{STATE}export default function T({{ title: heading }}: any) {{ const [n, setN] = useState(0); return <button onClick={{() => {{ const x = n + heading.length; setN(x) }}}}>{{n}}</button> }}"
    ))
    .client_js
    .unwrap();
    assert!(c.contains("((n, heading, setN) => ("), "{c}");
    assert!(c.contains("))(n(), props().title, n.set))(...a)"), "{c}");
}

#[test]
fn effects_refs_and_use_callback() {
    let c = lower(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(0); const r = useRef(null); const inc = useCallback(() => setN(n + 1), [n]); useEffect(() => {{ const id = setInterval(inc, 1000); return () => clearInterval(id) }}, [inc]); return <button ref={{r}} onClick={{inc}}>{{n}}</button> }}"
    ))
    .client_js
    .unwrap();
    assert!(c.contains("  const r = ref(\"r\")\n"), "{c}");
    assert!(
        c.contains("const inc = (...a) => (() => n.set(n() + 1))(...a)"),
        "{c}"
    );
    assert!(c.contains("effect(() => ("), "{c}");
    assert!(c.contains("return { n, inc, _c1 }"), "{c}");
}

/// Spec §11 react-freedom, and every chunk parses (bun build --no-bundle).
#[test]
fn chunks_are_react_free_and_parse() {
    let dir = std::env::temp_dir().join(format!("brustc-chunks-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut n = 0;
    for (name, a) in fixture_artifacts() {
        let Some(c) = a.client_js else { continue };
        n += 1;
        assert!(
            !c.contains("from \"react") && !c.contains("from 'react"),
            "{name} imports react\n{c}"
        );
        let file = dir.join(format!("{n}.js"));
        std::fs::write(&file, &c).unwrap();
        let Some(bun) = bun() else {
            eprintln!("warning: bun not on PATH; skipping the chunk syntax check");
            continue;
        };
        let out = std::process::Command::new(bun)
            .args(["build", "--no-bundle"])
            .arg(&file)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{name}: chunk does not parse\n{}\n{c}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    assert!(n >= 5);
}
