//! Golden test: for each fixture, compare the compiled jinja source byte-equal
//! against the committed `.expected.jinja` file.
//!
//! Use `UPDATE_GOLDEN=1` env to regenerate goldens after intentional emit
//! changes (kept compatible with the pre-J workflow).

use jsx_rust_compiler::compile;
use pretty_assertions::assert_eq;

const FIXTURES: &[&str] = &[
    "static_hello",
    "props_hello",
    "list_nav",
    "brust_page",
    "brust_page_dynamic",
    "fragment_basic",
    "cond_native",
    "style_object",
    "xfor_ssr",
    "xfor_client_only",
    "map_xfor_sugar",
    "map_no_xfor",
    "xprops_tojson",
    "map_xprops_same_source",
];

#[test]
fn golden_emit_jinja_for_all_fixtures() {
    for name in FIXTURES {
        let input_path = format!("fixtures/{name}.tsx");
        let expected_path = format!("fixtures/{name}.expected.jinja");

        let input = std::fs::read_to_string(&input_path).expect(&input_path);
        let actual = compile(&input).unwrap_or_else(|e| panic!("compile failed for {name}: {e}"));

        if std::env::var("UPDATE_GOLDEN").is_ok() {
            std::fs::write(&expected_path, &actual).unwrap();
            continue;
        }

        let expected = std::fs::read_to_string(&expected_path).expect(&expected_path);
        assert_eq!(actual, expected, "fixture: {name}");
    }
}
