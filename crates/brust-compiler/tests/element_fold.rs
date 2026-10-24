//! F288 phase A: `@radix-ui/react-presence` (its TypeScript source as published, from the installed package's source
//! map) specialised per call site by the element-value fold. The one edit to the source: its
//! `@radix-ui/react-use-layout-effect` import reads React's `useLayoutEffect` (that package is a client-only alias).
//! Served parity: tests/server/presence.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::{Path, PathBuf};

fn store(prefix: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.bun");
    std::fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .unwrap_or_else(|| panic!("{prefix} is installed"))
        .path()
}

/// A project dir with Presence's sources, an `Impl` component of its own module, and a `react` of `major`.
fn project(name: &str, major: u32) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("element-fold-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("node_modules/react")).unwrap();
    std::fs::write(
        dir.join("node_modules/react/package.json"),
        format!("{{\"name\":\"react\",\"version\":\"{major}.0.0\"}}"),
    )
    .unwrap();
    let map = store("@radix-ui+react-presence@")
        .join("node_modules/@radix-ui/react-presence/dist/index.mjs.map");
    let map: serde_json::Value = serde_json::from_slice(&std::fs::read(map).unwrap()).unwrap();
    for (s, c) in map["sources"]
        .as_array()
        .unwrap()
        .iter()
        .zip(map["sourcesContent"].as_array().unwrap())
    {
        let file = s.as_str().unwrap().rsplit('/').next().unwrap();
        let text = c.as_str().unwrap().replace(
            "import { useLayoutEffect } from '@radix-ui/react-use-layout-effect';",
            "const useLayoutEffect = React.useLayoutEffect;",
        );
        std::fs::write(dir.join(file), text).unwrap();
    }
    std::fs::write(
        dir.join("impl.tsx"),
        "import * as React from 'react'\nexport const Impl = React.forwardRef<HTMLDivElement, { present: boolean; children?: React.ReactNode }>(function Impl(props, ref) {\n  const { present, children } = props\n  return <div ref={ref} data-present={present ? 'y' : 'n'}>{children}</div>\n})\n",
    )
    .unwrap();
    dir
}

struct Out {
    tier: Tier,
    rules: Vec<String>,
    jinja: String,
    /// (id, the refs array `useStableComposedRefs` builds (`refsRef` starts at it), printed)
    clones: Vec<(String, String)>,
}

fn compile(dir: &Path, page: &str) -> Out {
    // on disk too: a clone names a component of the page's module by reading that file
    std::fs::write(dir.join("page.tsx"), page).unwrap();
    let (dir, page) = (dir.to_path_buf(), page.to_string());
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "page.tsx",
            Some(page.into_bytes()),
            &AnalyzeOptions {
                root: dir,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        Out {
            tier: tree[0].ir.tier.clone(),
            rules: tree[0]
                .ir
                .diagnostics
                .iter()
                .chain(&tree[0].artifacts.diagnostics)
                .map(|d| format!("{}: {}", d.rule, d.message))
                .collect(),
            jinja: tree[0].artifacts.jinja.clone(),
            clones: tree
                .iter()
                .filter(|c| c.ir.id.contains("presence") && c.ir.specialised)
                .map(|c| {
                    let init =
                        c.ir.derived
                            .iter()
                            .find(|d| d.name.starts_with("refs_"))
                            .map(|r| match &r.expr {
                                brust_compiler::ir::Expr::Raw(e) => e.to_js(),
                                brust_compiler::ir::Expr::ClientOnly { js, .. } => js.clone(),
                                e => format!("{e:?}"),
                            })
                            .unwrap_or_default();
                    (c.ir.id.clone(), init)
                })
                .collect(),
        }
    })
}

const HEAD: &str = "import * as React from 'react'\nimport { Presence } from './presence'\nimport { Impl } from './impl'\n";

fn page(body: &str) -> String {
    format!(
        "{HEAD}export default function Page() {{\n  const [open, setOpen] = React.useState(false)\n  return <main><button type=\"button\" onClick={{() => setOpen(!open)}}>t</button>{body}</main>\n}}\n"
    )
}

const FN_CHILD: &str =
    "<Presence present={open}>{({ present }) => <Impl present={present}>body</Impl>}</Presence>";

#[test]
fn a_function_child_is_folded_and_the_page_is_native() {
    let dir = project("s2", 19);
    let o = compile(&dir, &page(FN_CHILD));
    assert!(matches!(o.tier, Tier::Native), "{:?} {:?}", o.tier, o.rules);
    assert!(!o.jinja.contains("brust-island"), "{}", o.jinja);
    // forceMount: the child renders whatever `present` is; `present` follows the machine's `isPresent`
    assert!(o.jinja.contains("data-present="), "{}", o.jinja);
    let [(id, init)] = &o.clones[..] else {
        panic!(
            "one Presence clone: {:?}",
            o.clones.iter().map(|c| &c.0).collect::<Vec<_>>()
        )
    };
    // G9: `refsRef.current = refs` is the initialiser, set after the handlers it names; getElementRef(child) is null
    assert_eq!(init, "[hoist1_useCallback, null]", "{id}");
}

#[test]
fn an_element_child_mounts_with_presence_and_takes_the_composed_ref_as_x_cref() {
    // Phase B (S1): `Children.only(children)`; with an element child `forceMount` is false, so Presence renders
    // `isPresent ? cloneElement(child, { ref }) : null`: a branch whose element takes the composed callback ref, which
    // the runtime's `x-if` attaches with the branch (`x-cref`).
    let dir = project("s1", 19);
    let page = page("<Presence present={open}><Impl present={open}>body</Impl></Presence>");
    std::fs::write(dir.join("page.tsx"), &page).unwrap();
    let (tier, rules, page_jinja, clones) = run_on_compiler_thread(move || {
        let tree = compile_tree(
            "page.tsx",
            Some(page.into_bytes()),
            &AnalyzeOptions {
                root: dir,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let clones: Vec<(String, Tier, String, Vec<String>)> = tree
            .iter()
            .filter(|c| c.ir.id.contains("presence") && c.ir.specialised)
            .map(|c| {
                (
                    c.ir.id.clone(),
                    c.ir.tier.clone(),
                    c.artifacts.jinja.clone(),
                    c.ir.refs.iter().map(|r| r.name.clone()).collect(),
                )
            })
            .collect();
        (
            tree[0].ir.tier.clone(),
            tree[0]
                .ir
                .diagnostics
                .iter()
                .map(|d| format!("{}: {}", d.rule, d.message))
                .collect::<Vec<_>>(),
            tree[0].artifacts.jinja.clone(),
            clones,
        )
    });
    assert!(matches!(tier, Tier::Native), "{tier:?} {rules:?}");
    assert!(!page_jinja.contains("brust-island"), "{page_jinja}");
    let [(id, clone_tier, jinja, refs)] = &clones[..] else {
        panic!(
            "one Presence clone: {:?}",
            clones.iter().map(|c| &c.0).collect::<Vec<_>>()
        )
    };
    assert!(matches!(clone_tier, Tier::Native), "{id} {clone_tier:?}");
    assert!(jinja.contains("x-if="), "{jinja}");
    let cell = refs
        .iter()
        .find(|r| r.starts_with("$cr"))
        .unwrap_or_else(|| panic!("a callback-ref cell: {refs:?}"));
    assert!(jinja.contains(&format!("x-cref=\"{cell}\"")), "{jinja}");
    assert!(jinja.contains("data-present="), "{jinja}");
}

#[test]
fn another_react_major_refuses() {
    let dir = project("react18", 18);
    let o = compile(&dir, &page(FN_CHILD));
    assert!(o.clones.is_empty());
    assert!(o.jinja.contains("brust-island"), "{}", o.jinja);
}

#[test]
fn a1_two_call_sites_with_equal_content_but_different_pins_are_two_clones() {
    // Mellow A1: the key is specialise()'s (site + content + loc), never content alone; one call site's `present` is
    // client-changing, the other's is a constant the clone pins.
    let dir = project("a1", 19);
    let o = compile(
        &dir,
        &page(&format!(
            "{FN_CHILD}<Presence present={{true}}>{{({{ present }}) => <Impl present={{present}}>body</Impl>}}</Presence>"
        )),
    );
    assert!(matches!(o.tier, Tier::Native), "{:?} {:?}", o.tier, o.rules);
    let mut ids: Vec<&String> = o.clones.iter().map(|c| &c.0).collect();
    ids.dedup();
    assert_eq!(ids.len(), 2, "{ids:?}");
}

#[test]
fn a1_a_call_site_in_a_list_is_one_clone() {
    let dir = project("a1-list", 19);
    let o = compile(
        &dir,
        &page(
            "{['a', 'b'].map((x) => <Presence key={x} present={open}>{({ present }) => <Impl present={present}>row</Impl>}</Presence>)}",
        ),
    );
    let ids: std::collections::BTreeSet<&String> = o.clones.iter().map(|c| &c.0).collect();
    assert_eq!(ids.len(), 1, "{ids:?} {:?}\n{}", o.rules, o.jinja);
}

#[test]
fn a_row_value_in_the_content_keeps_the_island() {
    // The clone's content may not read a binding of an enclosing list (the existing Carry rule for every clone): fail
    // closed, named.
    let dir = project("a1-row", 19);
    let o = compile(
        &dir,
        &page(
            "{['a', 'b'].map((x) => <Presence key={x} present={open}>{({ present }) => <Impl present={present}>{x}</Impl>}</Presence>)}",
        ),
    );
    assert!(o.clones.is_empty());
    assert!(
        o.rules
            .iter()
            .any(|r| r.starts_with("specialise-unsupported") && r.contains("enclosing list")),
        "{:?}",
        o.rules
    );
}

#[test]
fn content_declared_in_the_rendering_module_is_named_from_the_clone() {
    // Radix's CollapsibleContentImpl is a non-exported component of the module that renders `<Presence>`: the clone
    // (in presence's module) names it by that file and its local name.
    let dir = project("local", 19);
    let src = format!(
        "{HEAD}const Local = React.forwardRef<HTMLDivElement, {{ present: boolean }}>(function Local(props, ref) {{\n  return <div ref={{ref}} data-p={{props.present ? 'y' : 'n'}}>local</div>\n}})\nexport default function Page() {{\n  const [open, setOpen] = React.useState(false)\n  return <main><button type=\"button\" onClick={{() => setOpen(!open)}}>t</button><Presence present={{open}}>{{({{ present }}) => <Local present={{present}} />}}</Presence></main>\n}}\n"
    );
    let o = compile(&dir, &src);
    assert!(matches!(o.tier, Tier::Native), "{:?} {:?}", o.tier, o.rules);
    assert_eq!(o.clones.len(), 1, "{:?}", o.rules);
}

#[test]
fn content_declared_in_the_rendering_module_that_needs_react_keeps_the_island() {
    let dir = project("local-react", 19);
    let src = format!(
        "{HEAD}const Local = React.forwardRef<HTMLDivElement, {{ present: boolean }}>(function Local(props, ref) {{\n  const v = React.useSyncExternalStore(() => () => {{}}, () => 1, () => 1)\n  return <div ref={{ref}} data-v={{v}}>local</div>\n}})\nexport default function Page() {{\n  const [open, setOpen] = React.useState(false)\n  return <main><button type=\"button\" onClick={{() => setOpen(!open)}}>t</button><Presence present={{open}}>{{({{ present }}) => <Local present={{present}} />}}</Presence></main>\n}}\n"
    );
    let o = compile(&dir, &src);
    assert!(o.clones.is_empty());
    assert!(
        o.rules
            .iter()
            .any(|r| r.starts_with("specialise-unsupported")
                && r.contains("<Local> (declared in the module that renders it) needs React")),
        "{:?}",
        o.rules
    );
}
