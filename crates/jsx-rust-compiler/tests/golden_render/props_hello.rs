#[path = "../../fixtures/props_hello.expected.rs"]
#[rustfmt::skip]
mod fixture;

use pretty_assertions::assert_eq;

#[test]
fn renders_expected_html() {
    let props = fixture::Props {
        title: "Hi".to_string(),
        body: "Body <hi> & co".to_string(),
    };
    let actual = fixture::render(&props).into_string();
    let expected = include_str!("../../fixtures/props_hello.expected.html");
    assert_eq!(actual, expected.trim_end_matches('\n'));
}
