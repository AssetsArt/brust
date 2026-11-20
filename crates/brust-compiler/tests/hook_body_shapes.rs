//! F578: three shapes that made a component a React island: destructuring in the component body (D1), a custom hook a
//! module only re-exports (D2), and a plain hook parameter with a default (D3).
mod lower_common;
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::{ComponentIR, DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use lower_common::lower;
use std::path::PathBuf;

fn write_tree(files: &[(&str, &str)]) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("brustc-f578-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, text) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    root
}

/// The IR of `C.tsx` in a tree of files.
fn analyze_tree(files: &[(&str, &str)]) -> ComponentIR {
    let root = write_tree(files);
    let src = files
        .iter()
        .find(|(p, _)| *p == "C.tsx")
        .expect("C.tsx")
        .1
        .to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "C.tsx",
            src.into_bytes(),
            &AnalyzeOptions {
                root,
                ..Default::default()
            },
        )
        .unwrap()
    })
}

/// (jinja, job, chunk) of `C.tsx` in a tree of files.
fn lower_tree(files: &[(&str, &str)]) -> (String, String, String) {
    let root = write_tree(files);
    run_on_compiler_thread(move || {
        let out = compile_tree(
            "C.tsx",
            None,
            &AnalyzeOptions {
                root,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .remove(0)
        .artifacts;
        (
            out.jinja,
            out.server_ts.unwrap_or_default(),
            out.client_js.unwrap_or_default(),
        )
    })
}

fn ir(src: &str) -> ComponentIR {
    analyze_tree(&[("C.tsx", src), ("money.ts", MONEY)])
}

const MONEY: &str = "export const greeting = (h: number) => [h > 12 ? 'pm' : 'am', 'x', `${h}h`]\nexport const split = (s: string, n: number) => ({ a: s.slice(0, n), b: s.slice(n) })\n";

fn fallbacks(ir: &ComponentIR) -> Vec<(String, String)> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| (d.rule.clone(), d.message.clone()))
        .collect()
}

#[track_caller]
fn accepted(ir: &ComponentIR, tier: Tier) {
    assert!(
        fallbacks(ir).is_empty() && ir.tier == tier,
        "{:?}\n{:?}",
        ir.tier,
        ir.diagnostics
    );
}

#[track_caller]
fn refused(ir: &ComponentIR, rule: &str, why: &str) {
    let f = fallbacks(ir);
    assert!(
        f.iter().any(|(r, m)| r == rule && m.contains(why)),
        "want {rule}: `{why}` in {f:?}"
    );
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
}

// ---- D1: destructuring in the component body ----

#[test]
fn a_flat_pattern_over_a_prop_path_reads_the_path() {
    let src = "export default function C({ ask, o }: any) { const { kind, m: msg } = ask; const [first, , third] = o.build; return <p title={kind}>{msg}{first}{third}</p> }";
    accepted(&ir(src), Tier::Static);
    let j = lower(src).jinja;
    assert!(j.contains("title=\"{{ ask.kind | attr_str | e }}\""), "{j}");
    assert!(
        j.contains("{{ ask.m | e }}{{ o.build[0] | e }}{{ o.build[2] | e }}"),
        "{j}"
    );
}

#[test]
fn a_pattern_over_a_call_is_one_derived_value() {
    let src = "import { greeting } from './money'\nexport default function C({ h }: any) { const [th, , en] = greeting(h); return <p title={th}>{en}</p> }";
    accepted(&ir(src), Tier::Static);
    let (j, job, _) = lower_tree(&[("C.tsx", src), ("money.ts", MONEY)]);
    assert!(job.contains("const _pat1 = greeting(h)"), "{job}");
    assert_eq!(job.matches("greeting(").count(), 1, "one call: {job}");
    assert!(j.contains("{{ _d1[2] | e }}"), "{j}");
}

#[test]
fn destructured_names_read_in_state_markup_handlers_and_derived_values() {
    let src = "import { useState } from 'react'\nimport { split } from './money'\nexport default function C({ s, o }: any) { const [n, setN] = useState(1); const { a, b } = split(s, n); const { minutes: used } = o.build; const total = a.length + used; return <button title={b} onClick={() => { setN(total + used + a.length) }}>{a}|{total}</button> }";
    accepted(&ir(src), Tier::Native);
    let (_, _, c) = lower_tree(&[("C.tsx", src), ("money.ts", MONEY)]);
    assert!(
        c.contains("const _pat1 = computed(() => split(props().s, n()))"),
        "{c}"
    );
    // the handler (printed as written) reads the derived value and the prop path
    assert!(
        !c.contains("used +") && !c.contains(" a.length"),
        "a bound name leaked into the chunk: {c}"
    );
}

#[test]
fn unsupported_body_patterns_say_which() {
    for (src, why) in [
        (
            "export default function C({ o }: any) { const { a = 1 } = o; return <p>{a}</p> }",
            "with a default value",
        ),
        (
            "export default function C({ o }: any) { const { a: { b } } = o; return <p>{b}</p> }",
            "with a nested pattern",
        ),
        (
            "export default function C({ o }: any) { const { a, ...r } = o; return <p>{a}{r.b}</p> }",
            "with a rest element",
        ),
        (
            "export default function C({ o, k }: any) { const { [k]: a } = o; return <p>{a}</p> }",
            "with a computed key",
        ),
    ] {
        refused(&ir(src), "body-shape", why);
    }
}

#[test]
fn a_destructured_name_a_nested_scope_would_capture_refuses() {
    refused(
        &ir(
            "export default function C({ o }: any) { const { t } = o; return <ul>{o.xs.map((o: any) => <li key={o}>{t}</li>)}</ul> }",
        ),
        "body-shape",
        "the destructured const `t` is read inside a nested list whose `o` hides the `o` its value reads",
    );
    refused(
        &ir(
            "import { useState } from 'react'\nexport default function C({ o }: any) { const [n, setN] = useState(0); const { t } = o; return <button onClick={() => { const o = 1; setN(t + o + n) }}>{n}</button> }",
        ),
        "body-shape",
        "the destructured const `t` is read in code that declares `o`",
    );
}

// ---- D2: a re-exported custom hook ----

const USE_LABEL: &str = "export function useLabel(x: string) { return x + '!' }\n";

fn hook_through(files: &[(&str, &str)], import_from: &str) -> ComponentIR {
    let c = format!(
        "import {{ useLabel }} from '{import_from}'\nexport default function C({{ t }}: any) {{ const l = useLabel(t); return <p>{{l}}</p> }}"
    );
    let mut all: Vec<(&str, &str)> = files.to_vec();
    all.push(("C.tsx", &c));
    analyze_tree(&all)
}

#[test]
fn a_hook_reached_through_a_re_export_is_inlined() {
    for files in [
        vec![
            ("lib/l.ts", USE_LABEL),
            ("lib/index.ts", "export { useLabel } from './l'\n"),
        ],
        vec![
            ("lib/l.ts", USE_LABEL),
            (
                "lib/index.ts",
                "import { useLabel } from './l'\nexport { useLabel }\n",
            ),
        ],
        vec![
            ("lib/l.ts", USE_LABEL),
            ("lib/index.ts", "export * from './l'\n"),
        ],
        vec![
            (
                "lib/l.ts",
                "export function useL(x: string) { return x + '!' }\n",
            ),
            ("lib/index.ts", "export { useL as useLabel } from './l'\n"),
        ],
        vec![
            (
                "lib/l.ts",
                "export function useL(x: string) { return x + '!' }\n",
            ),
            (
                "lib/index.ts",
                "import { useL } from './l'\nexport { useL as useLabel }\n",
            ),
        ],
        // two hops
        vec![
            ("lib/l.ts", USE_LABEL),
            ("lib/mid.ts", "export * from './l'\n"),
            ("lib/index.ts", "export { useLabel } from './mid'\n"),
        ],
    ] {
        accepted(&hook_through(&files, "./lib"), Tier::Static);
    }
}

#[test]
fn a_re_export_cycle_or_miss_names_the_last_module() {
    let ir = hook_through(
        &[
            ("lib/index.ts", "export * from './a'\n"),
            ("lib/a.ts", "export * from './index'\n"),
        ],
        "./lib",
    );
    refused(
        &ir,
        "hook-unsupported",
        "exports no function declaration `useLabel`",
    );
    let ir = hook_through(
        &[("lib/index.ts", "export { useLabel } from './gone'\n")],
        "./lib",
    );
    refused(
        &ir,
        "hook-unsupported",
        "lib/index.ts exports no function declaration `useLabel`",
    );
}

#[test]
fn a_re_exported_hooks_helper_is_imported_from_its_declaring_module() {
    // B2: a function the hook's module exports is imported by the component; through a barrel that does not re-export
    // it, it must come from the module that declares the hook.
    let files = [
        (
            "lib/l.ts",
            // `fmt` reads a module const: not carried as a plain helper but imported (B2)
            "const MARK = '!'\nexport function fmt(x: string) { return x + MARK }\nexport function useLabel(x: string) { const f = () => fmt(x); return f }\n",
        ),
        ("lib/index.ts", "export { useLabel } from './l'\n"),
        (
            "C.tsx",
            "import { useState } from 'react'\nimport { useLabel } from './lib'\nexport default function C({ t }: any) { const [n, setN] = useState(0); const f = useLabel(t); return <button onClick={() => setN(f().length + n)}>{n}</button> }",
        ),
    ];
    let (_, _, c) = lower_tree(&files);
    assert!(c.contains("from \"./lib/l\""), "{c}");
    assert!(!c.contains("from \"./lib\"\n"), "{c}");
    // imported directly, the specifier is the component's own
    let direct = [
        files[0],
        (
            "C.tsx",
            "import { useState } from 'react'\nimport { useLabel } from './lib/l'\nexport default function C({ t }: any) { const [n, setN] = useState(0); const f = useLabel(t); return <button onClick={() => setN(f().length + n)}>{n}</button> }",
        ),
    ];
    let (_, _, c) = lower_tree(&direct);
    assert!(c.contains("from \"./lib/l\""), "{c}");
}

// ---- D3: a plain hook parameter with a default ----

const USE_FOCUS: &str = "export function useFocus(sel = 'input:not([disabled])', n?: number) { return sel + (n ?? 0) }\n";

fn with_focus(call: &str) -> ComponentIR {
    let c = format!(
        "import {{ useFocus }} from './f'\nexport default function C({{ s }}: any) {{ const v = {call}; return <p>{{v}}</p> }}"
    );
    analyze_tree(&[("f.ts", USE_FOCUS), ("C.tsx", &c)])
}

#[test]
fn a_defaulted_parameter_takes_its_default_or_the_argument() {
    for call in [
        "useFocus()",
        "useFocus(s)",
        "useFocus(undefined, 2)",
        "useFocus('b', 1)",
    ] {
        accepted(&with_focus(call), Tier::Static);
    }
    let src = "import { useFocus } from './f'\nexport default function C({ s }: any) { const a = useFocus(); const b = useFocus(s); const c = useFocus(undefined); return <p>{a}|{b}|{c}</p> }";
    let (j, _, _) = lower_tree(&[("f.ts", USE_FOCUS), ("C.tsx", src)]);
    // omitted: the default itself; passed: `arg === undefined ? default : arg`
    assert!(j.contains("input:not([disabled])"), "{j}");
}

#[test]
fn a_default_that_reads_a_parameter_or_calls_refuses_by_name() {
    let hook = "export function useX(a: number, b = a + 1) { return a + b }\n";
    let c = "import { useX } from './x'\nexport default function C({ n }: any) { const v = useX(n); return <p>{v}</p> }";
    refused(
        &analyze_tree(&[("x.ts", hook), ("C.tsx", c)]),
        "hook-shape",
        "the default of parameter `b` reads another parameter",
    );
    let hook = "export function useX(a: number, b = Math.max(1, 2)) { return a + b }\n";
    refused(
        &analyze_tree(&[("x.ts", hook), ("C.tsx", c)]),
        "hook-shape",
        "the default of parameter `b` calls a function",
    );
    // a computed argument for a defaulted parameter is read twice: refused by name
    let c = "import { useFocus } from './f'\nexport default function C({ s }: any) { const v = useFocus(s.trim()); return <p>{v}</p> }";
    refused(
        &analyze_tree(&[("f.ts", USE_FOCUS), ("C.tsx", c)]),
        "hook-shape",
        "parameter `sel` has a default and the call site passes a computed value",
    );
}

#[test]
fn an_arrow_default_does_not_name_a_client_function_in_a_job() {
    let hook = "export function useDone(n: number, after: () => void = () => {}) { const go = () => { after() }; return go }\n";
    let c = "import { useState } from 'react'\nimport { useDone } from './d'\nexport default function C() { const [n, setN] = useState(0); const go = useDone(n); return <button onClick={() => { go(); setN(n + 1) }}>{n}</button> }";
    let ir = analyze_tree(&[("d.ts", hook), ("C.tsx", c)]);
    assert!(
        fallbacks(&ir)
            .iter()
            .all(|(r, _)| r != "client-function-in-job"),
        "{:?}",
        ir.diagnostics
    );
    println!("arrow default: {:?} {:?}", ir.tier, fallbacks(&ir));
}

// ---- F579: an exported helper of a hook's module carried into the chunk ----

#[test]
fn an_exported_helper_is_carried_without_its_export() {
    for helper in [
        "export function shout(x: string) { return x.toUpperCase() }",
        "export async function shout(x: string) { return x.toUpperCase() }",
        "function shout(x: string) { return x.toUpperCase() }",
    ] {
        let hook = format!(
            "{helper}\nexport function useShout(mark = '!') {{ const say = (x: string) => shout(x) + mark; return say }}\n"
        );
        let (_, _, c) = lower_tree(&[
            ("useShout.ts", &hook),
            (
                "C.tsx",
                "import { useState } from 'react'\nimport { useShout } from './useShout'\nexport default function C({ initial }: any) { const [v, setV] = useState(initial); const say = useShout(); return <button onClick={() => setV(say(v))}>{v}</button> }",
            ),
        ]);
        // a plain helper is carried; an async one is not plain and is imported (B2) instead
        assert!(
            c.contains("function shout_useShout1(x)")
                || c.contains("import { shout as shout_import1 } from \"./useShout\""),
            "{helper}: {c}"
        );
        assert!(
            !c.contains("export function") && !c.contains("export async"),
            "{helper}: {c}"
        );
    }
}

// ---- review round 1: what a function an inlined hook returns reads is declared in the chunk ----

/// The chunk of `C.tsx` declares every `<name>_<hook>N` it reads.
#[track_caller]
fn declares_what_it_reads(files: &[(&str, &str)]) -> String {
    let (_, _, c) = lower_tree(files);
    assert!(!c.is_empty(), "no chunk");
    let mut i = 0;
    while let Some(at) = c[i..].find("_use") {
        let start = c[..i + at]
            .rfind(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
            .map_or(0, |p| p + 1);
        let end = i
            + at
            + c[i + at..]
                .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
                .unwrap_or(0);
        let name = &c[start..end];
        // declared, or bound as a parameter of a handler's wrapper (`((setX, x) => …)(x.set, x())`)
        let declared = c.contains(&format!("const {name} "))
            || [
                format!("(({name},"),
                format!("(({name}) =>"),
                format!(", {name},"),
                format!(", {name}) =>"),
            ]
            .iter()
            .any(|p| c.contains(p.as_str()));
        assert!(declared, "`{name}` is read but not declared:\n{c}");
        i = end.max(i + at + 1);
    }
    c
}

#[test]
fn a_returned_function_read_by_member_declares_the_parameter_it_reads() {
    // `q.find` reads the hook's parameter (passed, and defaulted when omitted)
    for (hook, call) in [
        (
            "export function useQ(sel: string) { const [hit, setHit] = useState(''); const find = () => setHit(sel + '!'); return { hit, find } }",
            "useQ('x')",
        ),
        (
            "export function useQ(sel = 'a, button') { const [hit, setHit] = useState(''); const find = () => setHit(sel + '!'); return { hit, find } }",
            "useQ()",
        ),
    ] {
        let hook = format!("import {{ useState }} from 'react'\n{hook}\n");
        let c = format!(
            "import {{ useQ }} from './q'\nexport default function C() {{ const q = {call}; return <button onClick={{q.find}}>{{q.hit}}</button> }}"
        );
        let c = declares_what_it_reads(&[("q.ts", &hook), ("C.tsx", &c)]);
        assert!(c.contains("const sel_useQ1 "), "{c}");
    }
}

#[test]
fn a_returned_function_declares_the_hook_local_function_and_derived_value_it_reads() {
    // an arrow default (D3) and a re-export (D2): `toggle` reads `after`
    let hook = "import { useState } from 'react'\nexport function useTrap(sel = 'a, button', after: () => void = () => {}) { const [open, setOpen] = useState(false); const toggle = () => { setOpen(!open); after() }; return { open, toggle, sel } }\n";
    let c = "import { useTrap } from './lib/barrel'\nexport default function C() { const t = useTrap(); return <button onClick={t.toggle}>{t.open ? 'on' : 'off'}</button> }";
    declares_what_it_reads(&[
        ("lib/useTrap.ts", hook),
        (
            "lib/barrel.ts",
            "import { useTrap } from './useTrap'\nexport { useTrap }\n",
        ),
        ("C.tsx", c),
    ]);
    // a hook-local arrow and a hook derived value, destructured at the call site
    let hook = "import { useState } from 'react'\nexport function useSay(name: string) { const [v, setV] = useState(''); const label = name + '!'; const after = () => {}; const say = () => { setV(label); after() }; return { v, say } }\n";
    let c = "import { useSay } from './s'\nexport default function C({ n }: any) { const { v, say } = useSay(n); return <button onClick={say}>{v}</button> }";
    declares_what_it_reads(&[("s.ts", hook), ("C.tsx", c)]);
}

// ---- D6: the cells a returned handler may not read yet (refused, named) ----

const CART: &str = "import { defineStore, signal } from 'brust/store'\nexport const cart = defineStore('cart', () => ({ count: signal(0) }))\n";

#[test]
fn a_returned_handler_reading_a_store_or_a_context_value_refuses_by_name() {
    let store = "import { useState } from 'react'\nimport { useStore } from 'brust/store/react'\nimport { cart } from './cart'\nexport function useS() { const [v, setV] = useState(''); const n = useStore(cart).count; const run = () => setV(String(n)); return { v, run } }\n";
    let ctx = "import { useState, useContext, createContext } from 'react'\nexport const Ctx = createContext('dflt')\nexport function useS() { const [v, setV] = useState(''); const c = useContext(Ctx); const label = c + '!'; const run = () => setV(label); return { v, run } }\n";
    for (hook, what) in [(store, "reads a store"), (ctx, "reads a context value")] {
        for c in [
            "import { useS } from './h'\nexport default function C() { const s = useS(); return <button onClick={s.run}>{s.v}</button> }",
            "import { useS } from './h'\nexport default function C() { const { v, run } = useS(); return <button onClick={run}>{v}</button> }",
        ] {
            let ir = analyze_tree(&[("cart.ts", CART), ("h.ts", hook), ("C.tsx", c)]);
            refused(
                &ir,
                "hook-shape",
                &format!(
                    "custom hook useS: `run` (from the hook `useS`), used as an event handler by name, {what}"
                ),
            );
        }
        // called from an inline handler it is a hoisted handler's read (unchanged)
        let c = "import { useS } from './h'\nexport default function C() { const s = useS(); return <button onClick={() => s.run()}>{s.v}</button> }";
        let ir = analyze_tree(&[("cart.ts", CART), ("h.ts", hook), ("C.tsx", c)]);
        assert!(
            fallbacks(&ir)
                .iter()
                .all(|(_, m)| !m.contains("used as an event handler by name")),
            "{:?}",
            ir.diagnostics
        );
    }
}

#[test]
fn a_returned_handler_reading_a_prop_carries_it_in_x_props() {
    // D6 cells (2) and (3): the prop the function reads is a client prop
    let hook = "import { useState } from 'react'\nexport function useQ(sel = 'a, button') { const [hit, setHit] = useState(''); const find = () => setHit(sel + '!'); return { hit, find } }\nexport function useO({ sel }: any) { const [hit, setHit] = useState(''); const find = () => setHit(sel + '!'); return { hit, find } }\n";
    for c in [
        "import { useQ } from './q'\nexport default function C({ title }: any) { const q = useQ(title); return <button onClick={q.find}>{q.hit}</button> }",
        "import { useO } from './q'\nexport default function C({ title }: any) { const { hit, find } = useO({ sel: title }); return <button onClick={find}>{hit}</button> }",
    ] {
        let ir = analyze_tree(&[("q.ts", hook), ("C.tsx", c)]);
        accepted(&ir, Tier::Native);
        assert!(
            ir.client_props.iter().any(|p| p == "title"),
            "{:?}",
            ir.client_props
        );
        let (j, _, _) = lower_tree(&[("q.ts", hook), ("C.tsx", c)]);
        assert!(j.contains("\"title\": title"), "{j}");
    }
}
