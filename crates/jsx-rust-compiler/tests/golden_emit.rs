use jsx_rust_compiler::compile;
use pretty_assertions::assert_eq;

const FIXTURES: &[&str] = &["static_hello", "props_hello", "list_nav"];

#[test]
fn golden_emit_for_all_fixtures() {
    for name in FIXTURES {
        let input_path = format!("fixtures/{name}.tsx");
        let expected_path = format!("fixtures/{name}.expected.rs");

        let input = std::fs::read_to_string(&input_path).expect(&input_path);
        let actual = compile(&input).unwrap_or_else(|e| panic!("compile failed for {name}: {e}"));

        if std::env::var("UPDATE_GOLDEN").is_ok() {
            std::fs::write(&expected_path, &actual).unwrap();
            continue;
        }

        let expected = std::fs::read_to_string(&expected_path).expect(&expected_path);
        assert_eq!(actual.trim_end(), expected.trim_end(), "fixture: {name}");
    }
}
