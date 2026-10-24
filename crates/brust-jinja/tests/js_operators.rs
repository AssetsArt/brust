//! F428: the JS-operator filters equal JS over a generated grid (`gen-js-operators.ts`).
mod table {
    include!("js_operators_table.rs");
}

#[test]
fn js_operator_filters_equal_javascript() {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let mut bad = Vec::new();
    for (expr, want) in table::TABLE {
        let got = env
            .render_str(
                &format!("{{{{ ({expr}) | js_string }}}}"),
                minijinja::Value::from(()),
            )
            .unwrap_or_else(|e| format!("ERR {e}"));
        if &got != want {
            bad.push(format!("{expr}: got {got}, JS {want}"));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} differ:\n{}",
        bad.len(),
        table::TABLE.len(),
        bad.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
}
