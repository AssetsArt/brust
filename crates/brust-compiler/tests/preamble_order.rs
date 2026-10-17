//! F385: the server's first paint read an inlined custom hook's ARGUMENT before it was set. The template preamble (and
//! the job module and client chunk) ordered declarations by source location, and an inlined hook's own declarations carry
//! the hook's locations (earlier in the file, or another module's offsets) while its argument bindings carry the call
//! site's. `useLabel(1)` painted `Lundefined`, `useBoth(1)` an empty button. Each declaration now comes after the ones it
//! reads. Fixture: packages/brust/test/fixtures/preamble-order (served in tests/server/preamble-order.chromium.test.ts).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

const DIR: &str = "packages/brust/test/fixtures/preamble-order";

/// (rendered first paint, server module, client chunk) of the page.
fn page(file: &str) -> (String, String, String) {
    let path = format!("{DIR}/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            None,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        let mut env = minijinja::Environment::new();
        brust_jinja::register(&mut env);
        // The one per-request job slot (ImportedPage's `fmt(k)`): React's value for it.
        let mut ctx = serde_json::json!({ "_props": {}, "_s1": "#3.0" });
        for l in &tree {
            for k in 1..=8 {
                ctx[format!("__{}_{k}", l.ir.id)] = serde_json::json!({ "_s1": "#3.0" });
            }
        }
        let html = env
            .render_str(&a.jinja, brust_jinja::value_of(ctx))
            .unwrap();
        (
            html,
            a.server_ts.clone().unwrap_or_default(),
            a.client_js.clone().unwrap_or_default(),
        )
    })
}

/// `names` appear in `text` in this order.
fn in_order(text: &str, names: &[&str]) {
    let at: Vec<usize> = names
        .iter()
        .map(|n| {
            text.find(&format!("const {n} ="))
                .unwrap_or_else(|| panic!("no `const {n}` in:\n{text}"))
        })
        .collect();
    assert!(
        at.windows(2).all(|w| w[0] < w[1]),
        "{names:?} out of order in:\n{text}"
    );
}

#[test]
fn a_local_hook_paints_its_argument() {
    let (html, _, _) = page("LocalPage.tsx");
    assert!(html.contains(r#"title="L1""#), "{html}");
}

#[test]
fn an_imported_hook_and_a_two_level_chain_paint_their_arguments() {
    let (html, server, client) = page("ImportedPage.tsx");
    // useLabel(7) is imported; useOuter(2) calls useInner(n + 1), which seeds a state from it.
    assert!(html.contains(r#"title="L7""#), "{html}");
    assert!(html.contains(r#"data-outer="I3!""#), "{html}");
    in_order(&server, &["n_useOuter1", "m_useInner1", "x_useInner1"]);
    in_order(&client, &["n_useOuter1", "m_useInner1", "x_useInner1"]);
}

#[test]
fn a_state_seeded_from_a_hook_argument_paints_it() {
    let (html, _, client) = page("SeedPage.tsx");
    assert!(html.contains(">1</button>"), "{html}");
    in_order(&client, &["start_useBoth1", "ret1_useState"]);
}

#[test]
fn order_decls_puts_reads_first_and_keeps_location_otherwise() {
    use brust_compiler::lower::common::order_decls;
    let d = |loc: u32, name: &str, reads: &[&str]| {
        (
            loc,
            name.to_string(),
            reads.iter().map(|r| r.to_string()).collect::<Vec<_>>(),
            name.to_string(),
        )
    };
    // b (loc 1) reads a (loc 9), so it waits for a; every other declaration goes in location order as soon as what it
    // reads is out (d reads a name no declaration has).
    let got = order_decls(vec![
        d(5, "c", &[]),
        d(1, "b", &["a"]),
        d(9, "a", &[]),
        d(7, "e", &["c"]),
        d(3, "d", &["outside"]),
    ]);
    assert_eq!(got, ["d", "c", "e", "a", "b"]);
    // A cycle (no JS engine runs one) does not loop: location order.
    let got = order_decls(vec![d(2, "y", &["x"]), d(1, "x", &["y"])]);
    assert_eq!(got, ["x", "y"]);
}
