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
    env.add_filter("json_attr", json_attr);
    env.add_template_owned(name.to_string(), jinja_src)
        .unwrap_or_else(|e| panic!("add_template {name}: {e}"));
    let tmpl = env
        .get_template(name)
        .unwrap_or_else(|e| panic!("get_template {name}: {e}"));
    tmpl.render(ctx)
        .unwrap_or_else(|e| panic!("render {name}: {e}"))
}

// must match crates/brust/src/jinja.rs json_attr
fn json_attr(value: minijinja::Value) -> Result<String, minijinja::Error> {
    let json = serde_json::to_string(&value).map_err(|e| {
        minijinja::Error::new(
            minijinja::ErrorKind::InvalidOperation,
            "x-props JSON serialization failed",
        )
        .with_source(e)
    })?;
    Ok(json
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;"))
}

/// Compare `actual` against the committed `<name>.expected.html`, or rewrite it
/// when `UPDATE_GOLDEN` is set. Centralized so every render test regenerates
/// consistently after an intentional emit change (e.g. the `| e` escaping pass).
fn check_golden(name: &str, actual: &str) {
    let path = format!("fixtures/{name}.expected.html");
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).expect(&path);
    assert_eq!(actual, expected);
}

#[test]
fn renders_static_hello_byte_equal() {
    let actual = render_fixture("static_hello", context! {});
    check_golden("static_hello", &actual);
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
    check_golden("props_hello", &actual);
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
    check_golden("list_nav", &actual);
}

#[test]
fn renders_island_csr_byte_equal() {
    let actual = render_fixture(
        "island_csr",
        context! {
            island_0_props => "{&quot;n&quot;:1}",
        },
    );
    check_golden("island_csr", &actual);
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
    check_golden("island_ssr", &actual);
}

#[test]
fn renders_fragment_basic_byte_equal() {
    let actual = render_fixture("fragment_basic", context! {});
    check_golden("fragment_basic", &actual);
}

#[test]
fn renders_brust_page_byte_equal() {
    // `<BrustPage>` document shell: the framework auto tags (charset, viewport,
    // app.css link) must precede the user's <head>-slot <title>, and both
    // islands must thread their per-instance context keys.
    let actual = render_fixture(
        "brust_page",
        context! {
            island_0_props => "{&quot;n&quot;:0}",
            island_1_props => "{&quot;n&quot;:100}",
            island_1_html => "<button>100</button>",
        },
    );
    check_golden("brust_page", &actual);
}

#[test]
fn renders_xprops_tojson_byte_equal() {
    let actual = render_fixture(
        "xprops_tojson",
        context! { items => vec![context!{ id => 1, label => "a" }, context!{ id => 2, label => "b" }] },
    );
    check_golden("xprops_tojson", &actual);
}

#[test]
fn renders_brust_page_dynamic_byte_equal() {
    // `<BrustPage>` with member-path head props (S8): `title`/`description`/`lang`
    // thread a nested `d` loader object into the head as `{{ (d.*) | e }}`,
    // HTML-escaped at runtime (AutoEscape::None, so the `| e` filter does it).
    let actual = render_fixture(
        "brust_page_dynamic",
        context! {
            d => context! {
                title => "Charizard · PokéDex",
                desc => "The Flame Pokémon",
                lang => "en",
            },
        },
    );
    check_golden("brust_page_dynamic", &actual);
}
