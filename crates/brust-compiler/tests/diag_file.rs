//! F395 (Assets Art B-3): a finding raised while printing an inlined component from another module names that module,
//! with the line and column in that module's text, never the route file with a position from another file.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;

fn tree_diagnostics(name: &str, files: &[(&str, &str)]) -> Vec<(String, Option<String>, u32, u32)> {
    let dir = std::env::temp_dir().join(format!("brustc-f395-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let d = dir.clone();
    let out = run_on_compiler_thread(move || {
        compile_tree(
            "Home.tsx",
            None,
            &AnalyzeOptions {
                root: d,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .map(|t| {
            t.iter()
                .flat_map(|l| l.artifacts.diagnostics.iter())
                .map(|d| (d.rule.clone(), d.file.clone(), d.line, d.col))
                .collect::<Vec<_>>()
        })
    });
    let _ = std::fs::remove_dir_all(&dir);
    out.expect("compiles")
}

#[test]
fn a_lowering_finding_in_an_inlined_component_names_its_own_file_and_position() {
    let found = tree_diagnostics(
        "reserved-attr",
        &[
            (
                "Home.tsx",
                "import { Card } from './components/Card'\nexport default function Home() {\n  return <main><Card x-foo=\"1\" title=\"a\" /></main>\n}\n",
            ),
            (
                "components/Card.tsx",
                "export function Card({ title, ...rest }: { title: string; [k: string]: unknown }) {\n  return (\n    <section {...rest}>\n      <h2>{title}</h2>\n    </section>\n  )\n}\n",
            ),
        ],
    );
    assert!(
        found.contains(&(
            "reserved-attr".to_string(),
            Some("components/Card.tsx".to_string()),
            3,
            5
        )),
        "{found:?}"
    );
}

/// F394: an ordinary child's prop called `req` is data; the compile has no error.
#[test]
fn a_child_prop_named_req_compiles() {
    let found = tree_diagnostics(
        "req-prop",
        &[
            (
                "Home.tsx",
                "import { Count } from './components/Count'\nexport default function Home() {\n  return <main><Count req=\"18,420\" /></main>\n}\n",
            ),
            (
                "components/Count.tsx",
                "export function Count({ req }: { req: string }) {\n  return <span>{req}</span>\n}\n",
            ),
        ],
    );
    assert!(
        found
            .iter()
            .all(|(rule, ..)| rule != "request-state-in-render"),
        "{found:?}"
    );
}
