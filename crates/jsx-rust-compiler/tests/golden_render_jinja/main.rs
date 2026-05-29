//! Golden test: for each fixture, compile to jinja, render via minijinja with a
//! hardcoded context, then compare byte-equal against the committed
//! `.expected.html` file.

use jsx_rust_compiler::compile;
use minijinja::{Environment, UndefinedBehavior, context};
use pretty_assertions::assert_eq;

fn render_fixture(name: &str, ctx: minijinja::Value) -> String {
    let input_path = format!("fixtures/{name}.tsx");
    let input = std::fs::read_to_string(&input_path).expect(&input_path);
    let jinja_src = compile(&input).unwrap_or_else(|e| panic!("compile failed for {name}: {e}"));

    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    env.add_template_owned(name.to_string(), jinja_src)
        .unwrap_or_else(|e| panic!("add_template {name}: {e}"));
    let tmpl = env
        .get_template(name)
        .unwrap_or_else(|e| panic!("get_template {name}: {e}"));
    tmpl.render(ctx)
        .unwrap_or_else(|e| panic!("render {name}: {e}"))
}

#[test]
fn renders_static_hello_byte_equal() {
    let actual = render_fixture("static_hello", context! {});
    let expected = std::fs::read_to_string("fixtures/static_hello.expected.html")
        .expect("fixtures/static_hello.expected.html");
    assert_eq!(actual, expected);
}

#[test]
fn renders_props_hello_byte_equal() {
    let actual = render_fixture(
        "props_hello",
        context! {
            name => "World",
            count => 7,
        },
    );
    let expected = std::fs::read_to_string("fixtures/props_hello.expected.html")
        .expect("fixtures/props_hello.expected.html");
    assert_eq!(actual, expected);
}

#[test]
fn renders_list_nav_byte_equal() {
    let actual = render_fixture(
        "list_nav",
        context! {
            items => vec![
                context! { href => "/a", label => "Alpha" },
                context! { href => "/b", label => "Bravo" },
            ],
        },
    );
    let expected = std::fs::read_to_string("fixtures/list_nav.expected.html")
        .expect("fixtures/list_nav.expected.html");
    assert_eq!(actual, expected);
}

#[test]
fn renders_island_csr_byte_equal() {
    let actual = render_fixture(
        "island_csr",
        context! {
            island_0_props => "{&quot;n&quot;:1}",
        },
    );
    let expected = std::fs::read_to_string("fixtures/island_csr.expected.html")
        .expect("fixtures/island_csr.expected.html");
    assert_eq!(actual, expected);
}

#[test]
fn renders_island_ssr_byte_equal() {
    let actual = render_fixture(
        "island_ssr",
        context! {
            island_0_props => "{&quot;n&quot;:1}",
            island_0_html => "<button>1</button>",
        },
    );
    let expected = std::fs::read_to_string("fixtures/island_ssr.expected.html")
        .expect("fixtures/island_ssr.expected.html");
    assert_eq!(actual, expected);
}
