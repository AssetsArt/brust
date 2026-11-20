//! F560: a call of a `const` arrow of the component whose body is one expression is replaced by that expression, so the
//! value is read like any other (it used to be `client-function-in-job`: a function the client owns, called in a job).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "tests/fixtures/parent-counter/T.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn fallbacks(ir: &ComponentIR) -> Vec<&str> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| d.rule.as_str())
        .collect()
}

#[test]
fn a_call_of_an_expression_arrow_is_its_expression() {
    for src in [
        // in the markup
        "export default function T(props: { a: number; b: number }) { const sum = (x: number, y: number) => x + y; return <p>{sum(props.a, props.b)}</p> }",
        // in a derived value, beside state
        "import { useState } from 'react'\nexport default function T(props: { a: number }) { const [n, setN] = useState(0); const twice = (x: number) => x * 2; const v = twice(n) + props.a; return <button onClick={() => setN(n + 1)}>{v}</button> }",
        // an arrow that reads a prop itself
        "export default function T(props: { unit: string; n: number }) { const fmt = (x: number) => x + ' ' + props.unit; return <p>{fmt(props.n)}</p> }",
    ] {
        let ir = analyze(src);
        assert!(fallbacks(&ir).is_empty(), "{src}: {:?}", ir.diagnostics);
        assert!(
            !matches!(ir.tier, Tier::React { .. }),
            "{src}: {:?}",
            ir.tier
        );
    }
}

#[test]
fn an_arrow_that_is_not_one_expression_or_is_also_a_value_is_left_alone() {
    for src in [
        // a block body
        "import { useState } from 'react'\nexport default function T() { const [n, setN] = useState(0); const twice = (x: number) => { return x * 2 }; const v = twice(n); return <button onClick={() => setN(n + 1)}>{v}</button> }",
        // an argument that is a call (it would be evaluated once per use of the parameter)
        "import { useState } from 'react'\nexport default function T() { const [n, setN] = useState(0); const twice = (x: number) => x + x; const v = twice(Math.random() + n); return <button onClick={() => setN(n + 1)}>{v}</button> }",
    ] {
        let ir = analyze(src);
        assert!(
            fallbacks(&ir).contains(&"client-function-in-job"),
            "{src}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
}

/// Inside a list, the item and index names are the row's values. An arrow that reads a component name spelled like one
/// of them (`lang` in `(l) => lang === l`, called in `langs.map((lang) => …)`) is not replaced there: its body standing
/// in the row would compare the row with itself (`* en` for a row React prints as `en`). The call stays a call.
#[test]
fn an_arrow_that_reads_a_name_the_row_binds_is_not_replaced_in_that_row() {
    const LABEL: &str = "const label = (l: string) => (lang === l ? `* ${l}` : l)";
    let shadowed = [
        // the item is spelled like the prop the arrow reads
        format!(
            "export default function T({{ lang, langs }}: any) {{ {LABEL}; return <ul>{{langs.map((lang: string) => <li key={{lang}}>{{label(lang)}}</li>)}}</ul> }}"
        ),
        // the index is
        format!(
            "export default function T({{ lang, langs }}: any) {{ {LABEL}; return <ul>{{langs.map((l: string, lang: number) => <li key={{l}}>{{label(l)}}{{lang}}</li>)}}</ul> }}"
        ),
        // an outer list's item is, around an inner list
        format!(
            "export default function T({{ lang, groups }}: any) {{ {LABEL}; return <ul>{{groups.map((lang: any) => <li key={{lang.id}}>{{lang.xs.map((x: string) => <b key={{x}}>{{label(x)}}</b>)}}</li>)}}</ul> }}"
        ),
        // the same with state (a native component)
        format!(
            "import {{ useState }} from 'react'\nexport default function T({{ langs }}: any) {{ const [lang, setLang] = useState('th'); {LABEL}; return <ul onClick={{() => setLang('en')}}>{{langs.map((lang: string) => <li key={{lang}}>{{label(lang)}}</li>)}}</ul> }}"
        ),
    ];
    for src in &shadowed {
        let ir = analyze(src);
        let template = format!("{:?}", ir.template);
        assert!(!template.contains("StrictEq"), "{src}: {template}");
    }
    // The same arrow in a row that binds other names is its expression there, and outside the list too.
    let free = format!(
        "export default function T({{ lang, langs }}: any) {{ {LABEL}; return <ul title={{label('th')}}>{{langs.map((x: string, i: number) => <li key={{x}}>{{label(x)}}{{i}}</li>)}}</ul> }}"
    );
    let ir = analyze(&free);
    let template = format!("{:?}", ir.template);
    assert_eq!(template.matches("StrictEq").count(), 2, "{template}");
    assert!(fallbacks(&ir).is_empty(), "{:?}", ir.diagnostics);
    assert!(ir.jobs.is_empty(), "{:?}", ir.jobs);
    // After the list, the name is the component's again.
    let after = format!(
        "export default function T({{ lang, langs }}: any) {{ {LABEL}; return <div><ul>{{langs.map((lang: string) => <li key={{lang}}>{{lang}}</li>)}}</ul><p>{{label('th')}}</p></div> }}"
    );
    let template = format!("{:?}", analyze(&after).template);
    assert_eq!(template.matches("StrictEq").count(), 1, "{template}");
}

/// A row that binds the arrow's own name calls the row's value, not the arrow.
#[test]
fn a_row_that_binds_the_arrows_name_does_not_call_the_arrow() {
    let ir = analyze(
        "export default function T({ fs }: any) { const f = (x: number) => x * 7; return <ul>{fs.map((f: any, i: number) => <li key={i}>{f(i)}</li>)}</ul> }",
    );
    let template = format!("{:?}", ir.template);
    assert!(!template.contains("Mul"), "{template}");
}
