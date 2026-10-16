//! F325 (Mellow D1 on F320): rows over module-level data keep F319's freeze in a component with an instance. Under F320
//! alone, a stateful component whose rows read a named prop got `x-for` even when every caller passed a constant, and
//! its chunk then imported the list source: an imported `USERS` with a `secret` field shipped to the browser where the
//! page used to print the rows once and ship nothing. Now a constant caller still ships none of it, a changing caller
//! falls back (`frozen-prop`), and a local array still gets `x-for`.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;

const DATA: &str =
    "export const USERS = [{ name: 'ann', secret: 'S3CR3T' }, { name: 'bob', secret: 'S3CR3T' }]";

/// A child with an instance whose rows over `source` print a name behind its prop `on`.
fn child(import: &str, source: &str) -> String {
    format!(
        "import {{ useState }} from 'react'\n{import}\nexport default function C({{ on }}: any) {{ const [n, setN] = useState(0); return <div data-n={{n}} onClick={{() => setN(n + 1)}}>{{{source}.map((u: any) => <b key={{u.name}}>{{on ? u.name : '-'}}</b>)}}</div> }}"
    )
}

const LIVE: &str = "import { useState } from 'react'\nimport C from './C'\nexport default function T() { const [on, setOn] = useState(false); return <main><button onClick={() => setOn(!on)}>f</button><C on={on} /></main> }";
const CONST: &str =
    "import C from './C'\nexport default function T() { return <main><C on={true} /></main> }";

struct Out {
    tier: Tier,
    rules: Vec<String>,
    /// Every client chunk and shared module of the tree, concatenated.
    client: String,
    /// The child's jinja.
    child_jinja: String,
}

fn compile(parent: &str, c: &str) -> Out {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brust-f325-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("T.tsx"), parent).unwrap();
    std::fs::write(dir.join("C.tsx"), c).unwrap();
    std::fs::write(dir.join("data.ts"), DATA).unwrap();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "T.tsx",
            None,
            &AnalyzeOptions {
                root: dir,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let root = &tree[0];
        let mut client = String::new();
        for l in &tree {
            client.push_str(l.artifacts.client_js.as_deref().unwrap_or(""));
            for (_, code) in &l.artifacts.client_modules {
                client.push_str(code);
            }
        }
        Out {
            tier: root.ir.tier.clone(),
            rules: root
                .ir
                .diagnostics
                .iter()
                .filter(|d| d.class == DiagClass::Fallback)
                .map(|d| d.rule.clone())
                .collect(),
            client,
            child_jinja: tree
                .iter()
                .find(|l| l.ir.id.starts_with("c_"))
                .map(|l| l.artifacts.jinja.clone())
                .unwrap_or_default(),
        }
    })
}

#[test]
fn an_imported_list_source_stays_frozen_and_ships_nothing_for_a_constant_caller() {
    let c = child("import { USERS } from './data'", "USERS");
    let o = compile(CONST, &c);
    assert!(o.rules.is_empty(), "{:?}", o.rules);
    assert!(!o.child_jinja.contains("x-for"), "{}", o.child_jinja);
    assert!(!o.client.contains("S3CR3T"), "{}", o.client);
    assert!(!o.client.contains("USERS"), "{}", o.client);
}

#[test]
fn an_imported_list_source_refuses_a_changing_caller() {
    let c = child("import { USERS } from './data'", "USERS");
    let o = compile(LIVE, &c);
    assert!(
        o.rules.contains(&"frozen-prop".to_string()),
        "{:?}",
        o.rules
    );
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.tier);
}

#[test]
fn a_module_const_list_source_stays_frozen_too() {
    let c = child("const USERS = [{ name: 'ann', secret: 'S3CR3T' }]", "USERS");
    let o = compile(CONST, &c);
    assert!(!o.child_jinja.contains("x-for"), "{}", o.child_jinja);
    assert!(!o.client.contains("S3CR3T"), "{}", o.client);
}

#[test]
fn a_local_list_still_gets_x_for_and_follows_a_changing_caller() {
    let c = child("", "[{ name: 'ann' }, { name: 'bob' }]");
    let o = compile(LIVE, &c);
    assert!(o.rules.is_empty(), "{:?}", o.rules);
    assert!(matches!(o.tier, Tier::Native), "{:?}", o.tier);
    assert!(o.child_jinja.contains("x-for"), "{}", o.child_jinja);
}
