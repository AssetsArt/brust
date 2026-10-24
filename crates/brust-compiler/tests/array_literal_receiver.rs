//! F442 (part 1): a built-in method called on an array literal of primitive literals is plain, so a value derived from it
//! (`['mounted', 'unmountSuspended'].includes(state)`, Radix Presence's `isPresent`) may be read as a child of a component.
//! The array must hold literals only and be the receiver of a built-in method call; any other array or method keeps the
//! refusal (`jsx-const-child`).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// (tier of the page, rules of its diagnostics) for a page whose `shown` is `expr`, read as a child of a component.
fn page(expr: &str) -> (Tier, Vec<String>) {
    let src = format!(
        "import {{ useState }} from 'react'
function Card({{ children }}: {{ children?: React.ReactNode }}) {{ return <div className=\"card\">{{children}}</div> }}
export default function C() {{
  const [s, setS] = useState('mounted')
  const o = {{ toString: () => 'x' }}
  const shown = {expr}
  return <main><button type=\"button\" onClick={{() => setS('gone')}}>t</button><Card>{{shown}}</Card></main>
}}
"
    );
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "crates/brust-compiler/tests/fixtures/attr-parity/T.tsx",
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        (
            tree[0].ir.tier.clone(),
            tree[0]
                .ir
                .diagnostics
                .iter()
                .map(|d| d.rule.clone())
                .collect(),
        )
    })
}

#[test]
fn a_method_of_an_array_literal_of_literals_is_plain() {
    for e in [
        "['mounted', 'unmountSuspended'].includes(s)",
        "['a', 'b'].join('-')",
        "[1, 2, 3].includes(1)",
    ] {
        let (tier, rules) = page(e);
        assert!(
            !rules.iter().any(|r| r == "jsx-const-child"),
            "{e}: {tier:?} {rules:?}"
        );
    }
}

#[test]
fn another_array_or_a_member_of_one_keeps_the_refusal() {
    for e in [
        // an element that is not a literal can carry its own methods
        "[o, 'b'].includes(s)",
        "[s, 'b'].join('-')",
        // a method that is not a built-in primitive-returning one
        "['a', 'b'].map((x) => x).includes(s)",
    ] {
        let (_, rules) = page(e);
        assert!(
            rules.iter().any(|r| r == "jsx-const-child"),
            "{e}: {rules:?}"
        );
    }
}
