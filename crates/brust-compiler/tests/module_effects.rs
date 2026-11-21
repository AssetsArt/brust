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

// ---- the writer rule is base's (AMENDMENT 4; F564 D2 is ledger row F587) ----

#[test]
fn the_writer_rule_refuses_what_base_refuses_including_every_review_probe() {
    for (decls, why) in [
        (
            "const LIST = ['a']\nexport function add(x: string) { LIST.push(x) }",
            "this module's function `add` (line 3) may change a module binding: `LIST.push(…)`",
        ),
        (
            "const LIST = ['a']\nfunction getList() { return LIST }\nexport function add(x: string) { getList().push(x) }",
            "this module's function `add` (line 4) may change a module binding: `getList(…).push(…)`",
        ),
        // review F1
        (
            "const LIST = ['a']\nfunction getList() { const l = LIST; return l }\nexport function add(x: string) { getList().push(x) }",
            "may change a module binding: `getList(…).push(…)`",
        ),
        // review F3 (g1, g4, a copy's element)
        (
            "const LIST = ['a']\nconst B = ['b']\nexport function add(kind: 'a' | 'b', x: string) { ({ a: LIST, b: B })[kind].push(x) }",
            "may change a module binding",
        ),
        (
            "const LIST = ['a']\nconst B = ['b']\nexport function add(i: number, x: string) { [LIST, B][i].push(x) }",
            "may change a module binding",
        ),
        (
            "const LIST = ['a']\nconst LISTS = [LIST]\nexport function add(x: string) { LISTS.slice()[0].push(x) }",
            "may change a module binding",
        ),
        (
            "const LIST = ['a']\nconst LISTS = [LIST]\nexport function add(x: string) { [...LISTS][0].push(x) }",
            "may change a module binding",
        ),
        (
            "const LIST = ['a']\nconst LISTS = [LIST]\nexport function add(x: string) { LISTS.map((l) => l)[0].push(x) }",
            "may change a module binding",
        ),
        // review F4 (g2, g3) and the destructured local
        (
            "const LIST = ['a']\nfunction getList(l = LIST) { return l }\nexport function add(x: string) { getList().push(x) }",
            "may change a module binding",
        ),
        (
            "const LIST = ['a']\nfunction getList() { for (const l of [LIST]) return l; return [] }\nexport function add(x: string) { getList().push(x) }",
            "may change a module binding",
        ),
        (
            "const LIST = ['a']\nfunction getList() { const { l } = { l: LIST }; return l }\nexport function add(x: string) { getList().push(x) }",
            "may change a module binding",
        ),
        // the census writer cases stay refused: a conditional callee, a module arrow over an import, `new Array(n).fill`
        (
            "const LIST = ['a']\nexport function rm(c: boolean, id: string) { (c ? actions.a : actions.b)({ id }).delete(id) }",
            "may change a module binding: `…(…).delete(…)`",
        ),
        (
            "const LIST = ['a']\nconst wrap = (id: string) => api(id)\nexport function rm(id: string) { wrap(id).delete(id) }",
            "may change a module binding: `wrap(…).delete(…)`",
        ),
        (
            "const LIST = ['a']\nexport function zeros(n: number) { return new Array(n).fill(0) }",
            "may change a module binding",
        ),
        (
            "const LIST = ['a']\nlet seq = 0\nexport function next() { seq = seq + 1; return seq }",
            "this module's `let` / `var` `seq` (line 3)",
        ),
    ] {
        refused(&reading(decls), "module-side-effect", why);
    }
}

#[test]
fn the_writer_rule_accepts_what_base_accepts() {
    // a receiver rooted at an import or a local (base; the local-alias forms are open, ledger F587), and a top-level copy
    for decls in [
        "const LIST = ['a']\nexport function rm(id: string) { api(id).delete(id) }",
        "const LIST = ['a']\nexport function last() { return [...LIST].reverse()[0] }",
        "const LIST = ['a']\nexport function m(k: string) { const r = api(k); r.delete(k) }",
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
