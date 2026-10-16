//! F230 (closes F219): the build-wide scan for writes into another app module's exports, and the `module-written`
//! fallback of a component that reads one.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::analyze::load_writes::{LoadWrites, scan};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::sync::Arc;

/// Writes `files` into a fresh app root and scans them all.
fn app(name: &str, files: &[(&str, &str)]) -> (std::path::PathBuf, LoadWrites) {
    let root =
        std::env::temp_dir().join(format!("brust-load-writes-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, text) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let paths: Vec<String> = files.iter().map(|(p, _)| p.to_string()).collect();
    let opts = AnalyzeOptions {
        root: root.clone(),
        ..Default::default()
    };
    let lw = run_on_compiler_thread(move || scan(&paths, &opts));
    (root, lw)
}

fn written(lw: &LoadWrites) -> Vec<String> {
    let mut v: Vec<String> = lw.written.keys().map(|(m, e)| format!("{m}#{e}")).collect();
    v.sort();
    v
}

const B: &str = "export const LABELS = { a: 'one' }\nexport const list: string[] = ['x']\nexport const other = { b: 1 }\n";

#[test]
fn member_writes_mutating_calls_and_aliases_through_an_import() {
    let (_, lw) = app(
        "writes",
        &[
            ("b.ts", B),
            (
                "c.ts",
                "import { LABELS, list } from './b'\nLABELS.a = 'patched'\nconst l = list\nl.push('y')\n",
            ),
        ],
    );
    assert_eq!(written(&lw), ["b.ts#LABELS", "b.ts#list"]);
    assert_eq!(lw.writers, [("c.ts".to_string(), vec!["b.ts".to_string()])]);
}

#[test]
fn an_import_handed_to_app_code_or_to_a_writing_global() {
    let (_, lw) = app(
        "handed",
        &[
            ("b.ts", B),
            ("reg.ts", "export function register(o: any) { o.x = 1 }\n"),
            (
                "c.ts",
                "import { LABELS, list, other } from './b'\nimport { register } from './reg'\nregister(LABELS)\nObject.assign(other, { b: 2 })\nconsole.log(list)\n",
            ),
        ],
    );
    // `console.log(list)` hands it to a global that does not write.
    assert_eq!(written(&lw), ["b.ts#LABELS", "b.ts#other"]);
}

#[test]
fn reads_are_not_writes() {
    let (_, lw) = app(
        "reads",
        &[
            ("b.ts", B),
            (
                "fmt.ts",
                "export const fmt = (s: string) => s.toUpperCase()\n",
            ),
            (
                "a.tsx",
                "import { LABELS, list } from './b'\nimport { fmt } from './fmt'\nexport default function A() { return <p>{fmt(LABELS.a)} {list.join(',')} {JSON.stringify(LABELS)}</p> }\n",
            ),
        ],
    );
    assert!(lw.is_empty(), "{:?}", lw.written);
    assert!(lw.writers.is_empty());
}

#[test]
fn a_namespace_import_writes_every_export() {
    let (_, lw) = app(
        "namespace",
        &[
            ("b.ts", B),
            ("c.ts", "import * as B from './b'\nB.LABELS.a = 'x'\n"),
        ],
    );
    assert_eq!(written(&lw), ["b.ts#*"]);
    assert!(lw.why("b.ts", "list").is_some());
}

#[test]
fn a_write_inside_a_function_counts_but_does_not_make_a_load_writer() {
    let (_, lw) = app(
        "function",
        &[
            ("b.ts", B),
            (
                "c.ts",
                "import { LABELS } from './b'\nexport function later() { LABELS.a = 'later' }\n",
            ),
        ],
    );
    // `later` reads the written export too (its code names it), so it is written as well.
    assert_eq!(written(&lw), ["b.ts#LABELS", "c.ts#later"]);
    assert!(lw.writers.is_empty(), "{:?}", lw.writers);
}

#[test]
fn values_derived_from_a_written_export_and_re_exports_are_written() {
    let (_, lw) = app(
        "derived",
        &[
            ("b.ts", B),
            (
                "c.ts",
                "import { LABELS } from './b'\nLABELS.a = 'patched'\n",
            ),
            (
                "d.ts",
                "import { LABELS } from './b'\nconst first = LABELS.a\nexport const label = first + '!'\nexport function getLabel() { return LABELS.a }\nexport const plain = 1\n",
            ),
            (
                "index.ts",
                "export { LABELS as L } from './b'\nexport * from './d'\n",
            ),
        ],
    );
    assert_eq!(
        written(&lw),
        [
            "b.ts#LABELS",
            "d.ts#getLabel",
            "d.ts#label",
            "index.ts#L",
            "index.ts#getLabel",
            "index.ts#label"
        ]
    );
}

#[test]
fn package_imports_are_not_scanned() {
    let (_, lw) = app(
        "package",
        &[(
            "c.ts",
            "import { LABELS } from 'some-pkg'\nLABELS.a = 'x'\n",
        )],
    );
    assert!(lw.is_empty(), "{:?}", lw.written);
}

#[test]
fn the_json_the_build_hands_every_compile_round_trips() {
    let (_, lw) = app(
        "json",
        &[
            ("b.ts", B),
            ("c.ts", "import { list } from './b'\nlist.push('y')\n"),
        ],
    );
    let back = LoadWrites::from_json(&lw.to_json()).unwrap();
    assert_eq!(written(&back), written(&lw));
    assert_eq!(back.writers, lw.writers);
    assert!(!back.writers.is_empty());
}

fn diags(root: &std::path::Path, file: &str, lw: Option<LoadWrites>) -> Vec<String> {
    let opts = AnalyzeOptions {
        root: root.to_path_buf(),
        load_writes: lw.map(Arc::new),
        ..Default::default()
    };
    let file = file.to_string();
    run_on_compiler_thread(move || {
        compile_tree(
            &file,
            None,
            &opts,
            brust_compiler::lower::DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .iter()
        .flat_map(|l| {
            l.ir.diagnostics
                .iter()
                .map(|d| d.rule.clone())
                .collect::<Vec<_>>()
        })
        .collect()
    })
}

/// The fallback: a component that reads a written export (folded or in its chunk) renders with React; without the
/// scan, or for an export nobody writes, it stays compiled.
#[test]
fn a_component_reading_a_written_export_falls_back() {
    let files = [
        ("b.ts", B),
        (
            "c.ts",
            "import { LABELS, list } from './b'\nLABELS.a = 'patched'\nlist.push('y')\n",
        ),
        (
            "Fold.tsx",
            "import { LABELS } from './b'\nexport default function Fold() { return <p>{LABELS.a}</p> }\n",
        ),
        (
            "Chunk.tsx",
            "import { useState } from 'react'\nimport { list } from './b'\nexport default function Chunk() { const [n, setN] = useState(0); return <p onClick={() => setN(n + list.length)}>{n}</p> }\n",
        ),
        (
            "Helper.tsx",
            "import { LABELS } from './b'\nconst label = () => LABELS.a\nexport default function Helper() { return <p>{label()}</p> }\n",
        ),
        (
            "Clean.tsx",
            "import { other } from './b'\nexport default function Clean() { return <p>{other.b}</p> }\n",
        ),
    ];
    let (root, lw) = app("fallback", &files);
    for f in ["Fold.tsx", "Chunk.tsx", "Helper.tsx"] {
        assert!(
            diags(&root, f, Some(lw.clone())).contains(&"module-written".to_string()),
            "{f}"
        );
        assert!(
            !diags(&root, f, None).contains(&"module-written".to_string()),
            "{f}"
        );
    }
    assert!(!diags(&root, "Clean.tsx", Some(lw)).contains(&"module-written".to_string()));
}

/// A value made by package code (a store) changed through its own methods is what it is for (the website's team demo:
/// `team.members.set(next)`); an assignment into it still counts.
#[test]
fn a_package_made_value_changed_through_its_methods_is_not_written() {
    let (_, lw) = app(
        "package-made",
        &[
            (
                "store.ts",
                "import { defineStore, signal } from '@brust/core/store'\nexport const team = defineStore('team', () => ({ members: signal([]) }))\nexport const box = defineStore('box', () => ({ n: signal(0) }))\n",
            ),
            (
                "client.ts",
                "import { team, box } from './store'\nexport function save(next: any[]) { team.members.set(next) }\nbox.label = 'patched'\n",
            ),
        ],
    );
    assert_eq!(written(&lw), ["store.ts#box"]);
}

/// The pokedex team client: a call's result handed to a local function is not the import it was called on.
#[test]
fn a_call_result_handed_on_is_not_the_import() {
    let (_, lw) = app(
        "call-result",
        &[
            (
                "api.ts",
                "import { client } from '@brust/core/client'\nexport const api = client()\nexport const raw = { n: 1 }\n",
            ),
            (
                "c.ts",
                "import { api, raw } from './api'\nconst apply = (r: any) => { r.seen = true }\nexport async function add(id: number) { const r = await api.team.post({ id }); apply(r) }\nconst alias = raw\napply(alias)\n",
            ),
        ],
    );
    // `alias` IS `raw` (a flow), but a hand-off is counted for the import itself only; nothing writes `api`.
    assert!(lw.why("api.ts", "api").is_none(), "{:?}", lw.written);
}

/// A computed value (a call's result, a copy) changed afterwards is not the import's object.
#[test]
fn a_computed_value_changed_afterwards_is_not_a_write() {
    let (_, lw) = app(
        "computed",
        &[
            ("b.ts", B),
            (
                "c.ts",
                "import { list, LABELS } from './b'\nconst sorted = list.slice()\nsorted.sort()\nconst r = Object.keys(LABELS)\nr.push('z')\nconst same = LABELS ?? {}\nsame.a = 'x'\n",
            ),
        ],
    );
    // Only the alias `same` (LABELS itself) is a write.
    assert_eq!(written(&lw), ["b.ts#LABELS"]);
}

/// The pokedex layout loader: `team.max.set(MAX_TEAM)` hands a primitive to a store's own method.
#[test]
fn a_primitive_or_a_package_method_argument_is_not_written() {
    let (_, lw) = app(
        "primitive",
        &[
            (
                "team.ts",
                "export const MAX_TEAM = 6\nexport const CAPS = { n: 6 }\n",
            ),
            (
                "store.ts",
                "import { defineStore, signal } from '@brust/core/store'\nexport const team = defineStore('team', () => ({ max: signal(0), caps: signal({}) }))\n",
            ),
            (
                "loaders.ts",
                "import { MAX_TEAM, CAPS } from './team'\nimport { team } from './store'\nimport { keep } from './keep'\nexport function layoutLoader() { team.max.set(MAX_TEAM); team.caps.set(CAPS); keep(CAPS) }\n",
            ),
            (
                "keep.ts",
                "export function keep(o: any) { o.kept = true }\n",
            ),
        ],
    );
    // `keep(CAPS)` hands the object to app code: that one counts.
    assert_eq!(written(&lw), ["loaders.ts#layoutLoader", "team.ts#CAPS"]);
}

/// F2 (Mellow, round 1): only code that runs where it stands at load makes a writer: a write in a handler object, a
/// class method or a nested function does not; one in an immediately-invoked function or a static block does.
#[test]
fn a_load_writer_writes_where_its_statement_stands() {
    let (_, lw) = app(
        "depth0",
        &[
            ("b.ts", B),
            (
                "o.ts",
                "export const LABELS2 = { a: 1 }\nexport const LABELS3 = { a: 1 }\n",
            ),
            (
                "handlers.ts",
                "import { LABELS, list } from './b'\nexport const handlers = { onClick() { LABELS.a = 'x' } }\nexport class K { m() { list.push('y') } }\nconst later = [() => { LABELS.a = 'z' }]\n",
            ),
            (
                "iife.ts",
                "import { LABELS2, LABELS3 } from './o'\n;(() => { LABELS2.a = 2 })()\nclass S { static { LABELS3.a = 3 } }\n",
            ),
        ],
    );
    // Every write counts for the fallback; only the ones that run at load make a writer the build ships.
    assert!(lw.why("b.ts", "LABELS").is_some() && lw.why("b.ts", "list").is_some());
    assert_eq!(
        lw.writers,
        [("iife.ts".to_string(), vec!["o.ts".to_string()])]
    );
}
