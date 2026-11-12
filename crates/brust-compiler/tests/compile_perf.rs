//! F535: one `compile_tree` reads each module once, however deep the component chain and however many components
//! import the same helpers. The contexts walk, element-freedom (`module_may_hold_element`), barrels and store follows
//! read the same modules again and again; they share one parse per module per run.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use brust_compiler::stats::{Stats, take};
use std::path::{Path, PathBuf};

/// A page over a chain of `depth` components, one module each, behind a barrel. Every level imports the same helper
/// modules (plain functions, constants, a JSX helper, a store) and reads a context; every other level provides it.
fn write_app(root: &Path, depth: usize) {
    let w = |rel: &str, text: String| {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    };
    w(
        "ctx.ts",
        "import { createContext } from 'react'\nexport const Tone = createContext<{ tone: string } | null>(null)\n"
            .into(),
    );
    w(
        "helpers/format.ts",
        "export function fmt(v: string) {\n  return v.trim().toUpperCase()\n}\nexport function join(a: string, b: string) {\n  return `${a}-${b}`\n}\n"
            .into(),
    );
    w(
        "helpers/tokens.ts",
        "import { join } from './format'\nexport const TOKENS = { gap: 'g-2', pad: join('p', '2') }\n".into(),
    );
    w(
        "helpers/ui.tsx",
        "import { fmt } from './format'\nexport function Label({ text }: { text: string }) {\n  return <span class=\"label\">{fmt(text)}</span>\n}\n"
            .into(),
    );
    w(
        "stores/count.ts",
        "import { defineStore, signal } from '@brust/core/store'\nexport const count = defineStore('count', () => ({ n: signal(0) }))\n"
            .into(),
    );
    let mut barrel = String::new();
    for i in 0..depth {
        let next = if i + 1 < depth {
            format!("<Level{} />", i + 1)
        } else {
            "<b>end</b>".to_string()
        };
        let import_next = if i + 1 < depth {
            format!("import {{ Level{} }} from './level{}'\n", i + 1, i + 1)
        } else {
            String::new()
        };
        let body = if i % 2 == 0 {
            format!(
                "  return (\n    <Tone.Provider value={{{{ tone: TOKENS.pad }}}}>\n      <section class={{TOKENS.gap}}>\n        <Label text=\"l{i}\" />\n        {next}\n      </section>\n    </Tone.Provider>\n  )"
            )
        } else {
            format!(
                "  const t = useContext(Tone)\n  const s = useStore(count)\n  return (\n    <section class={{TOKENS.gap}} data-tone={{t?.tone}} data-n={{s.n}}>\n      <Label text={{fmt('l{i}')}} />\n      {next}\n    </section>\n  )"
            )
        };
        w(
            &format!("parts/level{i}.tsx"),
            format!(
                "import {{ useContext }} from 'react'\nimport {{ useStore }} from '@brust/core/store/react'\nimport {{ Tone }} from '../ctx'\nimport {{ fmt }} from '../helpers/format'\nimport {{ TOKENS }} from '../helpers/tokens'\nimport {{ Label }} from '../helpers/ui'\nimport {{ count }} from '../stores/count'\n{import_next}\nexport function Level{i}() {{\n{body}\n}}\n"
            ),
        );
        barrel += &format!("export {{ Level{i} }} from './level{i}'\n");
    }
    w("parts/index.ts", barrel);
    w(
        "page.tsx",
        "import { Level0 } from './parts'\nimport { Label } from './helpers/ui'\n\nexport default function Page() {\n  return (\n    <main>\n      <Label text=\"top\" />\n      <Level0 />\n    </main>\n  )\n}\n"
            .into(),
    );
}

/// Compiles the page of a fresh app of `depth` levels; the run's counters and the number of components it lowered.
fn run(depth: usize) -> (Stats, usize) {
    let root: PathBuf =
        std::env::temp_dir().join(format!("brust-compile-perf-{}-{depth}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    write_app(&root, depth);
    let opts = AnalyzeOptions {
        root: root.clone(),
        ..Default::default()
    };
    let (stats, n) = run_on_compiler_thread(move || {
        let out = compile_tree("page.tsx", None, &opts, "/_brust/client/runtime.js")
            .unwrap_or_else(|d| panic!("compiles: {d:?}"));
        (take(), out.len())
    });
    let _ = std::fs::remove_dir_all(&root);
    (stats, n)
}

#[test]
fn every_module_is_parsed_once_per_compile_tree() {
    let (st, components) = run(10);
    assert!(
        components >= 10,
        "the whole chain is compiled: {components}"
    );
    let many: Vec<_> = st.parses.iter().filter(|(_, n)| **n > 1).collect();
    assert!(many.is_empty(), "parsed more than once: {many:?}");
    // the page, the barrel, ten levels, the context, three helpers and the store module
    assert!(
        st.parses.contains_key("helpers/format.ts"),
        "{:?}",
        st.parses
    );
    assert!(st.total_parses() <= 17, "{:?}", st.parses);
    // one analysis and one pass pipeline per component (a component read again for a specialisation: twice at most)
    assert!(st.analyses.values().all(|n| *n <= 2), "{:?}", st.analyses);
    assert!(st.pass_runs.values().all(|n| *n <= 2), "{:?}", st.pass_runs);
}

#[test]
fn work_grows_linearly_with_the_chain() {
    let (a, _) = run(8);
    let (b, _) = run(16);
    // eight more levels: eight more modules, eight more components; the shared helpers are not read again
    assert_eq!(
        b.total_parses() - a.total_parses(),
        8,
        "{:?}\n{:?}",
        a.parses,
        b.parses
    );
    assert!(
        b.total_analyses() <= 2 * a.total_analyses() + 16,
        "{} vs {}",
        a.total_analyses(),
        b.total_analyses()
    );
}
