//! F615: a record's condition over a prop the call site omits. `Parent({ items, side = NO_SIDE })` renders
//! `side.on ? <div><List/></div> : <List/>`; under `List` sits a REAL React island (a hook the compiler does not lower),
//! whose server job is a record of the page. A page renders `<Parent items />` without `side`, next to a `<Dynamic>`.
//! The omitted prop has a known value (its default as the lowering prints it, `undefined` without one): a record whose
//! condition is false there is a placeholder the server never runs (the template still prints that branch), a true one has
//! no condition, anything the folder does not know is refused as before (`its child has a job under a condition the
//! server cannot evaluate per row`).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::analyze::load_writes::scan;
use brust_compiler::ir::Diagnostic;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};

const ISLAND: &str = "import { useSyncExternalStore } from 'react'\nexport function Island({ id }: { id: string }) {\n  const v = useSyncExternalStore(() => () => {}, () => 1, () => 1)\n  return <i data-id={id}>{v}</i>\n}\n";
const SECTION: &str = "import { Island } from './Island'\nexport function Section({ id }: { id: string }) {\n  return (\n    <section>\n      <Island id={id} />\n    </section>\n  )\n}\n";
const LIST: &str = "import { Section } from './Section'\ntype Item = { id: string; kind: string }\nexport function List({ items }: { items: Item[] }) {\n  return <div>{items.map((i) => <Section key={i.id} id={i.id} />)}</div>\n}\n";
const LIST_KIND: &str = "import { Section } from './Section'\ntype Item = { id: string; kind: string }\nexport function List({ items }: { items: Item[] }) {\n  return <div>{items.map((i) => (i.kind === 'x' ? <Section key={i.id} id={i.id} /> : <b key={i.id}>{i.id}</b>))}</div>\n}\n";

/// `Parent.tsx` with `head` (module scope) and `params` (the props pattern) and `cond` (the branch condition).
fn parent(head: &str, params: &str, cond: &str) -> String {
    format!(
        "import {{ Dynamic }} from '@brust/core'\nimport {{ List }} from './List'\n{head}\ntype Item = {{ id: string; kind: string }}\nexport default function Parent({params}: any) {{\n  return (\n    <main>\n      {{{cond} ? (\n        <div>\n          <List items={{items}} />\n        </div>\n      ) : (\n        <List items={{items}} />\n      )}}\n      <Dynamic component=\"slot.badge\" props={{{{ label: 'x' }}}} />\n    </main>\n  )\n}}\n"
    )
}

/// The page: renders `<Parent items {extra} />` under a condition.
fn page(extra: &str) -> String {
    format!(
        "import Parent from './Parent'\nexport default function P(props: any) {{\n  if (props.show === true && props.items) return <Parent items={{props.items}} {extra} />\n  return <main />\n}}\n"
    )
}

/// The tree compiled from `P.tsx` with the build's load-time write scan (F230) over every file: the root's IR as JSON.
fn compile(files: &[(&str, &str)]) -> Result<Value, Diagnostic> {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brustc-f615-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut paths = Vec::new();
    for (path, text) in files {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
        paths.push(path.to_string());
    }
    let src = files
        .iter()
        .find(|(p, _)| *p == "P.tsx")
        .unwrap()
        .1
        .to_string();
    run_on_compiler_thread(move || {
        let mut opts = AnalyzeOptions {
            root: dir,
            ..Default::default()
        };
        opts.load_writes = Some(std::sync::Arc::new(scan(&paths, &opts)));
        let tree = compile_tree(
            "P.tsx",
            Some(src.into_bytes()),
            &opts,
            DEFAULT_RUNTIME_IMPORT,
        )?;
        Ok(serde_json::to_value(&*tree[0].ir).unwrap())
    })
}

fn tree<'a>(
    p: &'a str,
    parent_src: &'a str,
    list: &'a str,
    more: &[(&'a str, &'a str)],
) -> Vec<(&'a str, &'a str)> {
    let mut v = vec![
        ("Island.tsx", ISLAND),
        ("Section.tsx", SECTION),
        ("List.tsx", list),
        ("Parent.tsx", parent_src),
        ("P.tsx", p),
    ];
    v.extend_from_slice(more);
    v
}

/// The island records of the root: their conditions (`null` = none).
fn island_whens(ir: &Value) -> Vec<Value> {
    assert!(
        ir["tier"] != json!("React") && ir["tier"].get("React").is_none(),
        "the page is a React island: {}",
        ir["tier"]
    );
    ir["instances"]
        .as_array()
        .map(|xs| {
            xs.iter()
                .filter(|r| {
                    r["child_id"]
                        .as_str()
                        .is_some_and(|c| c.starts_with("section_"))
                })
                .map(|r| r.get("when").cloned().unwrap_or(Value::Null))
                .collect()
        })
        .unwrap_or_default()
}

/// F615 (challenge ruling default): a record whose condition is false at this call site is a placeholder that keeps
/// its number (the template still prints the branch and reads its slot there): no loops, every prop `undefined`, `any: []`.
fn split(ir: &Value, whens: Vec<Value>) -> (usize, Vec<Value>) {
    let placeholders = ir["instances"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r.get("when") == Some(&json!({ "any": [] })))
        .inspect(|r| {
            assert_eq!(r["loops"], json!([]), "{r}");
            assert_eq!(r["props"], json!({}), "{r}");
            assert!(r["exprs"].as_object().is_some_and(|e| !e.is_empty()), "{r}");
        })
        .count();
    let live = whens
        .into_iter()
        .filter(|w| *w != json!({ "any": [] }))
        .collect();
    (placeholders, live)
}

fn refused_opaque(r: Result<Value, Diagnostic>) {
    match r {
        Err(d) => assert!(
            d.message.contains(
                "its child has a job under a condition the server cannot evaluate per row"
            ),
            "{d:?}"
        ),
        Ok(ir) => panic!("compiled: {}", ir["instances"]),
    }
}

fn mentions(v: &Value, what: &str) -> bool {
    v.to_string().contains(what)
}

#[test]
fn omitted_with_a_constant_default_false_keeps_only_the_live_branch() {
    let p = page("");
    let par = parent(
        "const NO_SIDE = { on: false }",
        "{ items, side = NO_SIDE }",
        "side.on",
    );
    let ir = compile(&tree(&p, &par, LIST, &[])).unwrap();
    let (placeholders, whens) = split(&ir, island_whens(&ir));
    assert_eq!(placeholders, 1, "{}", ir["instances"]);
    assert_eq!(whens.len(), 1, "{whens:?}");
    assert!(!mentions(&whens[0], "side"), "{whens:?}");
}

#[test]
fn omitted_with_a_constant_default_true_keeps_the_other_branch() {
    let p = page("");
    let par = parent(
        "const NO_SIDE = { on: true }",
        "{ items, side = NO_SIDE }",
        "side.on",
    );
    let ir = compile(&tree(&p, &par, LIST, &[])).unwrap();
    let (placeholders, whens) = split(&ir, island_whens(&ir));
    assert_eq!(placeholders, 1, "{}", ir["instances"]);
    assert_eq!(whens.len(), 1, "{whens:?}");
    assert!(!mentions(&whens[0], "side"), "{whens:?}");
}

#[test]
fn passed_as_a_props_path_rebases_as_before() {
    let p = page("side={props.side}");
    let par = parent(
        "const NO_SIDE = { on: false }",
        "{ items, side = NO_SIDE }",
        "side.on",
    );
    let whens = island_whens(&compile(&tree(&p, &par, LIST, &[])).unwrap());
    assert_eq!(whens.len(), 2, "{whens:?}");
    assert!(whens.iter().all(|w| mentions(w, "side.on")), "{whens:?}");
}

#[test]
fn passed_as_an_inline_literal_is_untouched() {
    // a prop that is passed is never "omitted": today's rebase (an object literal is no props path) and its refusal
    let p = page("side={{ on: false }}");
    let par = parent(
        "const NO_SIDE = { on: false }",
        "{ items, side = NO_SIDE }",
        "side.on",
    );
    refused_opaque(compile(&tree(&p, &par, LIST, &[])));
}

#[test]
fn omitted_without_a_default_is_undefined() {
    let p = page("");
    let par = parent("", "{ items, side }", "side");
    let ir = compile(&tree(&p, &par, LIST, &[])).unwrap();
    let (placeholders, whens) = split(&ir, island_whens(&ir));
    assert_eq!(placeholders, 1, "{}", ir["instances"]);
    assert_eq!(whens.len(), 1, "{whens:?}");
    assert!(!mentions(&whens[0], "side"), "{whens:?}");
}

#[test]
fn a_member_of_an_omitted_prop_without_a_default_is_not_evaluated() {
    let p = page("");
    let par = parent("", "{ items, side }", "side.on");
    refused_opaque(compile(&tree(&p, &par, LIST, &[])));
}

#[test]
fn a_default_the_folder_does_not_fold_is_unknown() {
    let p = page("");
    let call = parent(
        "const makeSide = () => ({ on: false })",
        "{ items, side = makeSide() }",
        "side.on",
    );
    // refused earlier: a call default is no server value at all (`prop-default-shape`), as before
    assert!(compile(&tree(&p, &call, LIST, &[])).is_err());
    let module_let = parent(
        "let NO_SIDE = { on: false }\nexport function flip() {\n  NO_SIDE = { on: true }\n}",
        "{ items, side = NO_SIDE }",
        "side.on",
    );
    // a module `let` is not folded either (`prop-default-shape`), as before
    assert!(compile(&tree(&p, &module_let, LIST, &[])).is_err());
}

#[test]
fn a_default_another_module_writes_is_still_refused() {
    let p = page("");
    let par = parent(
        "export const NO_SIDE = { on: false }",
        "{ items, side = NO_SIDE }",
        "side.on",
    );
    let writer = "import { NO_SIDE } from './Parent'\nNO_SIDE.on = true\n";
    let r = compile(&tree(&p, &par, LIST, &[("writer.ts", writer)]));
    assert!(r.is_err(), "{:?}", r.map(|ir| ir["tier"].clone()));
}

#[test]
fn a_default_written_under_another_export_name_is_still_refused() {
    // F230 keys a write by export name: `export { NS as NO_SIDE }` written as NO_SIDE
    let p = page("");
    let renamed = parent(
        "const NS = { on: false }\nexport { NS as NO_SIDE }",
        "{ items, side = NS }",
        "side.on",
    );
    let writer = "import { NO_SIDE } from './Parent'\n;(NO_SIDE as any).on = true\n";
    let r = compile(&tree(&p, &renamed, LIST, &[("writer.ts", writer)]));
    assert!(r.is_err(), "{:?}", r.map(|ir| ir["instances"].clone()));
}

#[test]
fn a_default_written_as_the_default_export_is_still_refused() {
    // the const is the module's default export, written through a default import: refused
    let p = page("").replace(
        "import Parent from './Parent'",
        "import { Parent } from './Parent'",
    );
    let par = parent(
        "const NS = { on: false }",
        "{ items, side = NS }",
        "side.on",
    )
    .replace("export default function Parent", "export function Parent")
        + "export default NS\n";
    let writer = "import NS from './Parent'\n;(NS as any).on = true\n";
    let r = compile(&tree(&p, &par, LIST, &[("writer.ts", writer)]));
    assert!(r.is_err(), "{:?}", r.map(|ir| ir["instances"].clone()));
    // a const the module exports as its default is never folded into a prop default (`prop-default-shape`), written
    // or not: refused before F615 reads it, as on main
    let err = compile(&tree(&p, &par, LIST, &[])).unwrap_err();
    assert!(err.message.contains("prop-default-shape"), "{err:?}");
}

/// AMENDMENT 2: a write that reaches the default's constant through another name or module is seen (the scan resolves every
/// written key to its declaring export); anything the folder cannot resolve is not folded. Each page is refused, as on
/// main. `extra` = more files, `head` = Parent's module scope, `default` = the prop default.
fn refused_with(head: &str, default: &str, extra: &[(&str, &str)]) {
    let p = page("");
    let par = parent(head, &format!("{{ items, side = {default} }}"), "side.on");
    let r = compile(&tree(&p, &par, LIST, extra));
    assert!(
        r.is_err(),
        "{head} / {default} / {extra:?}: {:?}",
        r.map(|ir| ir["instances"].clone())
    );
}

const WRITE_X: &str = "import { X } from './m'\n;(X as any).on = true\n";
const WRITE_NS_M: &str = "import { NS } from './m'\n;(NS as any).on = true\n";

#[test]
fn a_write_through_a_named_re_export_is_seen() {
    refused_with(
        "const NS = { on: false }\nexport { NS }",
        "NS",
        &[
            ("m.ts", "export { NS } from './Parent'\n"),
            ("w.ts", WRITE_NS_M),
        ],
    );
}

#[test]
fn a_write_through_an_export_star_is_seen() {
    refused_with(
        "export const NS = { on: false }",
        "NS",
        &[("m.ts", "export * from './Parent'\n"), ("w.ts", WRITE_NS_M)],
    );
}

#[test]
fn a_write_through_a_renamed_re_export_is_seen() {
    refused_with(
        "const NS = { on: false }\nexport { NS }",
        "NS",
        &[
            ("m.ts", "export { NS as X } from './Parent'\n"),
            ("w.ts", WRITE_X),
        ],
    );
}

#[test]
fn a_write_through_an_import_then_export_is_seen() {
    refused_with(
        "const NS = { on: false }\nexport { NS }",
        "NS",
        &[
            (
                "m.ts",
                "import { NS } from './Parent'\nexport { NS as X }\n",
            ),
            ("w.ts", WRITE_X),
        ],
    );
}

#[test]
fn a_namespace_member_default_is_not_folded() {
    refused_with(
        "import * as ns from './c'",
        "ns.NS",
        &[
            ("c.ts", "export const NS = { on: false }\n"),
            ("w.ts", "import { NS } from './c'\n;(NS as any).on = true\n"),
        ],
    );
}

#[test]
fn a_local_alias_of_an_import_is_not_folded() {
    refused_with(
        "import { NS as I } from './c'\nconst NS = I",
        "NS",
        &[
            ("c.ts", "export const NS = { on: false }\n"),
            ("w.ts", "import { NS } from './c'\n;(NS as any).on = true\n"),
        ],
    );
}

#[test]
fn a_write_through_a_barrel_of_the_imported_declaring_module_is_seen() {
    // the reverse direction: the component imports the declaring module, the writer the barrel
    refused_with(
        "import { NS } from './c'",
        "NS",
        &[
            ("c.ts", "export const NS = { on: false }\n"),
            ("m.ts", "export { NS } from './c'\n"),
            ("w.ts", WRITE_NS_M),
        ],
    );
}

#[test]
fn a_live_atom_next_to_a_known_one_stays_and_is_rebased() {
    let p = page("");
    let par = parent(
        "const NO_SIDE = { on: true }",
        "{ items, side = NO_SIDE }",
        "side.on",
    );
    let ir = compile(&tree(&p, &par, LIST_KIND, &[])).unwrap();
    let (placeholders, whens) = split(&ir, island_whens(&ir));
    assert_eq!(placeholders, 1, "{}", ir["instances"]);
    assert_eq!(whens.len(), 1, "{whens:?}");
    assert!(!mentions(&whens[0], "side"), "{whens:?}");
    assert!(mentions(&whens[0], "kind"), "{whens:?}");
}

#[test]
fn an_any_with_a_passed_prop_keeps_that_prop() {
    let p = page("other={props.other}");
    let par = parent(
        "const NO_SIDE = { on: false }",
        "{ items, other, side = NO_SIDE }",
        "side.on || other",
    );
    let whens = island_whens(&compile(&tree(&p, &par, LIST, &[])).unwrap());
    assert_eq!(whens.len(), 2, "{whens:?}");
    assert!(
        whens
            .iter()
            .all(|w| mentions(w, "other") && !mentions(w, "side")),
        "{whens:?}"
    );
}
