//! F523 C0 pre-flight: a self-calling macro renders in the brust environment, and how deep minijinja 3.0 lets it go
//! before its own `recursion limit exceeded` when the self-call sits under 0..3 nested `{% for %}` (memo M1 §1: about
//! 6 depth units per level plus one per open loop, out of 500). The recursive-component cap (C5) is chosen from these.
use minijinja::Environment;

fn env() -> Environment<'static> {
    let mut env = Environment::new();
    brust_jinja::register(&mut env);
    env
}

/// The template of a macro that calls itself `n` times, each call under `loops` nested one-item lists.
fn nested(loops: usize, n: usize) -> String {
    let open: String = (0..loops)
        .map(|i| format!("{{% for a{i} in [1] %}}"))
        .collect();
    let close = "{% endfor %}".repeat(loops);
    format!(
        "{{% macro f(n) %}}{{% if n > 0 %}}{open}{{{{ f(n - 1) }}}}{close}{{% endif %}}x{{% endmacro %}}{{{{ f({n}) }}}}"
    )
}

/// The deepest `n` that still renders.
fn max_depth(loops: usize) -> usize {
    let env = env();
    let ok = |n: usize| env.render_str(&nested(loops, n), ()).is_ok();
    let (mut lo, mut hi) = (0usize, 1000usize);
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if ok(mid) { lo = mid } else { hi = mid - 1 }
    }
    lo
}

#[test]
fn a_self_calling_macro_renders() {
    let out = env()
        .render_str(
            "{% macro f(n) %}{% if n %}{{ f(n - 1) }}{% endif %}<{{ n }}>{% endmacro %}{{ f(3) }}",
            (),
        )
        .unwrap();
    assert_eq!(out, "<0><1><2><3>");
}

#[test]
fn past_the_engine_limit_the_error_is_minijinjas_own() {
    let e = env().render_str(&nested(0, 10_000), ()).unwrap_err();
    assert!(e.to_string().contains("recursion limit exceeded"), "{e}");
}

/// C5: the cap (32 levels) keeps a 1.5x margin under the engine's own limit with three nested lists.
#[test]
fn the_engine_limit_leaves_room_for_32_levels_under_three_nested_lists() {
    let depths: Vec<usize> = (0..4).map(max_depth).collect();
    eprintln!("max self-call depth for 0..3 nested lists: {depths:?}");
    assert!(depths.windows(2).all(|w| w[0] >= w[1]), "{depths:?}");
    assert!(depths[3] >= 48, "three nested lists: {depths:?}");
}

/// C5: past the cap the render fails through `recursion_limit`, naming the component and the cap.
#[test]
fn recursion_limit_names_the_component_and_the_cap() {
    let t = "{% macro f(n, d) %}{% if d > 3 %}{{ recursion_limit('NodeView', 3) }}{% endif %}{% if n %}{{ f(n - 1, d + 1) }}{% endif %}.{% endmacro %}{{ f(10, 0) }}";
    let e = env().render_str(t, ()).unwrap_err();
    assert!(
        e.to_string()
            .contains("<NodeView> nested more than 3 levels"),
        "{e}"
    );
    assert_eq!(
        env()
            .render_str(&t.replace("f(10, 0)", "f(2, 0)"), ())
            .unwrap(),
        "..."
    );
}
