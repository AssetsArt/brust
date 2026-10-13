//! L20: `styles.x` / `styles['x']` of a `*.module.css` import folds to the literal class (an explicit exception to
//! R1.1b: the class map is frozen). An unknown class is an error with its location; with no map nothing folds.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::DiagClass;
use brust_compiler::parse::run_on_compiler_thread;
use std::collections::HashMap;
use std::path::PathBuf;

const AT: &str = "tests/fixtures/css-module-static/T.tsx";

fn opts(map: &[(&str, &str)]) -> AnalyzeOptions {
    let m: HashMap<String, String> = map
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    AnalyzeOptions {
        root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        css_modules: HashMap::from([(
            "tests/fixtures/css-module-static/card.module.css".to_string(),
            m,
        )]),
        ..Default::default()
    }
}

fn analyze(src: &str, o: AnalyzeOptions) -> brust_compiler::ir::ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || analyze_source(AT, s.into_bytes(), &o).expect("analyzes"))
}

const PAGE: &str = "import styles from './card.module.css'\nexport default function T() { return <p className={styles.card}>x</p> }\n";

#[test]
fn a_known_class_folds_and_leaves_no_job() {
    let ir = analyze(PAGE, opts(&[("card", "card_h1")]));
    assert!(ir.jobs.is_empty(), "{:?}", ir.jobs);
    assert!(
        ir.diagnostics.iter().all(|d| d.class != DiagClass::Error),
        "{:?}",
        ir.diagnostics
    );
    assert!(
        serde_json::to_string(&ir.template)
            .unwrap()
            .contains("card_h1")
    );
}

#[test]
fn without_a_map_it_stays_a_job_as_before() {
    let ir = analyze(PAGE, opts(&[]));
    // an empty map defines nothing, so the class is unknown...
    assert!(ir.diagnostics.iter().any(|d| d.rule == "css-module-class"));
    let none = AnalyzeOptions {
        root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        ..Default::default()
    };
    // ...but a build that handed over no maps at all keeps today's path (a precompute job)
    let ir = analyze(PAGE, none);
    assert!(!ir.jobs.is_empty());
    assert!(ir.diagnostics.iter().all(|d| d.rule != "css-module-class"));
}

#[test]
fn an_unknown_class_is_an_error_at_its_location() {
    let ir = analyze(
        "import styles from './card.module.css'\nexport default function T() {\n  return <p className={styles.nope}>x</p>\n}\n",
        opts(&[("card", "card_h1")]),
    );
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "css-module-class")
        .expect("a diagnostic");
    assert_eq!(d.class, DiagClass::Error);
    assert!(
        d.message.contains("`nope`") && d.message.contains("./card.module.css"),
        "{}",
        d.message
    );
    assert_eq!((d.line, d.col > 0), (3, true), "{d:?}");
}

#[test]
fn bracket_access_a_conditional_and_a_template_literal_fold() {
    let ir = analyze(
        "import styles from './card.module.css'\nexport default function T({ on }: { on: boolean }) {\n  return <p className={on ? styles['a'] : `${styles.b} z`}>x</p>\n}\n",
        opts(&[("a", "a_h"), ("b", "b_h")]),
    );
    let t = serde_json::to_string(&ir.template).unwrap();
    assert!(t.contains("a_h") && t.contains("b_h"), "{t}");
    assert!(
        ir.diagnostics.iter().all(|d| d.class != DiagClass::Error),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn only_a_default_import_of_a_relative_module_css_folds() {
    // the whole map as a value, a package import and a shadowing local are not folded
    let ir = analyze(
        "import styles from './card.module.css'\nexport default function T() { return <p className={Object.keys(styles).join(' ')}>x</p> }\n",
        opts(&[("card", "card_h1")]),
    );
    assert!(
        !ir.jobs.is_empty()
            || !serde_json::to_string(&ir.template)
                .unwrap()
                .contains("card_h1")
    );
    let ir = analyze(
        "import styles from 'pkg/x.module.css'\nexport default function T() { return <p className={styles.card}>x</p> }\n",
        opts(&[("card", "card_h1")]),
    );
    assert!(
        !serde_json::to_string(&ir.template)
            .unwrap()
            .contains("card_h1")
    );
}
