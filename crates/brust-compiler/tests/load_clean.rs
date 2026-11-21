//! F591 rule (e): which app modules run nothing at load that a page would miss when the native chunk bundling them is
//! left out (`load_writes::scan` → `load_clean`, judged by `module_effects::module_effect` in its load-time mode). The
//! mode decides only the manifest's `hosts`; the component analysis keeps the F215 rule (last test).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::analyze::load_writes::scan;
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn write_tree(files: &[(&str, &str)]) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("brustc-f591-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, text) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    root
}

/// The modules of `files` the scan judges load-clean, sorted.
fn clean_of(files: &[(&str, &str)]) -> Vec<String> {
    let root = write_tree(files);
    let paths: Vec<String> = files.iter().map(|(p, _)| p.to_string()).collect();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root,
            ..Default::default()
        };
        scan(&paths, &opts).load_clean
    })
}

const WRITER: &str = "let count = 0\nexport const items: string[] = []\nexport function bump() {\n  count += 1\n  items.push('x')\n  return count\n}\n";

#[test]
fn a_function_that_writes_a_module_let_runs_nothing_at_load() {
    assert_eq!(clean_of(&[("lib/tidy.ts", WRITER)]), vec!["lib/tidy.ts"]);
}

#[test]
fn the_same_function_called_at_top_level_is_load_time_code() {
    let called = format!("{WRITER}bump()\n");
    let as_value = format!("{WRITER}export const first = bump()\n");
    assert!(clean_of(&[("lib/tidy.ts", &called)]).is_empty());
    assert!(clean_of(&[("lib/tidy.ts", &as_value)]).is_empty());
}

#[test]
fn a_call_at_top_level_of_another_module_refuses_that_module_only() {
    let other = "import { bump } from './tidy'\nbump()\nexport const N = 1\n";
    let value = "import { bump } from './tidy'\nexport const N = bump()\n";
    // The build refuses `hosts` for any chunk whose graph holds a module not listed: `other` / `value` here.
    assert_eq!(
        clean_of(&[
            ("lib/tidy.ts", WRITER),
            ("lib/other.ts", other),
            ("lib/value.ts", value)
        ]),
        vec!["lib/tidy.ts"]
    );
}

#[test]
fn a_let_is_judged_by_its_initializer() {
    let literal = "export let mode = 'a'\nexport function set(m: string) {\n  mode = m\n}\n";
    // F597 D4 accepts a call of a clean function of the module; one that writes outside itself stays load-time code.
    let called =
        "function make() {\n  (globalThis as any).n = 1\n  return 1\n}\nexport let mode = make()\n";
    assert_eq!(clean_of(&[("lib/l.ts", literal)]), vec!["lib/l.ts"]);
    assert!(clean_of(&[("lib/l.ts", called)]).is_empty());
}

#[test]
fn a_class_new_an_expression_statement_and_a_global_write_stay_load_time_code() {
    for src in [
        "export class Poller {\n  n = 0\n}\n",
        // F597 D1 accepts `new Map()` of the global; a constructor of anything else stays load-time code.
        "export const enc = new TextEncoder()\n",
        "globalThis.addEventListener('keydown', () => {})\n",
        ";(globalThis as any).__x = 1\nexport const k = 1\n",
    ] {
        assert!(clean_of(&[("lib/m.ts", src)]).is_empty(), "{src}");
    }
}

#[test]
fn package_calls_and_plain_tables_run_nothing_the_page_would_miss() {
    let store = "import { defineStore, signal } from '@brust/core/store'\nconst KEY = 'k'\nexport const prefs = defineStore('prefs', () => ({ lang: signal('th') }))\nexport function setLang(l: string) {\n  prefs.lang.set(l)\n  localStorage.setItem(KEY, l)\n}\n";
    let table = "export const LABELS = { a: 'A', b: 'B' }\nexport const NAMES = ['x', 'y']\n";
    assert_eq!(
        clean_of(&[("lib/store.ts", store), ("lib/table.ts", table)]),
        vec!["lib/store.ts", "lib/table.ts"]
    );
}

#[test]
fn the_load_time_mode_changes_no_component_analysis() {
    // The same shape in the component's own module (a table a declared function writes, read by the page) keeps today's
    // F215 refusal: the load-time mode is used only for the manifest's `hosts`.
    let src = "import { useState } from 'react'\nconst items: string[] = ['a']\nexport function add() {\n  items.push('x')\n}\nexport default function C() {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{items.length} {n}</button>\n}\n";
    let root = write_tree(&[("C.tsx", src)]);
    let ir = run_on_compiler_thread(move || {
        analyze_source(
            "C.tsx",
            src.as_bytes().to_vec(),
            &AnalyzeOptions {
                root,
                ..Default::default()
            },
        )
        .unwrap()
    });
    let fallbacks: Vec<&str> = ir
        .diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| d.rule.as_str())
        .collect();
    assert!(fallbacks.contains(&"module-side-effect"), "{fallbacks:?}");
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
    assert_eq!(clean_of(&[("C.tsx", src)]), vec!["C.tsx"]);
}

#[test]
fn review_f1_a_package_call_handed_app_code_at_load_is_load_time_code() {
    for src in [
        "import { onReady } from 'some-pkg'\nexport const off = onReady(() => {\n  document.body.dataset.x = '1'\n})\n",
        "import { onReady } from 'some-pkg'\nfunction setup() {\n  document.body.dataset.x = '1'\n}\nexport const off = onReady(setup)\n",
        "import { make } from 'some-pkg'\nexport const x = make({ onLoad: () => {} })\n",
        "import { make } from 'some-pkg'\nexport const x = make([() => 1])\n",
        "import { onReady } from 'some-pkg'\nimport { setup } from './setup'\nexport const off = onReady(setup)\n",
        "import { defineStore } from '@brust/core/store'\nexport const s = defineStore('s', () => {\n  document.title = 'x'\n  return {}\n})\n",
    ] {
        let clean = clean_of(&[
            ("lib/m.ts", src),
            ("lib/setup.ts", "export function setup() {}\n"),
        ]);
        assert_eq!(clean, vec!["lib/setup.ts"], "{src}");
    }
}

#[test]
fn review_f1_data_only_package_calls_store_setups_and_react_wrappers_stay_accepted() {
    for (file, src) in [
        (
            "lib/m.ts",
            "import i18next from 'i18next'\nexport const i18n = i18next.init({ lng: 'th' })\n",
        ),
        (
            "lib/m.ts",
            "import { defineStore, signal } from '@brust/core/store'\nexport const s = defineStore('s', () => ({ a: signal(1) }))\n",
        ),
        (
            "lib/m.tsx",
            "import { forwardRef, memo } from 'react'\nexport const B = forwardRef<HTMLButtonElement>((p, ref) => <button ref={ref} />)\nexport const M = memo(() => <i />)\n",
        ),
        (
            "lib/m.tsx",
            "function Icon() {\n  return <svg />\n}\nexport const ICONS = { home: <Icon /> }\n",
        ),
    ] {
        assert_eq!(clean_of(&[(file, src)]), vec![file], "{src}");
    }
}

#[test]
fn review_f2_an_object_a_conversion_runs_app_code_of_is_load_time_code() {
    for src in [
        "const o = { toString() {\n  (globalThis as any).hit = 1\n  return 'a'\n} }\nexport const s = `${o}`\n",
        "const o = { toString: () => 'a' }\nexport const s = 'a' + o\n",
        "const o = { toString: () => 'a' }\nexport const s = String(o)\n",
        "const o = { valueOf: () => 1 }\nexport const s = o > 0\n",
        "const o = { toJSON: () => 1 }\nexport const s = JSON.stringify(o)\n",
    ] {
        assert!(clean_of(&[("lib/m.ts", src)]).is_empty(), "{src}");
    }
}

/// AMENDMENT 3: every row of both review probes (notes 30f3dfb6 and 85e3e8e0), the two F4 rows first.
const REFUSED: &[(&str, &str)] = &[
    (
        "F4 handler || null",
        "import { onReady } from 'some-pkg'\nconst f = () => {\n  document.body.dataset.x = '1'\n}\nexport const x = onReady(f || null)\n",
    ),
    (
        "F4 comma",
        "import { onReady } from 'some-pkg'\nexport const x = onReady((0, () => {\n  document.body.dataset.x = '1'\n}))\n",
    ),
    (
        "getter",
        "const o = {\n  get v() {\n    (globalThis as any).hit = 1\n    return 1\n  },\n}\nexport const v = o.v\n",
    ),
    (
        "tagged template",
        "import { css } from 'some-pkg'\nexport const c = css`a`\n",
    ),
    ("dynamic import", "export const m = import('./other')\n"),
    (
        "top-level await",
        "export const v = await Promise.resolve(1)\n",
    ),
    (
        "assignment initializer",
        "let a = 0\nexport const b = (a = 1)\n",
    ),
    (
        "delete initializer",
        "const o: any = { a: 1 }\nexport const b = delete o.a\n",
    ),
    (
        "comma initializer",
        "function f() {\n  (globalThis as any).hit = 1\n}\nexport const b = (f(), 1)\n",
    ),
    (
        "??= initializer",
        "let a: number | undefined\nexport const b = (a ??= 1)\n",
    ),
    (
        "IIFE",
        "export const b = (() => {\n  (globalThis as any).hit = 1\n  return 1\n})()\n",
    ),
    (
        "setTimeout",
        "setTimeout(() => {}, 0)\nexport const k = 1\n",
    ),
    (
        "addEventListener",
        "addEventListener('load', () => {})\nexport const k = 1\n",
    ),
    (
        "defineProperty",
        "export const o = Object.defineProperty({}, 'a', { get: () => 1 })\n",
    ),
    (
        "Reflect",
        "export const o = Reflect.set(globalThis, 'a', 1)\n",
    ),
    (
        "Promise.then",
        "export const p = Promise.resolve(1).then(() => {\n  (globalThis as any).hit = 1\n})\n",
    ),
    (
        "Array.from with a writing callback",
        "export const xs = Array.from({ length: 2 }, () => {\n  (globalThis as any).hit = 1\n  return 1\n})\n",
    ),
    (
        "map callback",
        "export const xs = [1, 2].map((x) => {\n  (globalThis as any).hit = x\n  return x\n})\n",
    ),
    // F597 (challenge aa98bfcc): `[...new Set([1])]` is D1 + D2 and moved to F597_ACCEPTED; the reviewer's concern (a
    // spread that may run a custom iterator) stays refused for every value the judge cannot prove fresh.
    (
        "spread of an iterator brust cannot prove",
        "import { s } from './other'\nexport const xs = [...s]\n",
    ),
    (
        "spread of a custom iterator",
        "const it = {\n  *[Symbol.iterator]() {\n    (globalThis as any).hit = 1\n    yield 1\n  },\n}\nexport const xs = [...it]\n",
    ),
    (
        "spread of a Set built from an unproven import",
        "import { s } from './other'\nconst t = new Set(s as any)\nexport const xs = [...t]\n",
    ),
    (
        "spread of a call result",
        "import { list } from 'some-pkg'\nexport const xs = [...list()]\n",
    ),
    ("enum", "export enum E {\n  A,\n  B,\n}\n"),
    (
        "customElements",
        "customElements.define('x-a', class extends HTMLElement {})\nexport const k = 1\n",
    ),
    (
        "object const holding a function handed",
        "import { onReady } from 'some-pkg'\nconst h = { run: () => {} }\nexport const x = onReady(h)\n",
    ),
    (
        "array const holding a function handed",
        "import { onReady } from 'some-pkg'\nconst hs = [() => {}]\nexport const x = onReady(hs)\n",
    ),
    (
        "ternary",
        "import { onReady } from 'some-pkg'\nconst f = () => {}\nexport const x = onReady(Math.random() > 1 ? f : null)\n",
    ),
    (
        "?? arrow",
        "import { onReady } from 'some-pkg'\nconst g: any = null\nexport const x = onReady(g ?? (() => {}))\n",
    ),
    (
        "member of a local object",
        "import { onReady } from 'some-pkg'\nconst h = { run() {} }\nexport const x = onReady(h.run)\n",
    ),
    (
        "namespace-import member",
        "import { onReady } from 'some-pkg'\nimport * as app from './setup'\nexport const x = onReady(app.setup)\n",
    ),
    (
        "named app import",
        "import { onReady } from 'some-pkg'\nimport { setup } from './setup'\nexport const x = onReady(setup)\n",
    ),
    (
        "chained call with a callback",
        "import { api } from 'some-pkg'\nexport const x = api().on(() => {})\n",
    ),
    (
        "chained call with data",
        "import { api } from 'some-pkg'\nexport const x = api().get('a')\n",
    ),
    (
        "method shorthand argument",
        "import { make } from 'some-pkg'\nexport const x = make({ run() {} })\n",
    ),
    (
        "getter argument",
        "import { make } from 'some-pkg'\nexport const x = make({\n  get v() {\n    return 1\n  },\n})\n",
    ),
    (
        "let holding a function",
        "import { onReady } from 'some-pkg'\nlet f = () => {}\nexport const x = onReady(f)\n",
    ),
    (
        "var holding a function",
        "import { onReady } from 'some-pkg'\nvar f = () => {}\nexport const x = onReady(f)\n",
    ),
    (
        "new with a callback",
        "import { Pkg } from 'some-pkg'\nexport const x = new Pkg(() => {})\n",
    ),
    (
        "tagged package template",
        "import { gql } from 'some-pkg'\nexport const q = gql`{ a }`\n",
    ),
    (
        "computed setup calling app code",
        "import { computed } from '@brust/core/store'\nimport { setup } from './setup'\nexport const c = computed(() => setup())\n",
    ),
    (
        "signal handed an arrow",
        "import { signal } from '@brust/core/store'\nexport const s = signal(() => {\n  (globalThis as any).hit = 1\n})\n",
    ),
];

const ACCEPTED: &[(&str, &str)] = &[
    (
        "a function value only exported",
        "export const f = () => {\n  (globalThis as any).hit = 1\n}\n",
    ),
    (
        "defineStore setup returning an object that holds a function",
        "import { defineStore, signal } from '@brust/core/store'\nexport const s = defineStore('s', () => ({ n: signal(0), run: () => {} }))\n",
    ),
    (
        "a plain table",
        "export const T = { a: [1, 2], b: 'x', c: -1, d: `t` }\n",
    ),
    (
        "a package call with data only",
        "import { make } from 'some-pkg'\nconst K = 'k'\nexport const x = make(K, { a: [1, -2], b: `x` }, null)\n",
    ),
];

#[test]
fn amendment_3_every_refused_row_of_both_review_probes() {
    for (what, src) in REFUSED {
        let clean = clean_of(&[
            ("lib/m.ts", src),
            ("lib/setup.ts", "export function setup() {}\n"),
            ("lib/other.ts", "export const k = 1\n"),
        ]);
        assert!(!clean.contains(&"lib/m.ts".to_string()), "{what}: {src}");
    }
}

#[test]
fn amendment_3_every_accepted_row_of_both_review_probes() {
    for (what, src) in ACCEPTED {
        assert_eq!(
            clean_of(&[("lib/m.ts", src)]),
            vec!["lib/m.ts"],
            "{what}: {src}"
        );
    }
}

/// F597: per decision, the forms the load-time judge now accepts (each with its refused rows below).
const F597_ACCEPTED: &[(&str, &str)] = &[
    // Review F1/F2: what stays accepted after the tightening.
    (
        "sort of a module copy of an imported array",
        "import { BASE } from './base'\nexport const S = BASE.slice().sort()\nexport const T = [...BASE].reverse()\n",
    ),
    (
        "sort of a body local copy",
        "function f() {\n  const l = [3, 1, 2]\n  l.sort()\n  return l\n}\nexport const S = f()\n",
    ),
    // D1
    (
        "D1 new Set of an array literal",
        "export const SKIP = new Set(['.git', 'node_modules'])\n",
    ),
    (
        "D1 empty collections",
        "export const a = new Map<string, number>()\nexport const b = new WeakMap()\nexport const c = new WeakSet()\nexport const d = new Set()\n",
    ),
    (
        "D1 new Map of pairs",
        "export const M = new Map([['a', 1], ['b', 2]])\n",
    ),
    (
        "D1 chained add and set",
        "export const S = new Set<string>().add('a').add('b')\nexport const M = new Map().set('k', 1)\n",
    ),
    (
        "D1 Set of a module array",
        "const XS = ['a', 'b']\nexport const S = new Set(XS)\n",
    ),
    // D2
    (
        "D2 spread of a module array",
        "const A = ['a']\nexport const B = [...A, 'b']\n",
    ),
    (
        "D2 spread of a fresh Set (was the review row)",
        "const s = new Set([1])\nexport const xs = [...s]\n",
    ),
    (
        "D2 spread of a Map's keys",
        "const m = new Map([['a', 1]])\nexport const ks = [...m.keys()]\n",
    ),
    (
        "D2 object spread of a module literal",
        "const BASE = { a: 1, b: 'x' }\nexport const O = { ...BASE, c: true }\n",
    ),
    (
        "D2 spread of an imported literal array",
        "import { BASE } from './base'\nexport const ALL = [...BASE, 'z']\n",
    ),
    // D3
    (
        "D3 filter with an arrow",
        "const XS = [1, 2, 3]\nexport const EVEN = XS.filter((x) => x % 2 === 0)\n",
    ),
    (
        "D3 chained filter / flatMap",
        "const AREAS = [{ id: 'a', scopes: ['x', 'y'], soon: false }]\nexport const GRANTABLE = AREAS.filter((a) => !a.soon).flatMap((a) => a.scopes)\n",
    ),
    (
        "D3 map with a block body",
        "const XS = [1, 2]\nexport const YS = XS.map((x) => {\n  const y = x * 2\n  if (y > 2) return y\n  return 0\n})\n",
    ),
    (
        "D3 reduce with a local accumulator",
        "const XS = [1, 2]\nexport const N = XS.reduce((acc, x) => acc + x, 0)\n",
    ),
    (
        "D3 sort a fresh copy",
        "const XS = ['b', 'a']\nexport const SORTED = [...XS].sort()\nexport const BY = XS.toSorted((a, b) => (a < b ? -1 : 1))\n",
    ),
    (
        "D3 Set and Map reads",
        "const S = new Set(['a'])\nconst M = new Map([['a', 1]])\nexport const has = S.has('a')\nexport const v = M.get('a')\n",
    ),
    (
        "D3 callback reading a module Set",
        "const ALLOWED = new Set(['a'])\nconst XS = ['a', 'b']\nexport const OK = XS.filter((x) => ALLOWED.has(x))\n",
    ),
    (
        "D3 join and includes",
        "const XS = ['a', 'b']\nexport const J = XS.join(', ')\nexport const I = XS.includes('a')\n",
    ),
    // D4
    (
        "D4 a pure helper building objects",
        "const t = (name: string, scope: string | null) => ({ name, scope })\nexport const TOOLS = [t('a', null), t('b', 'x')]\n",
    ),
    (
        "D4 a function declaration with if and template",
        "function policy(remote: string, img = '') {\n  if (!remote) return ['default-src none']\n  return ['default-src none', `img-src self${img}`, `script-src ${remote}`]\n}\nexport const CSP = policy('x')\n",
    ),
    (
        "D4 a helper calling a helper",
        "const a = (x: number) => x + 1\nconst b = (x: number) => a(x) * 2\nexport const B = b(1)\n",
    ),
    (
        "D4 a helper used inside a callback",
        "const t = (n: string) => ({ n })\nconst XS = ['a']\nexport const TS = XS.map((x) => t(x))\n",
    ),
    (
        "D3 a method of a member of an element",
        "const GROUPS = [{ id: 'a', scopes: [{ s: 'x', soon: true }] }]\nexport const SOON = GROUPS.flatMap((g) => g.scopes.filter((x) => x.soon).map((x) => x.s))\n",
    ),
    (
        "D3 a spread of a member of an element",
        "const AREAS = [{ read: ['a'], write: ['b'] }]\nexport const ALL = AREAS.flatMap((a) => [...a.read, ...a.write])\n",
    ),
    (
        "D3 includes of a member of an element",
        "const CIDRS = ['10.0.0.0/8']\nconst DENY = [{ cidr: '10.0.0.0/8' }]\nexport const D = DENY.filter((r) => !CIDRS.includes(r.cidr))\n",
    ),
    // extra rule 1 (lead ruling): a template of an imported primitive const
    (
        "rule 1 imported primitive const in a template",
        "import { SITE } from './site'\nexport const TERMS = `${SITE}/terms`\n",
    ),
];

const F597_REFUSED: &[(&str, &str)] = &[
    // Review e9d3bcf8 F4 / F5 (closed by AMENDMENT 1: no `let`, assignment or loop in a judged body).
    (
        "review F4 loop with a later local",
        "function f() {\n  let g = undefined\n  for (const i of [1, 2]) {\n    [2, 1].sort(g)\n    g = () => {\n      (globalThis as any).hit = 1\n      return 0\n    }\n    let h = 1\n  }\n  return 1\n}\nexport const r = f()\n",
    ),
    (
        "review F4 loop with an inner loop",
        "function f() {\n  let g = undefined\n  for (const i of [1, 2]) {\n    [2, 1].sort(g)\n    g = () => {\n      (globalThis as any).hit = 1\n      return 0\n    }\n    for (const j of [1]) {\n    }\n  }\n  return 1\n}\nexport const r = f()\n",
    ),
    (
        "review F5 a callback returning a local it assigned a function",
        "function g() {\n  (globalThis as any).hit = 1\n  return 0\n}\nconst fs = [0].map(() => {\n  let x = 0\n  x = g\n  return x\n})\nexport const r = [2, 1].sort(fs[0])\n",
    ),
    (
        "review F5 the same under an if",
        "function g() {\n  (globalThis as any).hit = 1\n  return 0\n}\nconst fs = [0].map((i) => {\n  let x = 0\n  if (i === 0) x = g\n  return x\n})\nexport const r = [2, 1].sort(fs[0])\n",
    ),
    // AMENDMENT 1 rows.
    (
        "amendment let in a callback",
        "const XS = [1]\nexport const YS = XS.map((x) => {\n  let y = x\n  return y\n})\n",
    ),
    (
        "amendment assignment in a followed function",
        "function f() {\n  const o = { a: 1 }\n  o.a = 2\n  return o\n}\nexport const r = f()\n",
    ),
    (
        "amendment for…of in a followed function",
        "function f() {\n  const out = [1]\n  for (const x of [1, 2]) out.includes(x)\n  return out\n}\nexport const r = f()\n",
    ),
    (
        "amendment sort with a const arrow comparator",
        "const cmp = (a: number, b: number) => a - b\nexport const S = [2, 1].sort(cmp)\n",
    ),
    (
        "amendment a member in a callback position",
        "const fs = [(x: number) => x]\nexport const r = [1].map(fs[0])\n",
    ),
    (
        "amendment a call in a callback position",
        "const mk = () => (x: number) => x\nexport const r = [1].map(mk())\n",
    ),
    // Review f9df7a4e F1: a map / flatMap result holds what the callback returned, functions included.
    (
        "review F1a map result handed as a callback",
        "const fs = [0].map(() => () => {\n  (globalThis as any).hit = 1\n})\nexport const r = [1].map(fs[0])\n",
    ),
    (
        "review F1b map result handed as a comparator",
        "function g() {\n  (globalThis as any).hit = 1\n  return 0\n}\nconst fs = [0].map(() => g)\nexport const r = [2, 1].sort(fs[0])\n",
    ),
    (
        "review F1c the same through a callback parameter",
        "function g() {\n  (globalThis as any).hit = 1\n  return 0\n}\nconst fs = [0].map(() => g)\nexport const r = fs.map((f) => [1].map(f))\n",
    ),
    (
        "review F1d a fake receiver from map",
        "const os = [0].map(() => ({\n  map: () => {\n    (globalThis as any).hit = 1\n  },\n}))\nexport const r = os[0].map((x: number) => x)\n",
    ),
    (
        "review F1e a fake receiver from flatMap",
        "const os = [0].flatMap(() => [{\n  filter: () => {\n    (globalThis as any).hit = 1\n  },\n}])\nexport const r = os[0].filter((x: number) => x)\n",
    ),
    (
        "review F1f the comparator shape inside a D4 function",
        "function g() {\n  (globalThis as any).hit = 1\n  return 0\n}\nfunction f() {\n  const fs = [0].map(() => g)\n  return [2, 1].sort(fs[0])\n}\nexport const r = f()\n",
    ),
    // Review F2: an imported array sorted in place at module level changes what every other module sees.
    (
        "review F2 sort of an imported literal array",
        "import { BASE } from './base'\nexport const s = BASE.sort()\n",
    ),
    (
        "review F2 reverse of an imported literal array",
        "import { BASE } from './base'\nexport const s = BASE.reverse()\n",
    ),
    (
        "review F2 sort through a module alias",
        "import { BASE } from './base'\nconst B = BASE\nexport const s = B.sort()\n",
    ),
    (
        "review F2 sort of an imported array held in a module array",
        "import { BASE } from './base'\nconst A = [BASE]\nexport const s = A[0].sort()\n",
    ),
    (
        "review F2 sort through a body local alias",
        "import { BASE } from './base'\nfunction f() {\n  const l = BASE\n  return l.sort()\n}\nexport const s = f()\n",
    ),
    // Review F3: a local judged data before a later assignment in the same loop or from a callback.
    (
        "review F3 loop-carried local",
        "function f() {\n  let g = undefined\n  for (const i of [1, 2]) {\n    [2, 1].sort(g)\n    g = () => {\n      (globalThis as any).hit = 1\n      return 0\n    }\n  }\n  return 1\n}\nexport const r = f()\n",
    ),
    (
        "review F3 a callback assigning its function's local",
        "function f() {\n  let g = undefined\n  const xs = [1, 2].map((i) => {\n    [2, 1].sort(g)\n    g = () => {\n      (globalThis as any).hit = 1\n      return 0\n    }\n    return i\n  })\n  return xs\n}\nexport const r = f()\n",
    ),
    (
        "review F3 a two-step loop chain",
        "function f() {\n  let a = undefined\n  let b = undefined\n  for (const i of [1, 2, 3]) {\n    [2, 1].sort(a)\n    a = b\n    b = () => {\n      (globalThis as any).hit = 1\n      return 0\n    }\n  }\n  return 1\n}\nexport const r = f()\n",
    ),
    (
        "D3 a method of a local read from a global",
        "function f() {\n  const r = (globalThis as any).list\n  return r.map((x: number) => x)\n}\nexport const xs = f()\n",
    ),
    (
        "D3 a method of a local that was given a global",
        "function f() {\n  let r = ['a']\n  r = (globalThis as any).list\n  return r.map((x: string) => x)\n}\nexport const xs = f()\n",
    ),
    (
        "D3 a member of an imported value",
        "import { s } from './other'\nexport const xs = (s as any).items.map((x: number) => x)\n",
    ),
    // D1
    (
        "D1 shadowed Set",
        "class Set {\n  constructor() {\n    (globalThis as any).hit = 1\n  }\n}\nexport const s = new Set()\n",
    ),
    (
        "D1 shadowed Set by an import",
        "import { Set } from './other'\nexport const s = new Set()\n",
    ),
    (
        "D1 new Set of an unproven import",
        "import { k } from './other'\nexport const s = new Set(k as any)\n",
    ),
    (
        "D1 new Set of a call result",
        "import { list } from 'some-pkg'\nexport const s = new Set(list())\n",
    ),
    (
        "D1 WeakMap with an argument",
        "const k = {}\nexport const w = new WeakMap([[k, 1]])\n",
    ),
    (
        "D1 add on a module Set at top level",
        "const S = new Set<string>()\nexport const T = S.add('a')\n",
    ),
    (
        "D1 new of another global",
        "export const e = new TextEncoder()\n",
    ),
    // D2
    (
        "D2 spread of a call result",
        "function list() {\n  return [1]\n}\nconst g = (globalThis as any).list\nexport const xs = [...g()]\n",
    ),
    (
        "D2 spread of an imported value of unknown shape",
        "import { s } from './other'\nexport const xs = [...s]\n",
    ),
    (
        "D2 spread of an array holding an imported value then joined",
        "import { k } from './other'\nconst XS = [k]\nexport const J = [...XS]\n",
    ),
    (
        "D2 object spread of an imported object",
        "import { O } from './obj'\nexport const o = { ...O, a: 1 }\n",
    ),
    (
        "D2 object spread of a call result",
        "import { make } from 'some-pkg'\nexport const o = { ...make() }\n",
    ),
    (
        "D2 a getter in a spread object",
        "export const o = { ...{ get a() {\n  (globalThis as any).hit = 1\n  return 1\n} } }\n",
    ),
    (
        "D2 imported array built by code",
        "import { BUILT } from './built'\nexport const xs = [...BUILT]\n",
    ),
    // D3
    (
        "D3 callback writing a module let",
        "let n = 0\nconst XS = [1]\nexport const YS = XS.map((x) => {\n  n = x\n  return x\n})\n",
    ),
    (
        "D3 callback calling a package",
        "import { track } from 'some-pkg'\nconst XS = [1]\nexport const YS = XS.map((x) => track(x))\n",
    ),
    (
        "D3 callback writing through its element",
        "const XS = [{ a: 1 }]\nexport const YS = XS.map((x) => {\n  x.a = 2\n  return x\n})\n",
    ),
    (
        "D3 sort on an imported array",
        "import { s } from './other'\nexport const xs = (s as any).sort()\n",
    ),
    (
        "D3 method with a callback that is not inline",
        "const f = (x: number) => x\nconst XS = [1]\nexport const YS = XS.map(f)\n",
    ),
    (
        "D3 callback with this",
        "const XS = [1]\nexport const YS = XS.map(function (this: any, x) {\n  return this.k + x\n})\n",
    ),
    (
        "D3 an imported value inside a joined array",
        "import { k } from './other'\nconst XS = ['a']\nexport const J = XS.concat(k as any)\n",
    ),
    (
        "D3 a mutating method not in the list",
        "const XS = [1]\nexport const N = XS.push(2)\n",
    ),
    // D4
    (
        "D4 a function writing a module binding",
        "let count = 0\nfunction bump() {\n  count += 1\n  return count\n}\nexport const FIRST = bump()\n",
    ),
    (
        "D4 a recursive function",
        "function f(n: number): number {\n  if (n > 0) return f(n - 1)\n  return 0\n}\nexport const N = f(2)\n",
    ),
    (
        "D4 a function calling a package with a function",
        "import { onReady } from 'some-pkg'\nfunction setup() {\n  return onReady(() => {})\n}\nexport const off = setup()\n",
    ),
    (
        "D4 a function calling a package with data",
        "import { make } from 'some-pkg'\nfunction setup() {\n  return make(1)\n}\nexport const x = setup()\n",
    ),
    (
        "D4 a function handed a function",
        "const run = (f: () => number) => 1\nexport const x = run(() => 1)\n",
    ),
    (
        "D4 a function handed an imported value",
        "import { k } from './other'\nconst s = (v: unknown) => `${v}`\nexport const x = s(k)\n",
    ),
    (
        "D4 a function reading arguments",
        "function f() {\n  return arguments.length\n}\nexport const n = f()\n",
    ),
    (
        "D4 a function with a try",
        "function f() {\n  try {\n    return 1\n  } catch {\n    return 0\n  }\n}\nexport const n = f()\n",
    ),
    (
        "D4 an async function",
        "async function f() {\n  return 1\n}\nexport const p = f()\n",
    ),
    (
        "D4 a function with a while loop",
        "function f() {\n  let n = 0\n  while (n < 2) n++\n  return n\n}\nexport const n = f()\n",
    ),
    (
        "D4 for…of over an unproven value",
        "import { s } from './other'\nfunction f() {\n  let n = 0\n  for (const x of s as any) n += 1\n  return n\n}\nexport const n = f()\n",
    ),
    (
        "D4 an imported app function",
        "import { setup } from './setup'\nexport const x = setup()\n",
    ),
    // D5 is dropped (plan drop rule): Array.from of an iterable stays refused
    (
        "D5 dropped: Array.from of an array",
        "export const xs = Array.from([1, 2], (x) => x * 2)\n",
    ),
    // rule 1 only crosses primitives
    (
        "rule 1 imported object in a template",
        "import { O } from './obj'\nexport const s = `${O}`\n",
    ),
];

fn f597_tree(src: &str) -> Vec<String> {
    clean_of(&[
        ("lib/m.ts", src),
        ("lib/setup.ts", "export function setup() {}\n"),
        (
            "lib/other.ts",
            "export const k = 1\nexport const s = new Set([1])\nexport class Set {}\n",
        ),
        ("lib/site.ts", "export const SITE = 'https://example.com'\n"),
        ("lib/base.ts", "export const BASE = ['a', 'b']\n"),
        ("lib/built.ts", "export const BUILT = ['a'].map((x) => x)\n"),
        (
            "lib/obj.ts",
            "export const O = { toString() {\n  return 'x'\n} }\n",
        ),
    ])
}

#[test]
fn f597_every_accepted_form() {
    let bad: Vec<&str> = F597_ACCEPTED
        .iter()
        .filter(|(_, src)| !f597_tree(src).contains(&"lib/m.ts".to_string()))
        .map(|(what, _)| *what)
        .collect();
    assert!(bad.is_empty(), "refused but should be accepted: {bad:?}");
}

#[test]
fn f597_every_refused_form() {
    let bad: Vec<&str> = F597_REFUSED
        .iter()
        .filter(|(_, src)| f597_tree(src).contains(&"lib/m.ts".to_string()))
        .map(|(what, _)| *what)
        .collect();
    assert!(bad.is_empty(), "accepted but should be refused: {bad:?}");
}
