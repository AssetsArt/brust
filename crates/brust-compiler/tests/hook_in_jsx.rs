//! F442 (W3, F379): an unconditional call of a custom hook in the returned JSX (`id={useUid()}`, Radix's
//! `baseId={useId()}` from `@radix-ui/react-id`) is hoisted to a local before the return, in the order the JSX evaluates
//! its calls, and the hook is inlined there. Under a condition, a short circuit, a loop or a callback it stays refused.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// A custom hook of Radix `useId`'s shape that the reader can inline: React's `useId` under a prefix, with a deterministic override.
const HOOK: &str = "import * as React from 'react'
export function useUid(deterministic?: string): string {
  const id = React.useId()
  return deterministic || (id ? `uid-${id}` : '')
}
";

fn project(name: &str, page: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("hook-in-jsx-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("node_modules/react")).unwrap();
    std::fs::write(
        dir.join("node_modules/react/package.json"),
        "{\"name\":\"react\",\"version\":\"19.0.0\"}",
    )
    .unwrap();
    std::fs::write(dir.join("use-uid.tsx"), HOOK).unwrap();
    std::fs::write(dir.join("page.tsx"), page).unwrap();
    dir
}

/// (tier, rules of every diagnostic, jinja) of the page.
fn compile(name: &str, body: &str) -> (Tier, Vec<String>, String) {
    let page = format!(
        "import * as React from 'react'
import {{ useUid }} from './use-uid'
export default function C() {{
  const [n, setN] = React.useState(0)
  return {body}
}}
"
    );
    let dir = project(name, &page);
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
        (
            tree[0].ir.tier.clone(),
            tree[0]
                .ir
                .diagnostics
                .iter()
                .map(|d| format!("{}: {}", d.rule, d.message))
                .collect(),
            tree[0].artifacts.jinja.clone(),
        )
    })
}

#[test]
fn an_unconditional_custom_hook_call_in_an_attribute_is_hoisted_and_inlined() {
    let (tier, rules, jinja) = compile(
        "plain",
        "<main><button type=\"button\" onClick={() => setN(n + 1)}>{n}</button><section id={useUid()} aria-labelledby={useUid('fixed')} /></main>",
    );
    assert!(matches!(tier, Tier::Native), "{tier:?} {rules:#?}");
    assert!(
        !rules.iter().any(|r| r.contains("inside an expression")),
        "{rules:#?}"
    );
    // the deterministic one prints its argument
    assert!(jinja.contains("fixed"), "{jinja}");
}

#[test]
fn a_hook_call_under_a_condition_a_loop_or_a_callback_stays_refused() {
    for body in [
        "<main>{n > 0 && <i id={useUid()} />}</main>",
        "<main>{n > 0 ? <i id={useUid()} /> : null}</main>",
        "<main>{[1, 2].map((k) => <i key={k} id={useUid()} />)}</main>",
    ] {
        let (tier, rules, _) = compile("refused", body);
        assert!(
            matches!(tier, Tier::React { .. }),
            "{body}: {tier:?} {rules:#?}"
        );
        assert!(
            rules.iter().any(|r| r.contains("useUid")),
            "{body}: {rules:#?}"
        );
    }
}
