//! F288 G9 (Mellow A2): a render-time `r.current = v` lowers to the `useRef` initialiser iff the closed rule holds
//! (one unconditional top-level write, no render read, no escape, `v` built from stable leaves); else `ref-in-render`.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// (tier, fallback rules, client chunk) of `src` compiled as a page.
fn compile(src: &str) -> (Tier, Vec<String>, String) {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "crates/brust-compiler/tests/fixtures/F.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let rules = tree[0]
            .ir
            .diagnostics
            .iter()
            .chain(&tree[0].artifacts.diagnostics)
            .map(|d| d.rule.clone())
            .collect();
        (
            tree[0].ir.tier.clone(),
            rules,
            tree[0].artifacts.client_js.clone().unwrap_or_default(),
        )
    })
}

const HEAD: &str = "import { useCallback, useEffect, useRef, useState } from 'react'\n";

fn page(body: &str) -> String {
    format!(
        "{HEAD}export default function F({{ p }}: any) {{ const [n, setN] = useState(0)\n{body}\nreturn <p onClick={{() => setN(n + 1)}}>{{n}}</p> }}"
    )
}

#[test]
fn a_write_of_stable_leaves_is_the_initialiser() {
    for (body, init) in [
        // a []-deps callback and a setter, read only in an effect (useStableComposedRefs' shape)
        (
            "const cb = useCallback(() => setN(1), []); const r = useRef<any>(null); r.current = [cb, setN]; useEffect(() => { r.current[0]() }, [])",
            "r.current = [cb, n.set]",
        ),
        // a literal and another ref, in an object
        (
            "const o = useRef(0); const r = useRef<any>(null); r.current = { a: 1, o }; useEffect(() => { console.log(r.current.a) }, [])",
            "__ref(\"r\", { a: 1, o: o })",
        ),
        // a callback whose deps are stable leaves
        (
            "const r0 = useRef(0); const cb = useCallback(() => r0.current, [r0]); const r = useRef<any>(null); r.current = cb; const h = useCallback(() => r.current(), []); useEffect(() => { h() }, [])",
            "r.current = cb",
        ),
    ] {
        let (t, rules, chunk) = compile(&page(body));
        assert!(matches!(t, Tier::Native), "{body}\n{t:?} {rules:?}");
        assert!(
            !rules
                .iter()
                .any(|r| r == "ref-in-render" || r == "body-shape"),
            "{body}\n{rules:?}"
        );
        assert!(chunk.contains(init), "{body}\n{chunk}");
    }
}

#[test]
fn every_other_write_is_ref_in_render() {
    for (body, why) in [
        // rule 2: two writes
        (
            "const r = useRef(0); r.current = 1; r.current = 2; useEffect(() => { console.log(r.current) }, [])",
            "twice",
        ),
        // rule 2: read during render
        (
            "const r = useRef(0); r.current = 1; const k = r.current + 1; useEffect(() => { console.log(r.current, k) }, [])",
            "render read",
        ),
        // rule 2: read through a function called during render
        (
            "const r = useRef(0); r.current = 1; const f = useCallback(() => r.current, []); const k = f(); useEffect(() => { console.log(k) }, [])",
            "called in render",
        ),
        // rule 3: passed on as a value
        (
            "const r = useRef<any>(null); r.current = 1; useEffect(() => { console.log(r) }, [])",
            "escapes in an effect",
        ),
        // rule 3: written outside render too
        (
            "const r = useRef(0); r.current = 1; useEffect(() => { r.current = 2 }, [])",
            "written in an effect",
        ),
        // rule 4: state is not stable
        (
            "const r = useRef(0); r.current = n; useEffect(() => { console.log(r.current) }, [])",
            "state",
        ),
        // rule 4: a prop of a component that is no clone is not pinned
        (
            "const r = useRef<any>(null); r.current = p; useEffect(() => { console.log(r.current) }, [])",
            "prop",
        ),
        // rule 4: a callback whose deps change
        (
            "const cb = useCallback(() => n, [n]); const r = useRef<any>(null); r.current = cb; useEffect(() => { r.current() }, [])",
            "changing deps",
        ),
        // rule 4: a callback with no deps argument is a new function every render
        (
            "const cb = useCallback(() => 1); const r = useRef<any>(null); r.current = cb; useEffect(() => { r.current() }, [])",
            "no deps",
        ),
    ] {
        let (t, rules, _) = compile(&page(body));
        assert!(matches!(t, Tier::React { .. }), "{why}: {body}\n{t:?}");
        assert!(
            rules.iter().any(|r| r == "ref-in-render"),
            "{why}: {body}\n{rules:?}"
        );
    }
}

#[test]
fn a_conditional_write_is_never_lowered() {
    let (t, rules, _) = compile(&page(
        "const r = useRef(0); if (n > 1) { r.current = 1 } useEffect(() => { console.log(r.current) }, [])",
    ));
    assert!(matches!(t, Tier::React { .. }), "{t:?} {rules:?}");
}
