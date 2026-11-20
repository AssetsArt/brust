//! F564: what `module-side-effect` proves runs nothing at module load (D1), when a mutating method writes a module
//! binding (D2), and what the finding says (D3).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::{ComponentIR, DiagClass, Tier};
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn write_tree(files: &[(&str, &str)]) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("brustc-f564-{}-{n}", std::process::id()));
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

fn fallbacks(ir: &ComponentIR) -> Vec<(String, String)> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| (d.rule.clone(), d.message.clone()))
        .collect()
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

const API: &str = "export class Box { constructor(public n: number) {} }\nexport const api = (id: string) => new Map([[id, 1]])\nexport const actions = { a: (x: any) => new Set([x]), b: (x: any) => new Set([x]) }\n";

/// A component in `C.tsx` that reads an import (so the module is judged), after `decls`.
fn reading(decls: &str) -> ComponentIR {
    let c = format!(
        "import {{ api, actions }} from './api'\n{decls}\nexport default function C({{ i }}: {{ i: number }}) {{ return <p>{{api(String(i)).size}}</p> }}\n"
    );
    analyze_tree(&[("api.ts", API), ("C.tsx", &c)])
}

// ---- D2: a mutating method is a write only on a receiver this module may own ----

#[test]
fn a_mutating_call_on_an_imported_call_result_or_a_fresh_copy_is_not_a_write() {
    for decls in [
        // the result of an imported call (the census `.delete()` on an action result)
        "const LIST = ['a']\nexport function rm(id: string) { api(id).delete(id) }",
        // a conditional callee of imported members
        "const LIST = ['a']\nexport function rm(flag: boolean, id: string) { (flag ? actions.a : actions.b)({ id }).delete(id) }",
        // a spread copy, a copying method, `new` of a global
        "const LIST = ['a']\nexport function last() { return [...LIST].reverse()[0] }",
        "const LIST = ['a']\nexport function last() { return LIST.slice().reverse()[0] }",
        "const LIST = ['a']\nexport function m() { const s = new Map(); s.set(1, 2); return s }",
    ] {
        let ir = reading(decls);
        assert!(
            fallbacks(&ir)
                .iter()
                .all(|(r, _)| r != "module-side-effect")
                && !matches!(ir.tier, Tier::React { .. }),
            "{decls}\n{:?}\n{:?}",
            ir.tier,
            ir.diagnostics
        );
    }
}

#[test]
fn a_mutating_call_on_a_receiver_this_module_may_own_stays_a_write() {
    for (decls, why) in [
        (
            "const LIST = ['a']\nexport function add(x: string) { LIST.push(x) }",
            "this module's function `add` (line 3) may change a module binding: `LIST.push(…)`",
        ),
        (
            "const LIST = ['a']\nfunction getList() { return LIST }\nexport function add(x: string) { getList().push(x) }",
            "this module's function `add` (line 4) may change a module binding: `getList(…).push(…)`",
        ),
        (
            "const LIST = ['a']\nconst B = ['b']\nexport function add(c: boolean, x: string) { (c ? LIST : B).push(x) }",
            "this module's function `add` (line 4) may change a module binding: `….push(…)`",
        ),
        // an imported call handed a module object may return it
        (
            "const LIST = ['a']\nexport function rm() { api(LIST as any).delete('a') }",
            "this module's function `rm` (line 3) may change a module binding: `api(…).delete(…)`",
        ),
        (
            "const LIST = ['a']\nlet seq = 0\nexport function next() { seq = seq + 1; return seq }",
            "this module's `let` / `var` `seq` (line 3): its value can change after the module loads",
        ),
    ] {
        refused(&reading(decls), "module-side-effect", why);
    }
}

// ---- D3: the diagnostic names the declaration and its line ----

#[test]
fn the_finding_names_the_declaration_its_line_and_what_was_not_proven() {
    for (decls, why) in [
        (
            "const LIST = ['a']\nexport class K {}",
            "this module's `class K` (line 3) runs code when the module loads",
        ),
        (
            "const LIST = ['a']\nfunction fmt(s: string) { return s }\nconst X = fmt('x')",
            "this module's `const X = …` (line 4) may run code when the module loads: it calls `fmt(…)`",
        ),
        (
            "const LIST = ['a']\nconst X = new Date()",
            "this module's `const X = …` (line 3) may run code when the module loads: it constructs `new Date(…)`",
        ),
        (
            "const LIST = ['a']\nconsole.log(LIST)",
            "this module's statement at line 3 runs code when the module loads",
        ),
        (
            "const LIST = ['a']\nlet n = 0\nexport const bump = () => { n++ }",
            "this module's `let` / `var` `n` (line 3)",
        ),
    ] {
        let ir = reading(decls);
        refused(&ir, "module-side-effect", why);
        assert!(
            fallbacks(&ir)
                .iter()
                .any(|(_, m)| m
                    .contains(". The code brust compiles copies the module's declarations")),
            "{:?}",
            ir.diagnostics
        );
    }
}

#[test]
fn a_local_const_is_judged_by_its_value_and_no_module_function_is_followed() {
    for (decls, why) in [
        (
            "const LIST = ['a']\nexport function add(x: string) { const l = LIST; l.push(x) }",
            "this module's function `add` (line 3) may change a module binding: `l.push(…)`",
        ),
        (
            "const LIST = ['a']\nconst get = () => LIST\nexport function add(x: string) { get().push(x) }",
            "this module's function `add` (line 4) may change a module binding: `get(…).push(…)`",
        ),
        // AMENDMENT 3: function following is withdrawn; a call of this module's function is a write
        (
            "const LIST = ['a']\nconst wrap = (id: string) => api(id)\nexport function rm(id: string) { wrap(id).delete(id) }",
            "this module's function `rm` (line 4) may change a module binding: `wrap(…).delete(…)`",
        ),
    ] {
        refused(&reading(decls), "module-side-effect", why);
    }
}

// ---- D1: reads rooted at an app import (lead ruling 5e9842ab) ----

const ICONS: &str = "export const ICON = { overview: 'o', apps: 'a' }\nexport const TABLE = [{ label: 'x', n: 1 }]\nexport const MAX_INSTANCES = 6\nexport default { home: 'h' }\n";

/// `C.tsx` importing from `./icons` (and `./api`), `decls` at module scope, reading an import.
fn with_icons(icons: &str, extra: &[(&str, &str)], imports: &str, decls: &str) -> ComponentIR {
    let c = format!(
        "import {{ api }} from './api'\n{imports}\n{decls}\nexport default function C({{ i }}: {{ i: number }}) {{ return <p>{{api(String(i)).size}}</p> }}\n"
    );
    let mut files: Vec<(&str, &str)> = vec![("api.ts", API), ("icons.ts", icons), ("C.tsx", &c)];
    files.extend_from_slice(extra);
    analyze_tree(&files)
}

#[track_caller]
fn clean(ir: &ComponentIR) {
    assert!(
        fallbacks(ir).iter().all(|(r, _)| r != "module-side-effect"),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn a_data_property_of_an_imported_literal_table_runs_nothing() {
    for (imports, decls) in [
        (
            "import { ICON } from './icons'",
            "const OVERVIEW = { id: 'overview', icon: ICON.overview, path: '/' }",
        ),
        (
            "import { TABLE } from './icons'",
            "const FIRST = { label: TABLE[0].label }",
        ),
        // an alias of an import (2)
        (
            "import { MAX_INSTANCES } from './icons'",
            "const MAX_INST = MAX_INSTANCES",
        ),
        // `export default { … }`: no code of its module can name it
        (
            "import names from './icons'",
            "const HOME = { to: names.home }",
        ),
        // a closure over an accepted const (3)
        (
            "import { ICON } from './icons'",
            "const OVERVIEW = { icon: ICON.overview }\nconst iconOf = () => OVERVIEW.icon",
        ),
    ] {
        clean(&with_icons(ICONS, &[], imports, decls));
    }
    // a re-exported table, through `export … from` and `export *`
    for (path, text) in [
        ("index.ts", "export { ICON } from './icons'\n"),
        ("index.ts", "export * from './icons'\n"),
    ] {
        clean(&with_icons(
            ICONS,
            &[(path, text)],
            "import { ICON } from './index'",
            "const O = { icon: ICON.apps }",
        ));
    }
}

#[test]
fn an_imported_read_that_may_run_code_is_refused_by_name() {
    let refuse = |icons: &str, extra: &[(&str, &str)], imports: &str, decls: &str, read: &str| {
        let ir = with_icons(icons, extra, imports, decls);
        refused(
            &ir,
            "module-side-effect",
            &format!("it reads `{read}`, an imported value brust cannot prove is a plain object"),
        );
    };
    let o = "const O = { icon: ICON.overview }";
    let named = "import { ICON } from './icons'";
    // an accessor on the path
    refuse(
        "export const ICON = { get overview() { return 'o' } }\n",
        &[],
        named,
        o,
        "ICON.overview",
    );
    // a spread before the key, a computed key
    refuse(
        "const BASE = { overview: 'b' }\nexport const ICON = { ...BASE, overview: 'o' }\n",
        &[],
        named,
        o,
        "ICON.overview",
    );
    refuse(
        "const k = 'overview'\nexport const ICON = { [k]: 'o' }\n",
        &[],
        named,
        o,
        "ICON.overview",
    );
    // a write in the exporting module
    refuse(
        "export const ICON = { overview: 'o' }\nexport function swap() { ICON.overview = 'x' }\n",
        &[],
        named,
        o,
        "ICON.overview",
    );
    // a namespace import
    refuse(
        ICONS,
        &[],
        "import * as I from './icons'",
        "const O = { icon: I.ICON.overview }",
        "I.ICON.overview",
    );
    // a step into a value that is not a literal
    refuse(
        "const make = () => ({ x: 1 })\nexport const ICON = { overview: make() }\n",
        &[],
        named,
        "const O = { icon: ICON.overview.x }",
        "ICON.overview.x",
    );
    // a value the module computes
    refuse(
        "export const ICON = Object.freeze({ overview: 'o' })\n",
        &[],
        named,
        o,
        "ICON.overview",
    );
}

#[test]
fn an_imported_table_another_module_writes_at_load_is_refused() {
    use brust_compiler::analyze::load_writes::scan;
    let c = "import { api } from './api'\nimport { ICON } from './icons'\nconst O = { icon: ICON.overview }\nexport default function C({ i }: { i: number }) { return <p>{api(String(i)).size}</p> }\n";
    let files = [
        ("api.ts", API),
        ("icons.ts", ICONS),
        (
            "third.ts",
            "import { ICON } from './icons'\nICON.overview = 'z'\n",
        ),
        ("C.tsx", c),
    ];
    let root = write_tree(&files);
    let paths: Vec<String> = files.iter().map(|(p, _)| p.to_string()).collect();
    let ir = run_on_compiler_thread(move || {
        let mut opts = AnalyzeOptions {
            root,
            ..Default::default()
        };
        opts.load_writes = Some(std::sync::Arc::new(scan(&paths, &opts)));
        analyze_source("C.tsx", c.as_bytes().to_vec(), &opts).unwrap()
    });
    refused(
        &ir,
        "module-side-effect",
        "it reads `ICON.overview`, an imported value brust cannot prove is a plain object",
    );
}

#[test]
fn templates_operators_regex_and_a_primitive_time_table_run_nothing() {
    for (imports, decls) in [
        (
            "",
            "const A = 2\nconst B = `${A}px`\nconst E = A > 1 ? -A : !A\nconst D = A === 2 && typeof A",
        ),
        // the census time table
        (
            "",
            "const TIMES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`)",
        ),
        ("", "const LABEL_RE = /^[a-z0-9-]+$/i"),
        // ToBoolean and `===` of an imported value call nothing
        (
            "import { ICON } from './icons'",
            "const HAS = ICON.overview ? 1 : 0",
        ),
    ] {
        clean(&with_icons(ICONS, &[], imports, decls));
    }
    for (imports, decls, why) in [
        (
            "import { ICON } from './icons'",
            "const T = `${ICON.overview}!`",
            "it converts `ICON.overview`, an imported value, to a string or a number",
        ),
        (
            "import { ICON } from './icons'",
            "const T = ICON + 'x'",
            "it converts `ICON`, an imported value, to a string or a number",
        ),
        (
            "",
            "const RE = /a/g",
            "it holds a global or sticky regex literal",
        ),
        (
            "",
            "const T = Array.from({ length: 3 }, (_, i) => new Date(i))",
            "it calls `Array.from(…)` with more than a length and a primitive callback",
        ),
        (
            "",
            "const xs = [1]\nconst T = Array.from(xs)",
            "it calls `Array.from(…)`",
        ),
    ] {
        refused(
            &with_icons(ICONS, &[], imports, decls),
            "module-side-effect",
            why,
        );
    }
}

#[test]
fn a_const_read_before_it_is_declared_is_refused() {
    for (decls, why) in [
        (
            "const A = B + 1\nconst B = api",
            "this module's `const A = …` (line 3) may run code when the module loads: it reads `B` before it is declared",
        ),
        (
            "const A = [B]\nconst B = api",
            "it reads `B` before it is declared",
        ),
        ("const A = { b: A }", "it reads `A` before it is declared"),
    ] {
        refused(
            &with_icons(ICONS, &[], "", decls),
            "module-side-effect",
            why,
        );
    }
    // (pre-existing, not this rule: the folder folds `const A = B + 1; const B = 2` to 3 regardless of order)
    // a function reading a later const runs only when called
    clean(&with_icons(
        ICONS,
        &[],
        "",
        "const f = () => B\nconst B = 2",
    ));
}

#[test]
fn a_local_that_holds_values_from_module_code_is_not_the_module_object() {
    // a Reed-Solomon remainder: `r` is a fresh array that HOLDS products a module function computes
    let base = "const EXP = [1, 2]\nfunction gfMul(a: number, b: number) { return a === 0 || b === 0 ? 0 : EXP[a + b] }\n";
    let d = format!(
        "{base}export function rs(data: number[], divisor: number[]) {{ const r = divisor.map(() => 0); for (const b of data) {{ const f = b ^ (r.shift() as number); r.push(0); divisor.forEach((c, i) => (r[i] ^= gfMul(c, f))) }} return r }}"
    );
    clean(&reading(&d));
    // a const holding what a module function returns, or an alias of a module array, is that object
    for (decls, why) in [
        (
            "const LIST = ['a']\nconst get = () => LIST\nexport function add(x: string) { const l = get(); l.push(x) }",
            "this module's function `add` (line 4) may change a module binding: `l.push(…)`",
        ),
        (
            "const LIST = ['a']\nexport function set(x: string) { const l = LIST; l[0] = x }",
            "this module's function `set` (line 3) writes through `l`, a local that holds a module object",
        ),
        (
            "const LIST = ['a']\nexport function add(x: string) { const o = { l: LIST }; o.l.push(x) }",
            "this module's function `add` (line 3) may change a module binding: `o.l.push(…)`",
        ),
    ] {
        refused(&reading(decls), "module-side-effect", why);
    }
}

#[test]
fn values_stored_into_a_local_or_computed_from_module_tables_are_not_module_objects() {
    for decls in [
        // a copy taken with arguments computed from module tables
        "const LIST = ['a']\nconst SIZES = [2, 3]\nexport function cut(data: number[], v: number) { const n = SIZES[v]; const part = data.slice(0, Math.floor(n / 2)); part.push(0); return part }",
        // a module string stored into a fresh element's member
        "const LIST = ['a']\nconst URL = '/x.js'\nexport function load() { const s = document.createElement('script'); s.src = URL; s.async = true; return s }",
        // an instance of an imported class kept in a holder, then cleared
        "import { Box } from './api'\nconst LIST = ['a']\nexport function keep(holder: { current: unknown }) { const b = new Box(LIST.length); holder.current = b; holder.current = null }",
    ] {
        let ir = reading(decls);
        assert!(
            fallbacks(&ir)
                .iter()
                .all(|(r, _)| r != "module-side-effect"),
            "{decls}\n{:?}",
            ir.diagnostics
        );
    }
}

#[test]
fn a_call_handed_a_primitive_const_or_a_package_made_hook_returns_no_module_object() {
    // the Radix shape: a context hook taken from package code, called with a module string, its value changed
    let decls = "import { createContextScope } from '@radix-ui/react-context'\nconst LIST = ['a']\nconst NAME = 'Thumb'\nconst [createCtx] = createContextScope('S')\nconst [Provider, useCtx] = createCtx<any>('S')\nexport function useThumb(scope: any, el: any) { const context = useCtx(NAME, scope); context.thumbs.add(el) }";
    let ir = reading(decls);
    assert!(
        fallbacks(&ir)
            .iter()
            .all(|(r, _)| r != "module-side-effect"),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn an_instance_of_a_global_member_class_is_fresh() {
    let decls = "const LIST = ['a']\nexport function load(src: string) { const image = new window.Image(); image.src = src; return image }";
    let ir = reading(decls);
    assert!(
        fallbacks(&ir)
            .iter()
            .all(|(r, _)| r != "module-side-effect"),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn review_round_1_a_returned_local_alias_and_a_shadowed_star_export_are_refused() {
    // F1: a module function returning a LOCAL alias of a module object is not followed
    for decls in [
        "const LIST = ['a']\nfunction getList() { const l = LIST; return l }\nexport function add(x: string) { getList().push(x) }",
        "const LIST = ['a']\nfunction getList() { let l: string[] = []; l = LIST; return l }\nexport function add(x: string) { getList().push(x) }",
        "const LIST = ['a']\nfunction getBox() { return { l: LIST } }\nexport function add(x: string) { getBox().l.push(x) }",
    ] {
        refused(
            &reading(decls),
            "module-side-effect",
            "this module's function `add` (line 4) may change a module binding",
        );
    }
    // F2: a module's own export of the name shadows `export *`
    let a = "function make() { let n = 0; return { get overview() { n++; return 'x' + n } } }\nexport const ICON = make()\nexport * from './b'\n";
    let b = "export const ICON = { overview: 'o' }\n";
    let ir = with_icons(
        ICONS,
        &[("a.ts", a), ("b.ts", b)],
        "import { ICON } from './a'",
        "const O = { icon: ICON.overview }",
    );
    refused(
        &ir,
        "module-side-effect",
        "it reads `ICON.overview`, an imported value brust cannot prove is a plain object",
    );
    // … and a name the module does not declare still follows `export *`
    clean(&with_icons(
        ICONS,
        &[
            ("a.ts", "export const OTHER = 1\nexport * from './b'\n"),
            ("b.ts", b),
        ],
        "import { ICON } from './a'",
        "const O = { icon: ICON.overview }",
    ));
}

// ---- AMENDMENT 3: every review probe refused, the grammar's accepted forms, the module-wide guard ----

#[test]
fn every_review_probe_is_a_write() {
    for decls in [
        // f1, f1c
        "const LIST = ['a']\nfunction getList() { const l = LIST; return l }\nexport function add(x: string) { getList().push(x) }",
        "const LIST = ['a']\nfunction getList() { return LIST }\nexport function add(x: string) { getList().push(x) }",
        // g1, g4: a literal reached through an index
        "const LIST = ['a']\nconst B = ['b']\nexport function add(kind: 'a' | 'b', x: string) { ({ a: LIST, b: B })[kind].push(x) }",
        "const LIST = ['a']\nconst B = ['b']\nexport function add(i: number, x: string) { [LIST, B][i].push(x) }",
        // by reading: a copy's element is the same object
        "const LIST = ['a']\nconst LISTS = [LIST]\nexport function add(x: string) { LISTS.slice()[0].push(x) }",
        "const LIST = ['a']\nconst LISTS = [LIST]\nexport function add(x: string) { [...LISTS][0].push(x) }",
        "const LIST = ['a']\nconst LISTS = [LIST]\nexport function add(x: string) { LISTS.map((l) => l)[0].push(x) }",
        // g2, g3: a followed function's default parameter / loop binding
        "const LIST = ['a']\nfunction getList(l = LIST) { return l }\nexport function add(x: string) { getList().push(x) }",
        "const LIST = ['a']\nfunction getList() { for (const l of [LIST]) return l; return [] }\nexport function add(x: string) { getList().push(x) }",
        // a destructured local returned
        "const LIST = ['a']\nfunction getList() { const { l } = { l: LIST }; return l }\nexport function add(x: string) { getList().push(x) }",
        // a local const holding a literal with the module object, reached through it
        "const LIST = ['a']\nexport function add(x: string) { const o = { l: LIST }; o.l.push(x) }",
        // an import handed this module's object may hand it back
        "const LIST = ['a']\nexport function rm() { api(LIST as any).delete('a') }",
        "const LIST = ['a']\nexport function rm() { const l = LIST; api(l as any).delete('a') }",
    ] {
        refused(
            &reading(decls),
            "module-side-effect",
            "may change a module binding",
        );
    }
}

#[test]
fn the_grammar_accepts_import_and_global_roots_and_top_level_copies() {
    for decls in [
        "const LIST = ['a']\nexport function rm(id: string) { api(id).delete(id) }",
        "const LIST = ['a']\nexport function rm(c: boolean, id: string) { (c ? actions.a : actions.b)({ id }).delete(id) }",
        "const LIST = ['a']\nexport function last() { return [...LIST].reverse()[0] }",
        "const LIST = ['a']\nexport function m(k: string) { new Map(actions.a(k) as any).set(k, 1) }",
        "const LIST = ['a']\nexport function m(k: string) { const r = api(k); r.delete(k) }",
        "const LIST = ['a']\nexport function m() { const s = document.createElement('script'); s.src = '/x'; return s }",
    ] {
        let ir = reading(decls);
        assert!(
            fallbacks(&ir)
                .iter()
                .all(|(r, _)| r != "module-side-effect"),
            "{decls}\n{:?}",
            ir.diagnostics
        );
    }
}

#[test]
fn a_module_that_hands_its_object_to_an_import_has_no_clean_import_call_results() {
    // the guard: elsewhere in the module, LIST is handed to an import (a registry could hand it back)
    let guarded = "const LIST = ['a']\nexport function reg() { actions.a(LIST) }\nexport function rm(id: string) { api(id).delete(id) }";
    refused(
        &reading(guarded),
        "module-side-effect",
        "may change a module binding: `api(…).delete(…)`",
    );
    // without the hand-off the same call is clean
    let ir = reading(
        "const LIST = ['a']\nexport function reg() { actions.a('x') }\nexport function rm(id: string) { api(id).delete(id) }",
    );
    assert!(
        fallbacks(&ir)
            .iter()
            .all(|(r, _)| r != "module-side-effect"),
        "{:?}",
        ir.diagnostics
    );
}
