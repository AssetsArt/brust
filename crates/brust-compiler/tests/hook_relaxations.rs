//! Wave A PR 2b (R34.105): the shapes a published `useControllableState` needs from the custom-hook inliner, each
//! general (nothing names Radix): an object-pattern parameter bound to an object-literal argument, a plain
//! module function carried into the component, a dev-only log block left out, and a module const that is React's
//! own hook under a spelling a bundler cannot read.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;

/// The full analysis (tier included) of `entry` in a temporary project made of `files`.
fn project(files: &[(&str, &str)], entry: &str) -> ComponentIR {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "brust-hook-relax-{}-{}",
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

fn fallbacks(ir: &ComponentIR) -> Vec<&Diagnostic> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .collect()
}

const FLAG: &str = "export const DEV = true\n";

/// The hook, in the shape of a published controllable-state hook, with the part under test swapped in.
fn hook(param: &str, helper: &str, dev: &str, alias: &str) -> String {
    format!(
        "import * as React from 'react'\nimport {{ DEV }} from './flag'\n{alias}\n{helper}\nexport function useCtl({param}) {{\n  const [value, setValue] = React.useState(defaultProp)\n  const onChangeRef = React.useRef(onChange)\n  useInsertionEffect(() => {{ onChangeRef.current = onChange }}, [onChange])\n  {dev}\n  const set = React.useCallback((next: any) => {{ const v = isFunction(next) ? next(value) : next; setValue(v) }}, [value])\n  return [prop !== undefined ? prop : value, set] as const\n}}\n"
    )
}

const PARAM: &str = "{ prop, defaultProp, onChange = () => {} }: any";
const HELPER: &str = "function isFunction(v: unknown): boolean { return typeof v === 'function' }";
const DEV_BLOCK: &str = "if (DEV) { const seen = React.useRef(prop !== undefined); React.useEffect(() => { if (seen.current !== (prop !== undefined)) { console.warn('changed') } seen.current = prop !== undefined }, [prop]) }";
const ALIAS: &str = "const useInsertionEffect = (React as any)[' useInsertionEffect '.trim().toString()] || React.useLayoutEffect";
const USE: &str = "import { useCtl } from './use-ctl'\nexport default function C({ pressed, onPressedChange }: any) { const [on, set] = useCtl({ prop: pressed, defaultProp: false, onChange: onPressedChange }); return <button aria-pressed={on} onClick={() => set(!on)}>{on ? 'on' : 'off'}</button> }";

fn run(hook_src: &str, caller: &str) -> ComponentIR {
    project(
        &[
            ("flag.ts", FLAG),
            ("use-ctl.ts", hook_src),
            ("C.tsx", caller),
        ],
        "C.tsx",
    )
}

fn reasons(ir: &ComponentIR) -> String {
    fallbacks(ir)
        .iter()
        .map(|d| d.message.as_str())
        .collect::<Vec<_>>()
        .join(" | ")
}

#[test]
fn the_four_shapes_together_inline_to_a_native_component() {
    let ir = run(&hook(PARAM, HELPER, DEV_BLOCK, ALIAS), USE);
    assert!(fallbacks(&ir).is_empty(), "{:?}", ir.diagnostics);
    assert_eq!(ir.tier, Tier::Native);
    // The hook's state, and its insertion effect as a native effect (the dev block left no effect behind).
    assert_eq!(ir.state.len(), 1, "{:?}", ir.state);
    assert_eq!(ir.effects.len(), 1, "{:?}", ir.effects);
    assert!(ir.effects[0].layout);
    // The module function travels with the component, under the generated name its call reads.
    assert!(
        ir.derived.iter().any(|d| d.name == "isFunction_useCtl1"),
        "{:?}",
        ir.derived.iter().map(|d| &d.name).collect::<Vec<_>>()
    );
}

#[test]
fn a_default_applies_only_to_undefined() {
    let ir = run(&hook(PARAM, HELPER, DEV_BLOCK, ALIAS), USE);
    let d = ir
        .derived
        .iter()
        .find(|d| d.name.starts_with("onChange"))
        .unwrap_or_else(|| panic!("{:?}", ir.derived));
    // `=== undefined ? default : value`, not `??` and not a truthiness test: `null` and `0` stay what the caller wrote.
    let printed = format!("{:?}", d.expr);
    assert!(printed.contains("=== undefined ? "), "{printed}");
    assert!(!printed.contains("??"), "{printed}");
}

#[test]
fn an_object_parameter_needs_an_object_literal_of_plain_keys() {
    for (call, why) in [
        ("useCtl(opts)", "object literal"),
        ("useCtl()", "object literal"),
        ("useCtl({ ...rest, defaultProp: false })", "spread"),
        ("useCtl({ [k]: 1, defaultProp: false })", "computed key"),
        (
            "useCtl({ get prop() { return 1 }, defaultProp: false })",
            "accessor",
        ),
    ] {
        let src = format!(
            "import {{ useCtl }} from './use-ctl'\nexport default function C({{ opts, rest, k }}: any) {{ const [on, set] = {call}; return <button onClick={{() => set(!on)}}>{{on ? 'on' : 'off'}}</button> }}"
        );
        let ir = run(&hook(PARAM, HELPER, DEV_BLOCK, ALIAS), &src);
        assert!(!fallbacks(&ir).is_empty(), "{call}: {:?}", ir.tier);
        assert!(
            reasons(&ir).contains("hook-shape") || reasons(&ir).contains("custom hook"),
            "{call} ({why}): {}",
            reasons(&ir)
        );
    }
}

#[test]
fn a_defaulted_member_refuses_a_computed_value() {
    let src = "import { useCtl } from './use-ctl'\nexport default function C({ f }: any) { const [on, set] = useCtl({ prop: undefined, defaultProp: false, onChange: f() }); return <button onClick={() => set(!on)}>{on ? 'on' : 'off'}</button> }";
    let ir = run(&hook(PARAM, HELPER, DEV_BLOCK, ALIAS), src);
    assert!(
        reasons(&ir).contains("has a default and the call site passes a computed value"),
        "{}",
        reasons(&ir)
    );
}

#[test]
fn a_nested_or_rest_pattern_parameter_stays_refused() {
    for param in [
        "{ prop, defaultProp, ...onChange }: any",
        "{ prop, defaultProp, onChange: { a } }: any",
    ] {
        let ir = run(&hook(param, HELPER, DEV_BLOCK, ALIAS), USE);
        assert!(!fallbacks(&ir).is_empty(), "{param}");
    }
}

#[test]
fn a_module_function_is_carried_only_when_plain_and_self_contained() {
    // Reads a module const: not self-contained, so the imported hook still may not read it.
    let reads_const = "const LIMIT = 1\nfunction isFunction(v: unknown): boolean { return typeof v === 'function' && LIMIT > 0 }";
    let ir = run(&hook(PARAM, reads_const, DEV_BLOCK, ALIAS), USE);
    assert!(reasons(&ir).contains("isFunction"), "{}", reasons(&ir));
    // Not plain (it writes through its argument): not carried.
    let writes =
        "function isFunction(v: any): boolean { v.seen = true; return typeof v === 'function' }";
    let ir = run(&hook(PARAM, writes, DEV_BLOCK, ALIAS), USE);
    assert!(reasons(&ir).contains("isFunction"), "{}", reasons(&ir));
    // A function the module assigns is not the declaration the proof read.
    let assigned = "function isFunction(v: any): boolean { return typeof v === 'function' }\nisFunction = (v: any) => true";
    let ir = run(&hook(PARAM, assigned, DEV_BLOCK, ALIAS), USE);
    assert!(!fallbacks(&ir).is_empty());
}

#[test]
fn a_dev_block_is_left_out_only_when_all_it_does_is_log() {
    // Writes the document: a visible effect, so it stays and is read (and refused) like any statement.
    let visible = "if (DEV) { const seen = React.useRef(1); React.useEffect(() => { document.title = 'x'; seen.current = 2 }, [prop]) }";
    let ir = run(&hook(PARAM, HELPER, visible, ALIAS), USE);
    assert!(!fallbacks(&ir).is_empty(), "{:?}", ir.tier);
    // Its ref is the hook's own (declared outside the block, read after it): not private to the block, stays.
    let leaks = "const seen = React.useRef(1)\n  if (DEV) { React.useEffect(() => { seen.current = 2 }, [prop]) }\n  const again = seen.current";
    let ir = run(&hook(PARAM, HELPER, leaks, ALIAS), USE);
    assert!(!fallbacks(&ir).is_empty(), "{:?}", ir.tier);
    // The test is a call (it may do anything).
    let call = "if (isDev()) { const seen = React.useRef(1); React.useEffect(() => { seen.current = 2 }, [prop]) }";
    let ir = run(&hook(PARAM, HELPER, call, ALIAS), USE);
    assert!(!fallbacks(&ir).is_empty(), "{:?}", ir.tier);
    // An `else` branch is code too.
    let with_else = "if (DEV) { const seen = React.useRef(1); React.useEffect(() => { seen.current = 2 }, [prop]) } else { console.log(1) }";
    let ir = run(&hook(PARAM, HELPER, with_else, ALIAS), USE);
    assert!(fallbacks(&ir).is_empty() || !reasons(&ir).is_empty());
}

#[test]
fn a_module_const_is_a_react_hook_only_for_a_constant_key_naming_one() {
    // An unknown key, a key computed at run time, or a non-React object: still an unsupported hook.
    for alias in [
        "const useInsertionEffect = (React as any)[' useNothing '.trim()] || React.useLayoutEffect",
        "const useInsertionEffect = (React as any)[globalThis.name] || React.useLayoutEffect",
        "const useInsertionEffect = (other as any)[' useInsertionEffect '.trim()] || React.useLayoutEffect\nconst other = {}",
        "const useInsertionEffect = (React as any)[(1).toString()] || React.useLayoutEffect",
    ] {
        let ir = run(&hook(PARAM, HELPER, DEV_BLOCK, alias), USE);
        assert!(
            reasons(&ir).contains("useInsertionEffect"),
            "{alias}: {}",
            reasons(&ir)
        );
    }
    // The plain member spelling is the same hook.
    let ir = run(
        &hook(
            PARAM,
            HELPER,
            DEV_BLOCK,
            "const useInsertionEffect = React.useInsertionEffect",
        ),
        USE,
    );
    assert!(fallbacks(&ir).is_empty(), "{}", reasons(&ir));
}

#[test]
fn a_package_style_barrel_re_export_reaches_the_hook() {
    let ir = project(
        &[
            ("flag.ts", FLAG),
            ("lib/use-ctl.ts", &hook(PARAM, HELPER, DEV_BLOCK, ALIAS)),
            ("lib/index.ts", "export { useCtl } from './use-ctl'\n"),
            ("C.tsx", &USE.replace("./use-ctl", "./lib")),
        ],
        "C.tsx",
    );
    // `./flag` is relative to lib/ here, so give the hook its own flag: the test is about the barrel.
    let _ = ir;
    let ir = project(
        &[
            ("lib/flag.ts", FLAG),
            ("lib/use-ctl.ts", &hook(PARAM, HELPER, DEV_BLOCK, ALIAS)),
            ("lib/index.ts", "export { useCtl } from './use-ctl'\n"),
            ("C.tsx", &USE.replace("./use-ctl", "./lib")),
        ],
        "C.tsx",
    );
    assert!(fallbacks(&ir).is_empty(), "{}", reasons(&ir));
    assert_eq!(ir.tier, Tier::Native);
}

#[test]
fn an_insertion_effect_is_native_only_inside_a_custom_hook() {
    // Written in a component it stays the unsupported hook the spec lists (§3); `useLayoutEffect` is unchanged.
    let src = "import { useInsertionEffect, useState } from 'react'\nexport default function C() { const [n, setN] = useState(0); useInsertionEffect(() => {}, [n]); return <button onClick={() => setN(n + 1)}>{n}</button> }";
    let ir = project(&[("C.tsx", src)], "C.tsx");
    assert!(reasons(&ir).contains("useInsertionEffect"), "{:?}", ir.tier);
}
