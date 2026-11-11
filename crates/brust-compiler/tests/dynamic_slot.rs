//! R4 (F519): `<Dynamic component={ref} props={props} />` from `@brust/core` is a server slot: one
//! `{{ brust_dynamic(<ref>, <props>) }}` call in the template (no wrapper element), decided on the server, refused where
//! the server cannot decide it (`dynamic-props`, `dynamic-expr`, `dynamic-reactive`, `dynamic-in-client-row`,
//! `dynamic-in-react`). `ComponentIR::dynamic` (the manifest's `components[id].dynamic`) is set on the component whose
//! template, with the children it inlines, holds one.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Diagnostic};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::sync::atomic::{AtomicUsize, Ordering};

/// One lowered component of a tree.
struct Compiled {
    source: String,
    jinja: String,
    /// The IR as the build receives it (`ComponentIR` serialised).
    ir: serde_json::Value,
    dynamic: bool,
    diagnostics: Vec<Diagnostic>,
}

/// `page` compiled as the route component `P.tsx` of a scratch root holding `files`; the root first.
fn compile(page: &str, files: &[(&str, &str)]) -> Result<Vec<Compiled>, Diagnostic> {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brustc-dynamic-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files.iter().chain([&("P.tsx", page)]) {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let src = page.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "P.tsx",
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root: dir,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )?;
        Ok(tree
            .iter()
            .map(|l| Compiled {
                source: l.ir.source.clone(),
                jinja: l.artifacts.jinja.clone(),
                ir: serde_json::to_value(&*l.ir).unwrap(),
                dynamic: l.ir.dynamic,
                diagnostics: l
                    .ir
                    .diagnostics
                    .iter()
                    .chain(&l.artifacts.diagnostics)
                    .cloned()
                    .collect(),
            })
            .collect())
    })
}

/// The root of a tree that compiles.
fn page(src: &str) -> Compiled {
    ok(src, &[]).remove(0)
}

fn ok(src: &str, files: &[(&str, &str)]) -> Vec<Compiled> {
    let tree = compile(src, files).unwrap_or_else(|d| panic!("{d:?}\n{src}"));
    for c in &tree {
        assert!(
            !c.diagnostics.iter().any(|d| d.class == DiagClass::Error),
            "{}: {:?}",
            c.source,
            c.diagnostics
        );
    }
    tree
}

/// The rule of the error that stops the build of `src`.
fn refused(src: &str) -> String {
    match compile(src, &[]) {
        Err(d) => {
            assert_eq!(d.class, DiagClass::Error, "{d:?}");
            d.rule
        }
        Ok(tree) => panic!("compiled: {}\n{src}", tree[0].jinja),
    }
}

const IMPORT: &str = "import { Dynamic } from '@brust/core'\n";

/// a) A slot in a server `{% for %}` row: one call, inside the row, no wrapper; the IR says the component holds a slot.
#[test]
fn a_slot_in_a_server_row_prints_one_call_per_row() {
    let c = page(&format!(
        "{IMPORT}export default function P({{ items }}: any) {{ return <ul>{{items.map((i: any) => <li key={{i.id}}><Dynamic component={{i.ref}} props={{{{ title: i.title }}}} /></li>)}}</ul> }}"
    ));
    let at = c
        .jinja
        .find("{% for i in items %}")
        .unwrap_or_else(|| panic!("{}", c.jinja));
    let end = c.jinja.find("{% endfor %}").unwrap();
    let row = &c.jinja[at..end];
    assert!(row.contains("<li>{{ brust_dynamic("), "{}", c.jinja);
    assert!(row.contains(") }}</li>"), "{}", c.jinja);
    assert!(row.contains("title"), "{}", c.jinja);
    assert_eq!(c.jinja.matches("brust_dynamic(").count(), 1, "{}", c.jinja);
    assert!(!c.jinja.contains("| e }}</li>"), "{}", c.jinja);
    assert!(c.dynamic);
    assert_eq!(c.ir["dynamic"], true);
}

#[test]
fn a_component_with_no_slot_is_not_dynamic() {
    let c = page("export default function P({ title }: any) { return <h1>{title}</h1> }");
    assert!(!c.dynamic);
    assert!(c.ir.get("dynamic").is_none(), "{}", c.ir);
}

/// b) `props` omitted: the second argument is an empty object. `@brust/core/routes` exports it too.
#[test]
fn props_omitted_print_an_empty_object() {
    for spec in ["@brust/core", "@brust/core/routes"] {
        let c = page(&format!(
            "import {{ Dynamic }} from '{spec}'\nexport default function P({{ which }}: any) {{ return <div><Dynamic component={{which}} /></div> }}"
        ));
        assert!(
            c.jinja.contains("{{ brust_dynamic(which, {}) }}"),
            "{spec}: {}",
            c.jinja
        );
        assert!(c.dynamic);
    }
}

/// A `Dynamic` imported from anywhere else is an ordinary component.
#[test]
fn a_dynamic_of_another_package_is_not_the_slot() {
    let tree = compile(
        "import { Dynamic } from 'some-lib'\nexport default function P({ which }: any) { return <div><Dynamic component={which} /></div> }",
        &[],
    );
    if let Ok(tree) = tree {
        assert!(!tree[0].dynamic);
        assert!(
            !tree[0].jinja.contains("brust_dynamic("),
            "{}",
            tree[0].jinja
        );
    }
}

/// c) `dynamic-props`: children, a prop other than `component` / `props` / `key`, no `component`.
#[test]
fn dynamic_props_are_component_and_props_only() {
    for jsx in [
        "<Dynamic component={which}><b>x</b></Dynamic>",
        "<Dynamic component={which} foo={1} />",
        "<Dynamic props={{ a: 1 }} />",
        "<Dynamic component={which} {...rest} />",
    ] {
        let src = format!(
            "{IMPORT}export default function P({{ which, ...rest }}: any) {{ return <div>{jsx}</div> }}"
        );
        assert_eq!(refused(&src), "dynamic-props", "{jsx}");
    }
}

/// `key` is React's own: allowed and ignored.
#[test]
fn a_key_on_dynamic_is_allowed() {
    let c = page(&format!(
        "{IMPORT}export default function P({{ items }}: any) {{ return <div>{{items.map((i: any) => <Dynamic key={{i.id}} component={{i.ref}} />)}}</div> }}"
    ));
    assert!(c.jinja.contains("brust_dynamic("), "{}", c.jinja);
}

/// c) `dynamic-expr`: a value outside the server template grammar.
#[test]
fn a_value_outside_the_server_grammar_is_refused() {
    for v in ["which.toFixed()", "String(which)"] {
        let src = format!(
            "{IMPORT}export default function P({{ which }}: any) {{ return <div><Dynamic component={{{v}}} /></div> }}"
        );
        assert_eq!(refused(&src), "dynamic-expr", "{v}");
    }
}

/// c) `dynamic-reactive`: a value that reads state.
#[test]
fn a_value_that_reads_state_is_refused() {
    let src = format!(
        "{IMPORT}import {{ useState }} from 'react'\nexport default function P({{ which }}: any) {{ const [n, setN] = useState(0); return <div onClick={{() => setN(n + 1)}}><Dynamic component={{which}} props={{{{ n }}}} /></div> }}"
    );
    assert_eq!(refused(&src), "dynamic-reactive");
}

/// c) `dynamic-in-client-row` (K4): a stateful host makes the loader list an `x-for` list the client re-creates.
#[test]
fn a_slot_in_a_client_row_is_refused() {
    let src = format!(
        "{IMPORT}import {{ useState }} from 'react'\nexport default function P({{ items }}: any) {{ const [n, setN] = useState(0); return <ul>{{items.map((i: any) => <li key={{i.id}} onClick={{() => setN(n + 1)}}><Dynamic component={{i.ref}} /></li>)}}</ul> }}"
    );
    assert_eq!(refused(&src), "dynamic-in-client-row");
}

/// c) `dynamic-in-react`: a component that renders as a React island (a browser global read in render).
#[test]
fn a_slot_in_a_react_island_is_refused() {
    let src = format!(
        "{IMPORT}export default function P({{ which }}: any) {{ const w = window.innerWidth; return <div>{{w}}<Dynamic component={{which}} /></div> }}"
    );
    assert_eq!(refused(&src), "dynamic-in-react");
}

/// d) A static child that holds a slot, inlined: the parent's template prints it with the child's props bound, and both
/// IRs say they hold one.
#[test]
fn an_inlined_child_holding_a_slot_makes_its_parent_dynamic() {
    let promo = format!(
        "{IMPORT}export default function Promo({{ which, title }}: any) {{ return <section><Dynamic component={{which}} props={{{{ title }}}} /></section> }}"
    );
    let tree = ok(
        "import Promo from './el/Promo'\nexport default function P({ slot }: any) { return <main><Promo which={slot} title=\"Hi\" /></main> }",
        &[("el/Promo.tsx", &promo)],
    );
    let root = &tree[0];
    // The child's `which` reads the parent's `slot` (its call-site binding), in the parent's template.
    assert!(
        root.jinja.contains("{{ brust_dynamic((slot), "),
        "{}",
        root.jinja
    );
    assert!(root.jinja.contains("<section"), "{}", root.jinja);
    assert!(root.dynamic);
    assert_eq!(root.ir["dynamic"], true);
    let child = tree
        .iter()
        .find(|c| c.source.ends_with("Promo.tsx"))
        .expect("the child is lowered");
    assert!(child.dynamic);
}

/// e) A slot under a condition the client toggles is printed in both copies (the server renders both).
#[test]
fn a_slot_under_a_reactive_condition_is_printed_in_both_copies() {
    let c = page(&format!(
        "{IMPORT}import {{ useState }} from 'react'\nexport default function P({{ which }}: any) {{ const [open, setOpen] = useState(false); return <div><button onClick={{() => setOpen(!open)}}>t</button>{{open && <Dynamic component={{which}} />}}</div> }}"
    ));
    assert!(
        c.jinja.matches("brust_dynamic(which, {})").count() >= 2,
        "{}",
        c.jinja
    );
    assert!(c.dynamic);
}

fn refused_with(src: &str, files: &[(&str, &str)]) -> String {
    match compile(src, files) {
        Err(d) => {
            assert_eq!(d.class, DiagClass::Error, "{d:?}");
            d.rule
        }
        Ok(tree) => panic!("compiled: {}\n{src}", tree[0].jinja),
    }
}

/// Review fix (R4.3): a `<Dynamic>` handed down as `{children}` and printed by the child inside a row the client builds
/// is a slot in a client row too — refused where the child pastes the markup.
#[test]
fn a_slot_passed_as_children_into_a_client_row_is_refused() {
    let rows = "import { useState } from 'react'\nexport default function Rows({ items, children }: any) { const [n, setN] = useState(0); return <ul>{items.map((i: any) => <li key={i.id} onClick={() => setN(n + 1)}>{children}</li>)}</ul> }";
    let src = format!(
        "{IMPORT}import Rows from './el/Rows'\nexport default function P({{ items, slot }}: any) {{ return <main><Rows items={{items}}><Dynamic component={{slot}} /></Rows></main> }}"
    );
    assert_eq!(
        refused_with(&src, &[("el/Rows.tsx", rows)]),
        "dynamic-in-client-row"
    );
}

/// The same child over a fixed list (F515: a module constant, rows the server owns for good) pastes the slot in server
/// rows: no refusal.
#[test]
fn a_slot_passed_as_children_into_fixed_rows_compiles() {
    let rows = "import { useState } from 'react'\nconst ROWS = [{ id: 'a' }, { id: 'b' }]\nexport default function Rows({ children }: any) { const [n, setN] = useState(0); return <ul>{ROWS.map((r) => <li key={r.id} onClick={() => setN(n + 1)}>{children}</li>)}</ul> }";
    let src = format!(
        "{IMPORT}import Rows from './el/Rows'\nexport default function P({{ slot }}: any) {{ return <main><Rows><Dynamic component={{slot}} /></Rows></main> }}"
    );
    let tree = ok(&src, &[("el/Rows.tsx", rows)]);
    assert!(
        tree[0].jinja.contains("brust_dynamic("),
        "{}",
        tree[0].jinja
    );
}
